import { gte, sql } from 'drizzle-orm';
import { sendViaSmtp } from '../adapters/smtp';
import { createDb } from '../db/client';
import { emailLogs } from '../db/schema';
import { getConfig, getConfigBool, getConfigInt } from './config';

export interface EmailResult {
  success: boolean;
  error?: string;
  /** 服务商 / SMTP 的原文回执，见 sendViaSmtp 的注释：250 只代表中继收下了 */
  detail?: string;
}

interface SendInput {
  to: string;
  /** 抄送一份（后台用来核对「用户收到的那封长什么样」） */
  cc?: string[];
  subject: string;
  html: string;
  from?: string;
  kind?: EmailJob['kind'];
  postId?: string;
}

/* ------------------------------------------------------------------
 * 邮件：四封信（验证码 / 订阅确认 / 新评论提醒 / 其它通知）的正文从 site_config 读，
 * 管理员在后台改文案不用发版；外壳（站点名、Logo、称呼、落款）在 email-templates.ts。
 * 这一层只管发送通道（SMTP / Resend / Cloudflare Email）与入队，不碰模板内容。
 * ----------------------------------------------------------------*/

/* 四封邮件的正文模板：配置键、默认文本与占位符表在 email-defaults.ts，
   外壳与 renderEmail() 在 email-templates.ts；这里只把名字转出去，给路由与调用方一个入口。 */
export { DEFAULT_TEMPLATES, TEMPLATE_CONFIG_KEY, TEMPLATE_LABELS, TEMPLATE_VARS } from './email-defaults';
export type { TemplateKind } from './email-defaults';
export { renderEmail, shellVars, wrapEmailShell } from './email-templates';

/* ------------------------------------------------------------------
 * 每日发信额度
 *
 * 发信服务普遍按天限量（Resend 免费档就是 100 封/天、3000 封/月），
 * 而群发与订阅推送一跑就是「订阅者数 × 1 封」。100 个订阅者正好打满，
 * 同一天再有验证码、新评论提醒就先被服务商拒了 —— 所以要额度，
 * 不够就整批不发（留在队列里等明天的额度），而不是发到一半撞墙。
 * ----------------------------------------------------------------*/

/** 今日已经发出去多少封、还能发多少封；emailDailyLimit 设成 0 表示不限制 */
export async function emailBudget(env: Env): Promise<{ limit: number; used: number; left: number }> {
  const limit = await getConfigInt(env, 'emailDailyLimit', 100);
  if (limit <= 0) return { limit: 0, used: 0, left: Number.MAX_SAFE_INTEGER };
  const dayStart = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const rows = await createDb(env)
    .select({ n: sql<number>`count(*)` })
    .from(emailLogs)
    .where(gte(emailLogs.createdAt, dayStart));
  const used = Number(rows[0]?.n ?? 0);
  return { limit, used, left: Math.max(0, limit - used) };
}

/** 够不够一次发 count 封；不够时给出人话原因 */
export async function mailQuotaCheck(env: Env, count: number): Promise<{ ok: boolean; reason: string }> {
  const b = await emailBudget(env);
  if (b.limit === 0) return { ok: true, reason: `不限量（今日已发 ${b.used} 封）` };
  if (b.left >= count) return { ok: true, reason: `额度内（剩 ${b.left}/${b.limit} 封，本次要发 ${count} 封）` };
  return {
    ok: false,
    reason: `今日剩余额度 ${b.left} 封，本次要发 ${count} 封，超出 emailDailyLimit（${b.limit} 封/天）。整批未发送，明天额度刷新后会自动重跑，也可以在设置里提高上限或分批发。`,
  };
}

/** 同步直发：登录验证码等即时性强的邮件走这条路径，用户能立刻看到失败原因 */
export async function sendEmail(env: Env, input: SendInput): Promise<EmailResult> {
  const provider = ((await getConfig(env, 'emailProvider')) ?? 'smtp') as EmailProvider;

  if (provider === 'resend') return sendViaResend(env, input);
  if (provider === 'cloudflare') return sendViaCloudflare(env, input);
  return sendBySmtp(env, input);
}

/**
 * 入队发送：新文章群发这类量大、慢的任务。
 * 队列消费者带 3 次重试，比在请求里循环发信安全得多。
 */
export async function queueEmail(env: Env, input: SendInput): Promise<EmailResult> {
  if (!env.EMAIL_QUEUE) return sendEmail(env, input);
  const job: EmailJob = { ...input, from: input.from };
  try {
    await env.EMAIL_QUEUE.send(job);
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function sendBySmtp(env: Env, input: SendInput): Promise<EmailResult> {
  const host = await getConfig(env, 'smtpHost');
  const user = await getConfig(env, 'smtpUser');
  /* 密码两个来源：后台「发信方式」里填的（存 D1，读取只回「已设置」）优先，
     其次是 wrangler secret SMTP_PASSWORD —— 老部署不用改任何东西。 */
  const password = (await getConfig(env, 'smtpPassword')) || env.SMTP_PASSWORD || '';
  const from = input.from ?? (await getConfig(env, 'emailFrom'));
  const fromName = await getConfig(env, 'emailFromName');
  const port = Number((await getConfig(env, 'smtpPort')) ?? 587);
  // smtpSecure = true 表示 465 隐式 TLS；587/2525 走 STARTTLS
  const implicitTls = (await getConfigBool(env, 'smtpSecure', false)) && port === 465;

  if (!host || !user || !password || !from) {
    const missing = [!host && 'SMTP 服务器', !user && 'SMTP 用户名', !password && 'SMTP 密码 / 授权码', !from && '发件人地址']
      .filter(Boolean)
      .join('、');
    return { success: false, error: `邮件未配置完整，缺少：${missing}` };
  }

  return sendViaSmtp({
    host,
    port,
    implicitTls,
    user,
    password,
    from,
    fromName: fromName ?? undefined,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    html: input.html,
    replyTo: from ?? undefined,
  });
}

async function sendViaResend(env: Env, input: SendInput): Promise<EmailResult> {
  const key = env.RESEND_API_KEY ?? (await getConfig(env, 'resendApiKey'));
  const from = input.from ?? (await getConfig(env, 'emailFrom'));
  const fromName = await getConfig(env, 'emailFromName');
  if (!key) return { success: false, error: '未配置 RESEND_API_KEY' };
  if (!from) return { success: false, error: '未配置发件人地址' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromName ? `${fromName} <${from}>` : from,
        to: [input.to],
        ...(input.cc?.length ? { cc: input.cc } : {}),
        subject: input.subject,
        html: input.html,
      }),
    });
    const text = await res.text();
    if (!res.ok) return { success: false, error: `Resend ${res.status}: ${text}`, detail: text };
    return { success: true, detail: text };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Cloudflare 原生 Email Sending：REST 接口，避免为一个发信通道绑 SDK */
async function sendViaCloudflare(env: Env, input: SendInput): Promise<EmailResult> {
  const accountId = env.CF_ACCOUNT_ID ?? (await getConfig(env, 'cloudflareAccountId'));
  const token = env.CF_EMAIL_API_TOKEN ?? (await getConfig(env, 'cloudflareEmailToken'));
  const from = input.from ?? (await getConfig(env, 'emailFrom'));
  if (!accountId || !token || !from) return { success: false, error: 'Cloudflare Email Sending 未配置完整' };

  const boundary = '----=_ZeroMailBoundary';
  /* 这个接口只认 to 字段（可重复），所以抄送按多一个 to 投出去 */
  const mime = [
    '--' + boundary,
    'Content-Disposition: form-data; name="from"',
    '',
    from,
    ...[input.to, ...(input.cc ?? [])].flatMap((one) => [
      '--' + boundary,
      'Content-Disposition: form-data; name="to"',
      '',
      one,
    ]),
    '--' + boundary,
    'Content-Disposition: form-data; name="subject"',
    '',
    input.subject,
    '--' + boundary,
    'Content-Disposition: form-data; name="html"',
    '',
    input.html,
    '--' + boundary + '--',
    '',
  ].join('\r\n');

  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: mime,
    });
    const text = await res.text();
    if (!res.ok) return { success: false, error: `Cloudflare Email ${res.status}: ${text}`, detail: text };
    return { success: true, detail: text };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
