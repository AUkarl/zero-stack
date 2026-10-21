import { eq, gte, sql } from 'drizzle-orm';
import { sendViaSmtp } from '../adapters/smtp';
import { createDb } from '../db/client';
import { emailLogs } from '../db/schema';
import { newId } from '../lib/crypto';
import { getConfig, getConfigInt } from './config';

export interface EmailResult {
  success: boolean;
  error?: string;
  /** 服务商 / SMTP 的原文回执，见 sendViaSmtp 的注释：250 只代表中继收下了 */
  detail?: string;
  /** 这一封在 email_logs 里的行号，后台与服务商日志对账就用它 */
  logId?: string;
  /** 只是排进了队列、还没真投出去：回执不能说成「已发送」 */
  queued?: boolean;
}

interface SendInput {
  to: string;
  subject: string;
  html: string;
  from?: string;
  kind?: EmailJob['kind'];
  postId?: string;
  /** 队列消费者带入队时那一行的 id 回来更新，不再新插一行 */
  logId?: string;
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

/**
 * 发一封邮件，并在 email_logs 里留一行。
 *
 * 记账放在这层而不是队列消费者里，是因为「库里没记录」和「通知根本没触发」以前完全分不开：
 * 消费者没跑起来（队列被停、批处理抛异常、Worker 被杀）时一行都不留，站主只能干瞪眼。
 * 现在入队之前就写 queued，发送后回写 sent / failed + 服务器原文回执。
 * input.logId 带上已有那行（队列消费）时不再新建，就地更新。
 */
export async function sendEmail(env: Env, input: SendInput): Promise<EmailResult> {
  const logId = await openEmailLog(env, input);
  const result = humanize(await deliverEmail(env, input));
  /* 成不成功都要给 /api/auth/send-code 留一个「最近通道在不在坏」的说法（见下面三个函数）：
     那接口在邮箱没注册时是不发信的，只有靠这里记的标记，才能让两条分支回同一句。 */
  if (result.success) await clearMailFailing(env);
  else await markMailFailing(env, result.error ?? '未知原因');
  await closeEmailLog(env, logId, result);
  return logId ? { ...result, logId } : result;
}

/* ------------------------------------------------------------------ 「通道最近在坏」标记（KV，15 分钟） */

const MAIL_FAILING_KEY = 'mail:failing';
/** 记 15 分钟：够长到让外人从「502 / 200」的差异里问不出什么，又够短到通道恢复后不会把站锁住 */
const MAIL_FAILING_TTL = 900;

/**
 * 为什么要有这个标记：/api/auth/send-code 对「没注册的邮箱」是**不发信**的（码不落库，回 200 装成已发出），
 * 目的是不给外人一份能批量验证的邮箱名单。可通道真在坏的时候，已注册那条会回 502 ——
 * 一个 502、一个 200，区别本身又把名单还回去了。这个标记让未注册那条也知道「现在发不出去」，两条回同一句。
 *
 * 只在失败时写一次、成功时顺带清（读 KV 不要钱，删除只在确实有过失败时才发生 ——
 * KV 免费额度是每天 1000 次写，每封都清那点额度经不起）。
 */
async function markMailFailing(env: Env, reason: string): Promise<void> {
  if (!env.SESSION) return;
  try {
    await env.SESSION.put(MAIL_FAILING_KEY, JSON.stringify({ at: Date.now(), reason: String(reason).slice(0, 300) }), {
      expirationTtl: MAIL_FAILING_TTL,
    });
  } catch (err) {
    console.warn('[mail] 写失败标记没写进去', err);
  }
}

/** 这条不抛错：读不到就当作「最近没失败过」，宁可放行也别把人挡在门外 */
export async function mailFailingRecently(env: Env): Promise<boolean> {
  if (!env.SESSION) return false;
  try {
    return (await env.SESSION.get(MAIL_FAILING_KEY, { type: 'text' })) !== null;
  } catch {
    return false;
  }
}

async function clearMailFailing(env: Env): Promise<void> {
  if (!env.SESSION) return;
  try {
    if ((await env.SESSION.get(MAIL_FAILING_KEY, { type: 'text' })) === null) return; // 没失败过就别白花一次写
    await env.SESSION.delete(MAIL_FAILING_KEY);
  } catch (err) {
    console.warn('[mail] 清失败标记没清掉', err);
  }
}

/**
 * 通道报错加工：SMTP 与 workerd 抛上来的那串英文（Stream was cancelled / 535 …）
 * 站主看不懂也没法照着办事。这里保留原文（与服务商对账要用），在后面补一句人话。
 */
const MAIL_HINTS: [RegExp, string][] = [
  [/stream was cancelled|socket hang up|ECONNRESET|ECONNABORTED/i, '连接被中途断开：多数是端口与加密方式不匹配（465 只能隐式 TLS，587/25 走 STARTTLS），也可能是对方按 IP 直接掐线'],
  [/network connection lost/i, '连接被运行时中断：多出现在 STARTTLS 握手没谈成（端口与「隐式 TLS」开关不一致、对方不接受这个端口，或证书没被信任）。先用本页「测试发信」复现，再按服务商文档核端口：465 要勾上隐式 TLS，587/2525/25 不勾'],
  [/timeout|timed out|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED/i, '连不上邮件服务器：核对 smtpHost 与端口，注意 Workers 的出口 IP 不在对方白名单里也会被丢'],
  [/\b53[0-9]\b|authentication failed|invalid (?:login|credentials|user)|Username and Password/i, 'SMTP 登录被拒：用户名与密码/授权码不对（QQ、163、阿里云这类要填「授权码」，不是邮箱登录密码）'],
  [/handshake|certificate|SSL|TLS library|alert/i, 'TLS 握手失败：证书不受信任，或这个端口要的握手方式与设置不一致'],
  [/\b5\d\d\b|message rejected|sender (?:not|denied)|spam|quota|too many/i, '中继拒收了这封信：常见原因是发信域名没做 SPF/DKIM、收件人被拦，或超出了每日额度'],
];

function humanize(result: EmailResult): EmailResult {
  if (result.success || !result.error) return result;
  const hint = MAIL_HINTS.find(([re]) => re.test(result.error as string));
  return hint ? { ...result, error: `${result.error}（${hint[1]}）` } : result;
}

/** 按 emailProvider 分流到具体通道，不记账 */
async function deliverEmail(env: Env, input: SendInput): Promise<EmailResult> {
  const provider = ((await getConfig(env, 'emailProvider')) ?? 'smtp') as EmailProvider;

  if (provider === 'resend') return sendViaResend(env, input);
  if (provider === 'cloudflare') return sendViaCloudflare(env, input);
  return sendBySmtp(env, input);
}

/** 有 logId 就直接用（消费者更新入队时那一行），否则新建一行 queued */
async function openEmailLog(env: Env, input: SendInput): Promise<string | null> {
  if (input.logId) return input.logId;
  try {
    const id = newId();
    await createDb(env)
      .insert(emailLogs)
      .values({
        id,
        to: input.to,
        subject: input.subject,
        status: 'queued',
        postId: input.postId ?? null,
        createdAt: Math.floor(Date.now() / 1000),
      });
    return id;
  } catch (e) {
    // 记不了账不能拦住发信：宁可少一行日志，也别把验证码/通知一起弄丢
    console.warn('[zero-api] 写 email_logs 失败', e);
    return null;
  }
}

async function closeEmailLog(env: Env, id: string | null, result: EmailResult): Promise<void> {
  if (!id) return;
  try {
    const now = Math.floor(Date.now() / 1000);
    await createDb(env)
      .update(emailLogs)
      .set(
        result.success
          ? { status: 'sent', sentAt: now, error: null, detail: result.detail ?? null }
          : { status: 'failed', error: result.error ?? '未知原因', detail: result.detail ?? null },
      )
      .where(eq(emailLogs.id, id));
  } catch (e) {
    console.warn('[zero-api] 回写 email_logs 失败', e);
  }
}

/**
 * 入队发送：新文章群发这类量大、慢的任务。
 * 队列消费者带 3 次重试，比在请求里循环发信安全得多。
 */
export async function queueEmail(env: Env, input: SendInput): Promise<EmailResult> {
  if (!env.EMAIL_QUEUE) return sendEmail(env, input);
  const logId = await openEmailLog(env, input);
  const job: EmailJob = { ...input, from: input.from, logId: logId ?? undefined };
  try {
    await env.EMAIL_QUEUE.send(job);
    return { success: true, queued: true, logId: logId ?? undefined, detail: '已进入发送队列，等待消费者投信' };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await closeEmailLog(env, logId, { success: false, error });
    return { success: false, error, logId: logId ?? undefined };
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
  /**
   * 握手方式按端口定：465 只有隐式 TLS（实测明文连过去收不到任何应答），所以 465 一律走 TLS，
   * 不再让「465 + smtpSecure 没勾」变成明文连过去白等 30 秒。
   * smtpSecure 留着当显式覆盖：非 465 端口勾上它，表示那个端口也只收隐式 TLS（自建服务常见）。
   */
  const secureRaw = await getConfig(env, 'smtpSecure');
  const implicitTls = port === 465 || secureRaw === 'true' || secureRaw === '1';

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
  const mime = [
    '--' + boundary,
    'Content-Disposition: form-data; name="from"',
    '',
    from,
    '--' + boundary,
    'Content-Disposition: form-data; name="to"',
    '',
    input.to,
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
