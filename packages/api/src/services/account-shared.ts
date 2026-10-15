/**
 * account-shared.ts — 账号安全与个人中心的公共件
 *
 * 这里的东西被四处调用（routes/auth.ts、routes/security.ts、routes/account.ts、
 * routes/users.ts），单独放一个模块免得路由之间互相 import 形成环：
 *   · 登录策略：把后台的 adminLoginPolicy 翻译成「这个账号这次登录要交哪几样凭据」
 *   · GitHub OAuth：配置检查、authorize URL、state 暂存
 *   · 邮箱验证码：发送与校验（发送走 services/email.ts 的模板函数）
 *   · account_slug：邮箱前缀生成 + 冲突加三位随机数
 *   · 待启用的 TOTP 密钥：只暂存在 KV，不进库
 *   · resolveAccountTarget：/api/account 按 account_slug 或本人 id 定位
 */

import { and, eq, gt, or } from 'drizzle-orm';
import type { Context } from 'hono';
import { createDb } from '../db/client';
import { accounts, users, verifications } from '../db/schema';
import { randomOtp } from './auth';
import { getConfig } from './config';
import * as mailer from './email';
import { openSecret, verifyTotp } from './totp';
import { fail } from '../lib/errors';
import type { Ctx } from '../middleware/auth';

export type UserRow = typeof users.$inferSelect;
export type LoginPolicy = 'password' | 'password+totp' | 'github' | 'password+email-code';

/** 全站只有这四种管理员登录方式；库里存的其它值（含早先的 'totp' 仅动态码）一律退回 password */
export const LOGIN_POLICIES: LoginPolicy[] = ['password', 'password+totp', 'github', 'password+email-code'];

const EMAIL_OTP_TTL = 600;
const PENDING_TOTP_TTL = 900;
const OAUTH_STATE_TTL = 600;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/* ------------------------------------------------------------------ 邮箱验证码 */

/**
 * 验证码邮件：正文取后台「邮件模板 → 验证码」，套上统一的站点外壳。
 * 后台留空时用 email-defaults 里的默认文本，不会出现裸文字白底那种旧样子。
 */
async function codeEmailHtml(env: Env, code: string, minutes: number, nickname?: string): Promise<string> {
  return mailer.renderEmail(env, 'code', { code, minutes: String(minutes) }, { nickname });
}

/** 发送邮箱验证码：注册确认 / 登录二因子 / 改密二次凭据共用一条通道 */
export async function sendEmailOtp(
  env: Env,
  email: string,
  userId: string | null,
  opts: { nickname?: string } = {},
): Promise<{ sent: boolean }> {
  const code = randomOtp();
  const db = createDb(env);
  await db.delete(verifications).where(eq(verifications.identifier, `otp:${email}`));
  await db.insert(verifications).values({
    identifier: `otp:${email}`,
    value: JSON.stringify({ code, userId, attempts: 0 }),
    expiresAt: nowSec() + EMAIL_OTP_TTL,
    createdAt: nowSec(),
  });

  const siteName = (await getConfig(env, 'siteName')) ?? 'Zero';
  const sent = await mailer.sendEmail(env, {
    to: email,
    subject: `【${siteName}】验证码 ${code}`,
    html: await codeEmailHtml(env, code, EMAIL_OTP_TTL / 60, opts.nickname),
    kind: 'notice',
  });
  if (!sent.success) console.warn(`[account] 验证码邮件发送失败 ${email}: ${sent.error ?? '未知原因'}`);
  return { sent: sent.success };
}

/**
 * 校验邮箱验证码。默认校验通过就作废（一次性），改密流程需要先验再在写库成功后作废。
 * 错误信息直接给人看， attempts 超限与过期分开提示。
 */
export async function verifyEmailOtp(
  env: Env,
  email: string,
  code: string,
  opts: { consume?: boolean } = {},
): Promise<{ ok: boolean; message?: string }> {
  const consume = opts.consume !== false;
  const db = createDb(env);
  const rows = await db
    .select()
    .from(verifications)
    .where(and(eq(verifications.identifier, `otp:${email}`), gt(verifications.expiresAt, nowSec())))
    .limit(1);
  const record = rows[0];
  if (!record) return { ok: false, message: '验证码已过期，请重新获取' };

  let data: { code: string; userId: string | null; attempts: number };
  try {
    data = JSON.parse(record.value) as typeof data;
  } catch {
    return { ok: false, message: '验证码已失效，请重新获取' };
  }
  if ((data.attempts ?? 0) >= 5) return { ok: false, message: '尝试次数过多，请重新获取验证码' };
  if (data.code !== String(code ?? '').trim()) {
    await db
      .update(verifications)
      .set({ value: JSON.stringify({ ...data, attempts: (data.attempts ?? 0) + 1 }) })
      .where(eq(verifications.identifier, `otp:${email}`));
    return { ok: false, message: '验证码不正确' };
  }
  if (consume) await db.delete(verifications).where(eq(verifications.identifier, `otp:${email}`));
  return { ok: true };
}

/** 邮件通道是否可用：不可用时前端不该把「邮箱验证码」列为可选凭据 */
export async function emailOtpAvailable(env: Env): Promise<boolean> {
  const provider = (await getConfig(env, 'emailProvider')) ?? 'smtp';
  if (provider === 'resend') return Boolean(env.RESEND_API_KEY || (await getConfig(env, 'resendApiKey')));
  if (provider === 'cloudflare') return Boolean(env.CF_EMAIL_API_TOKEN || (await getConfig(env, 'cloudflareEmailToken')));
  return Boolean(
    (env.SMTP_PASSWORD || (await getConfig(env, 'smtpPassword'))) &&
      (await getConfig(env, 'smtpHost')) &&
      (await getConfig(env, 'smtpUser')) &&
      (await getConfig(env, 'emailFrom')),
  );
}

/* ------------------------------------------------------------------ GitHub OAuth */

export interface GithubOAuthConfig {
  configured: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** 缺了哪些环境变量，直接拼进提示里，省得人去翻文档 */
  missing: string[];
}

export function githubOAuth(env: Env, requestOrigin = ''): GithubOAuthConfig {
  const clientId = (env.GITHUB_CLIENT_ID ?? '').trim();
  const clientSecret = (env.GITHUB_CLIENT_SECRET ?? '').trim();
  const configured = Boolean(clientId && clientSecret);
  const redirectUri =
    (env.GITHUB_REDIRECT_URI ?? '').trim() || (configured && requestOrigin ? `${requestOrigin.replace(/\/+$/, '')}/api/auth/github/callback` : '');
  const missing: string[] = [];
  if (!clientId) missing.push('GITHUB_CLIENT_ID');
  if (!clientSecret) missing.push('GITHUB_CLIENT_SECRET');
  return { configured, clientId, clientSecret, redirectUri, missing };
}

export function githubUnavailableMessage(oauth: GithubOAuthConfig): string {
  return `GitHub 登录尚未开通：服务端缺少环境变量 ${oauth.missing.join('、')}（在 wrangler 的 vars/secret 里补齐后重试）。`;
}

export function githubAuthorizeUrl(oauth: GithubOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: oauth.clientId,
    redirect_uri: oauth.redirectUri,
    scope: 'read:user user:email',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export interface GithubIdentity {
  providerAccountId: string;
  login: string;
  avatar: string;
  email: string | null;
  accessToken: string;
}

/**
 * 用 code 换 token，再取一次 /user。
 * 失败不抛 HTTPException，而是回 { error } —— 回调是浏览器跳转，错误得拼进 ?ghError= 给人看。
 */
export async function githubExchange(
  env: Env,
  oauth: GithubOAuthConfig,
  code: string,
): Promise<{ identity: GithubIdentity } | { error: string }> {
  let token = '';
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
        code,
        redirect_uri: oauth.redirectUri,
      }),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: string; error_description?: string } | null;
    token = body?.access_token ?? '';
    if (!res.ok || !token) {
      return { error: body?.error_description ? `GitHub 拒绝了授权：${body.error_description}` : 'GitHub 授权失败，请重新发起登录' };
    }
  } catch (err) {
    return { error: `无法连接 GitHub 授权接口：${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const user = await fetch('https://api.github.com/user', {
      // GitHub 缺 User-Agent 就回 403；Workers 的 fetch 默认不带，必须自己加
      headers: { 'User-Agent': 'zero-cms (cloudflare-workers)', Authorization: `Bearer ${token.trim()}`, Accept: 'application/vnd.github+json' },
    });
    if (!user.ok) return { error: `读取 GitHub 账号信息失败（HTTP ${user.status}）` };
    const profile = (await user.json().catch(() => null)) as { id?: number; login?: string; avatar_url?: string; email?: string | null } | null;
    if (!profile?.id) return { error: 'GitHub 返回的账号信息不完整' };
    return {
      identity: {
        providerAccountId: String(profile.id),
        login: profile.login ?? String(profile.id),
        avatar: profile.avatar_url ?? '',
        email: profile.email ?? null,
        accessToken: token,
      },
    };
  } catch (err) {
    return { error: `无法连接 GitHub 接口：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 已经绑定的 GitHub 账号（access_token 留在库里，改密时可拿它做一次「持有证明」校验） */
export async function githubAccountOf(env: Env, userId: string): Promise<typeof accounts.$inferSelect | null> {
  const db = createDb(env);
  const rows = await db.select().from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.provider, 'github'))).limit(1);
  return rows[0] ?? null;
}

export async function githubProofValid(env: Env, row: typeof accounts.$inferSelect): Promise<boolean> {
  if (!row?.accessToken) return false;
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { 'User-Agent': 'zero-cms (cloudflare-workers)', Authorization: `Bearer ${row.accessToken.trim()}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { id?: number } | null;
    return Boolean(body?.id && String(body.id) === (row.providerAccountId ?? ''));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ KV 暂存：OAuth state 与待启用 TOTP */

async function kvPut(env: Env, key: string, value: string, ttl: number): Promise<void> {
  if (!env.SESSION) return;
  try {
    await env.SESSION.put(key, value, { expirationTtl: ttl });
  } catch (err) {
    console.warn('[account] KV 写入失败', key, err);
  }
}

async function kvGet(env: Env, key: string): Promise<string | null> {
  if (!env.SESSION) return null;
  try {
    return await env.SESSION.get(key, { type: 'text' });
  } catch {
    return null;
  }
}

async function kvDelete(env: Env, key: string): Promise<void> {
  if (!env.SESSION) return;
  await env.SESSION.delete(key).catch(() => undefined);
}

export async function stashPendingSecret(env: Env, userId: string, secret: string): Promise<void> {
  await kvPut(env, `totp:pending:${userId}`, secret, PENDING_TOTP_TTL);
}

export async function readPendingSecret(env: Env, userId: string): Promise<string | null> {
  return kvGet(env, `totp:pending:${userId}`);
}

export async function clearPendingSecret(env: Env, userId: string): Promise<void> {
  await kvDelete(env, `totp:pending:${userId}`);
}

export interface OAuthState {
  intent: 'login' | 'bind';
  userId?: string;
  redirect?: string;
}

export async function stashOAuthState(env: Env, state: string, data: OAuthState): Promise<void> {
  await kvPut(env, `gh:state:${state}`, JSON.stringify(data), OAUTH_STATE_TTL);
}

export async function takeOAuthState(env: Env, state: string): Promise<OAuthState | null> {
  const raw = await kvGet(env, `gh:state:${state}`);
  if (!raw) return null;
  await kvDelete(env, `gh:state:${state}`);
  try {
    return JSON.parse(raw) as OAuthState;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ account_slug */

/** 邮箱前缀 → 可用 slug：小写字母数字与短横线，中文之类提不出来时退回 mail + 随机后缀 */
export function slugFromEmail(email: string): string {
  const prefix = String(email ?? '').split('@')[0] ?? '';
  const base = prefix
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'reader';
}

function randomSuffix(): string {
  return String(crypto.getRandomValues(new Uint8Array(2))[0]! % 1000).padStart(3, '0');
}

/** 唯一性检查 + 冲突时追加三位随机数（最多试 8 次，还撞就再加一位） */
export async function uniqueAccountSlug(env: Env, wanted: string, excludeId?: string): Promise<string> {
  const db = createDb(env);
  const clean = String(wanted ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!clean) fail(400, '账号标识只能用英文字母、数字、短横线');

  const taken = async (slug: string): Promise<boolean> => {
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.accountSlug, slug)).limit(1);
    return Boolean(rows[0] && rows[0].id !== excludeId);
  };

  if (!(await taken(clean))) return clean;
  for (let i = 0; i < 8; i++) {
    const candidate = `${clean}-${randomSuffix()}`;
    if (!(await taken(candidate))) return candidate;
  }
  return `${clean}-${Date.now().toString().slice(-6)}`;
}

/** 注册后分配；已经有值的账号不动 */
export async function assignAccountSlug(env: Env, userId: string, email: string): Promise<string> {
  const db = createDb(env);
  const rows = await db.select({ accountSlug: users.accountSlug }).from(users).where(eq(users.id, userId)).limit(1);
  const existing = rows[0]?.accountSlug;
  if (existing) return existing;
  const slug = await uniqueAccountSlug(env, slugFromEmail(email));
  await db.update(users).set({ accountSlug: slug }).where(eq(users.id, userId));
  return slug;
}

/* ------------------------------------------------------------------ 登录策略 */

export interface FactorPlan {
  /** 需要密码 */
  password: boolean;
  /** 需要邮箱验证码（第二因子） */
  emailCode: boolean;
  /** 需要身份验证器动态码 */
  totp: boolean;
  /** 只允许 GitHub 登录，密码路径关闭 */
  githubOnly: boolean;
  /** 策略与实际配置不符时的补救提示，会跟着响应一起回给前端 */
  notice: string | null;
}

/** 后台的 adminLoginPolicy，写错值一律退回 password，避免管理员被策略锁在门外 */
export async function loginPolicy(env: Env): Promise<LoginPolicy> {
  const raw = ((await getConfig(env, 'adminLoginPolicy')) ?? 'password') as string;
  return (LOGIN_POLICIES as string[]).includes(raw) ? (raw as LoginPolicy) : 'password';
}

/**
 * 这个账号本次登录要交哪几样凭据。两条线是完全分开的：
 *
 * 管理员只看后台的 adminLoginPolicy（「我的信息 → 管理员登录方式」），它是唯一权威：
 * 策略是「密码」时，就算这个账号绑过验证器也只要密码 —— 绑验证器只是绑定状态，
 * 不该反过来变成一道额外的门（这正是「没启用密码+身份验证却要动态码」的根因）。
 * 要动态码的只有 password+totp 一种（密码 + 码）：不提供「只要动态码、丢了验证器就进不去」的策略。
 *
 * 普通用户不跟这条策略走，永远是「邮箱 + 密码」。验证码在他们这边只用来验证邮箱
 * （注册、找回密码、绑定验证器），不作为登录因子 —— 前台登录表单里压根没有邮箱验证码那一步，
 * 以前跟着策略要邮箱码时，选了「密码 + 邮箱验证码」的站点会把所有普通用户锁在门外。
 * 唯一能自己加的一道是账号主人绑的身份验证器：绑上默认就要动态码，
 * 在用户中心把「登录时要两步验证」关掉才免（见 users.totpAtLogin）。
 *
 * 策略与实际配置不符时退回密码并附提示，是刻意的：把 adminLoginPolicy 设成
 * github 却没配 OAuth、设成 totp 却还没绑验证器，直接拒绝登录的结果是
 * 整站没人能进后台，宁可退回密码并在响应里催他配好。
 */
export async function planFactors(env: Env, user: UserRow): Promise<FactorPlan> {
  const totpReady = Boolean(user.totpEnabled);

  if (user.role !== 'admin') {
    // 读不到这一列时按默认（开启）对待：宁可多问一道码，也不把绑了验证器的账号降成只凭密码
    return { password: true, emailCode: false, totp: totpReady && user.totpAtLogin !== false, githubOnly: false, notice: null };
  }

  const policy = await loginPolicy(env);
  const emailCode = policy === 'password+email-code';

  if (policy === 'github') {
    if (githubOAuth(env).configured) return { password: false, emailCode: false, totp: false, githubOnly: true, notice: null };
    return {
      password: true,
      emailCode: false,
      totp: false,
      githubOnly: false,
      notice: githubUnavailableMessage(githubOAuth(env)) + '当前已临时退回密码登录。',
    };
  }

  if (policy === 'password+totp') {
    return {
      password: true,
      emailCode: false,
      totp: totpReady,
      githubOnly: false,
      notice: totpReady ? null : '登录策略要求身份验证器，本账号还没绑定；登录后请到「安全设置」绑定。',
    };
  }

  // password / password+email-code：管理员一律只要这两样，绑过的验证器不参与登录
  return { password: true, emailCode, totp: false, githubOnly: false, notice: null };
}

/** 前端渲染用的「可选登录 / 二次凭据方式」列表 */
export async function securityMethods(
  env: Env,
  user: UserRow,
): Promise<Array<{ kind: string; label: string; enabled: boolean; required: boolean; available: boolean }>> {
  const oauth = githubOAuth(env);
  const plan = await planFactors(env, user);
  const emailReady = await emailOtpAvailable(env);
  const githubLinked = Boolean(await githubAccountOf(env, user.id));
  return [
    { kind: 'password', label: '密码', enabled: plan.password, required: plan.password, available: Boolean(user.passwordHash) },
    { kind: 'email', label: '邮箱验证码', enabled: plan.emailCode, required: plan.emailCode, available: emailReady },
    { kind: 'totp', label: '身份验证器', enabled: user.totpEnabled, required: plan.totp, available: user.totpEnabled },
    { kind: 'github', label: 'GitHub', enabled: githubLinked, required: plan.githubOnly, available: oauth.configured },
  ];
}

/** 改密码时允许挑的二次凭据：邮箱验证码 / 验证器 / GitHub 任一 */
export async function secondFactorChoices(env: Env, user: UserRow): Promise<Array<{ kind: 'email' | 'totp' | 'github'; label: string; available: boolean }>> {
  const emailReady = await emailOtpAvailable(env);
  const githubLinked = Boolean(await githubAccountOf(env, user.id));
  return [
    { kind: 'email', label: '邮箱验证码', available: emailReady },
    { kind: 'totp', label: '身份验证器', available: Boolean(user.totpEnabled) },
    { kind: 'github', label: 'GitHub', available: githubLinked },
  ];
}

/** 校验用户的 TOTP 动态码：解密密钥 + 防重放 */
export async function checkTotp(env: Env, user: UserRow, code: string, window = 1): Promise<boolean> {
  if (!user.totpEnabled || !user.totpSecret) return false;
  const master = env.SESSION_SECRET ?? env.AUTH_SECRET ?? '';
  const secret = await openSecret(user.totpSecret, master);
  if (!secret) return false;
  return verifyTotp(secret, code, { window, kv: env.SESSION ?? null, key: user.id });
}

/* ------------------------------------------------------------------ /api/account 的目标账号 */

/**
 * 按 account_slug（可带 @ 前缀）或用户 id 定位账号。
 * 默认只能定位到自己；管理员传 ?u=@别人的 slug 时可以代管，前端据此显示「代管模式」。
 */
export async function resolveAccountTarget(c: Ctx): Promise<{ target: UserRow; self: boolean; isAdmin: boolean }> {
  const user = c.get('user');
  if (!user) fail(401, '请先登录');
  const key = (c.req.query('u') ?? c.req.param('u') ?? '').trim().replace(/^@/, '');
  const db = createDb(c.env);
  const isAdmin = user.role === 'admin';

  if (!key) {
    const rows = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    const row = rows[0];
    if (!row) fail(404, '账号不存在');
    return { target: row, self: true, isAdmin };
  }

  const rows = await db.select().from(users).where(idOrSlug(key)).limit(2);
  const hit = rows[0];
  if (!hit) fail(404, `找不到账号 ${key}`);
  const self = hit.id === user.id;
  if (!self && !isAdmin) fail(403, '只能查看或操作自己的账号');
  return { target: hit, self, isAdmin };
}

/** id、account_slug、handle 三种写法都能定位账号 */
function idOrSlug(key: string) {
  return or(eq(users.id, key), eq(users.accountSlug, key), eq(users.handle, key.toLowerCase()));
}

/** 站点的绝对地址：回调与邮件链接都以它为准，后台没配就退回当前请求来源 */
export function siteBase(c: Context): string {
  const configured = (c.env.SITE_URL ?? '').trim();
  const origin = new URL(c.req.url).origin;
  return (configured || origin).replace(/\/+$/, '');
}
