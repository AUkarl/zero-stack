import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import { users } from '../db/schema';
import { clearSessionCookie, requireUser, sessionCookie, tokenFromRequest, type Ctx } from '../middleware/auth';
import {
  createUser,
  destroySession,
  findUserByEmail,
  isFirstUser,
  issueSession,
  resolveSession,
  type AuthUser,
} from '../services/auth';
import { writeAudit } from '../services/audit';
import { getConfigBool, getAdminContactEmail } from '../services/config';
import { consumeInvite, normalizeCode, registerPolicy } from '../services/invites';
import {
  assignAccountSlug,
  checkTotp,
  emailOtpAvailable,  loginPolicy,
  planFactors,  sendEmailOtp,
  verifyEmailOtp,
  type UserRow,
} from '../services/account-shared';
import { fail, ok } from '../lib/errors';
import { clientIp, userAgent } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';
import { verifyPassword } from '../lib/crypto';
import type { AppEnv } from '../lib/app';

const OTP_TTL = 600;
const emailSchema = z.string().email().max(200);

const app = new Hono<AppEnv>();

function isSecure(c: Ctx): boolean {
  return c.req.url.startsWith('https://');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 与 fail() 同形状，但能多带字段（比如 next：前端据此补出第二因子输入框） */
function failExtra(status: number, message: string, extra: Record<string, unknown> = {}): never {
  throw new HTTPException(status as 400, { res: Response.json({ error: status, message, ...extra }, { status }) });
}

/**
 * 用户组的显示口径：管理员恒为 'owner'（中文「站长」），其余按库里的 user_group。
 * 库里的 user_group 只有 friend|coauthor（以及管理员在个人中心主动选了 owner 时写的 owner），
 * 但前台徽章只认这个函数返回的值，省得每处都写 role 判断。
 */
export function displayUserGroup(row: { role: string | null; userGroup: string | null }): string {
  return row.role === 'admin' ? 'owner' : row.userGroup || 'friend';
}

function groupLabel(group: string): string {
  return group === 'owner' ? '站长' : group === 'coauthor' ? '共创' : '朋友';
}

/**
 * 登录 / 验证码响应里的账号身份字段。
 * 蛇形命名是给 Hugo 模板与旧脚本用的（account_slug / user_group 直接进 front matter 与徽章判定），
 * 驼峰是给 CMS 用的，两套一起给，省得前端各写一套映射。
 */
function accountPayload(row: UserRow) {
  const group = displayUserGroup(row);
  return {
    account_slug: row.accountSlug,
    accountSlug: row.accountSlug,
    slug: row.accountSlug,
    user_group: group,
    userGroup: group,
    userGroupName: groupLabel(group),
    /** 库里的原始值（PATCH /api/admin/users/:id 回填要用） */
    userGroupStored: row.userGroup || 'friend',
    email: row.email,
    isAdmin: row.role === 'admin',
    role: row.role,
    author_verified: row.authorVerified,
    can_publish: row.canPublish,
    can_author: row.canAuthor,
    totp_enabled: row.totpEnabled,
  };
}

/**
 * allowRegister=false 的语义是「关掉前端注册与新登录入口」，不是把管理员也锁在门外：
 * 后台地址仍然要能进，所以只有非管理员账号被拦。
 */
async function loginGate(env: Env, row: UserRow): Promise<void> {
  if (row.role === 'admin') return;
  if (await getConfigBool(env, 'allowRegister', true)) return;
  const contact = await getAdminContactEmail(env);
  failExtra(403, '站点当前关闭了登录，如需访问请联系站长', contact ? { contact: contact } : {});
}

function sessionHeaders(c: Ctx, token: string, expiresAt: number): void {
  c.header('Set-Cookie', sessionCookie(token, expiresAt - nowSec(), isSecure(c)));
}

/* ------------------------------------------------------------------ 注册 */

/** 注册：站点首个账号免邮箱验证并成为 admin，省去手工初始化 */
app.post('/register', async (c) => {
  const env = c.env;
  const parsed = z
    .object({
      email: emailSchema,
      password: z.string().min(8).max(200),
      name: z.string().min(1).max(64).optional(),
      invite: z.string().max(64).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '邮箱格式有误，或密码长度不足 8 位');
  const { email, password, name } = parsed.data;
  const inviteInput = normalizeCode(parsed.data.invite ?? '');

  await rateLimit(c, 'register', 5, 3600, email);
  if (await findUserByEmail(env, email)) fail(409, '该邮箱已注册');

  const first = await isFirstUser(env);
  let invitedBy: string | null = null;

  if (!first) {
    const policy = await registerPolicy(env);
    if (!policy.allowRegister) fail(403, '站点当前关闭了注册');
    if (policy.requireInviteCode && !inviteInput) fail(400, '本站需要邀请码才能注册');
    // 未强制但要邀请码来源可追溯，用户主动填了就消费
    if (inviteInput) invitedBy = await consumeInvite(env, inviteInput);
  }

  const id = await createUser(env, {
    email,
    password,
    name: name ?? (first ? 'admin' : undefined),
    role: first ? 'admin' : 'reader',
    emailVerified: first,
    invitedBy,
  });
  // 个人管理页的地址要用它：/account/me/?u=@<account_slug>
  const slug = await assignAccountSlug(env, id, email);

  if (first) {
    const { token, expiresAt } = await issueSession(env, id, { ip: clientIp(c), userAgent: userAgent(c) });
    sessionHeaders(c, token, expiresAt);
    return ok({
      id,
      role: 'admin',
      isAdmin: true,
      verified: true,
      account_slug: slug,
      accountSlug: slug,
      slug,
      user_group: 'owner',
      userGroup: 'owner',
      userGroupName: '站长',
      email,
      author_verified: false,
      can_publish: false,
      can_author: false,
      message: '首个账号已自动成为管理员',
    });
  }

  const otp = await sendEmailOtp(env, email, id);
  const base = { id, role: 'reader', verified: false, account_slug: slug, accountSlug: slug, slug, user_group: 'friend' };
  if (!otp.sent) {
    return ok({
      ...base,
      mailSent: false,
      message: '账号已创建，但验证邮件发送失败。可以直接用密码登录，或到后台配好邮件后再来验证邮箱。',
    });
  }
  return ok({ ...base, mailSent: true, message: `注册成功，账号标识 ${slug}，验证码已发送至邮箱` });
});

/* ------------------------------------------------------------------ 邮箱验证码 */

app.post('/send-code', async (c) => {
  const env = c.env;
  const parsed = z
    .object({
      email: emailSchema,
      /** reset / password 都是「改密码或找回密码」的验证码，落库标识同一个 */
      scene: z.enum(['register', 'login', 'reset', 'password']).default('login'),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '邮箱格式有误');
  const { email, scene } = parsed.data;

  await rateLimit(c, 'send-code', 5, 3600, email);
  const user = await findUserByEmail(env, email);
  if (scene === 'register') {
    if (user) fail(409, '该邮箱已注册');
    // 首个账号不需要邮箱验证，其余场景一律受注册开关约束
    if (!(await isFirstUser(env)) && !(await registerPolicy(env)).allowRegister) fail(403, '站点当前关闭了注册');
  } else if (!user) {
    fail(404, '该邮箱尚未注册');
  }

  const otp = await sendEmailOtp(env, email, user?.id ?? null);
  if (!otp.sent) {
    const ready = await emailOtpAvailable(env);
    fail(502, ready ? '验证邮件发送失败，请稍后再试或联系站主' : '本站还没配好邮件通道（SMTP / Resend / Cloudflare 任一），无法发送验证码');
  }
  return ok({ sent: true, ttl: OTP_TTL });
});

/** 邮箱 + 验证码登录，同时完成邮箱验证 */

/**
 * POST /api/auth/verify-email {code} —— 已登录用户在个人中心验证邮箱。
 * 与 /verify-code 的区别：这条不签发新会话（人已经登录着），只把 emailVerified 置真。
 * 验证码用 POST /api/auth/send-code {email, scene:'login'} 取。
 */
app.post('/verify-email', async (c) => {
  const user = requireUser(c);
  const parsed = z
    .object({ code: z.string().trim().regex(/^\d{6}$/, { message: '验证码是 6 位数字' }) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, parsed.error?.issues?.[0]?.message ?? '请输入 6 位验证码');

  await rateLimit(c, 'verify-email', 10, 3600, user.id);
  const rows = await createDb(c.env).select().from(users).where(eq(users.id, user.id)).limit(1);
  const row = rows[0];
  if (!row) fail(404, '账号不存在');
  if (row.emailVerified) fail(409, '这个邮箱已经验证过了，无需重复操作');

  const check = await verifyEmailOtp(c.env, row.email, parsed.data.code);
  if (!check.ok) fail(400, check.message ?? '验证码不正确');

  await createDb(c.env).update(users).set({ emailVerified: true, updatedAt: nowSec() }).where(eq(users.id, row.id));
  await writeAudit(c.env, { actor: user, action: 'user', target: row.id, detail: { event: 'email.verify' }, ip: clientIp(c) });
  return ok({ verified: true, email: row.email, emailVerified: true, message: '邮箱已验证' });
});

/* ------------------------------------------------------------------ 密码登录 */

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt,
    canPublish: row.canPublish,
    canAuthor: row.canAuthor,
    authorVerified: row.authorVerified,
    accountSlug: row.accountSlug,
    userGroup: displayUserGroup(row),
    totpEnabled: row.totpEnabled,
  };
}

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().max(200).optional(),
  /** 邮箱验证码；只要邮箱码的策略下也可当动态码用（前端只留一个框时） */
  code: z.string().trim().max(16).optional(),
  /** 身份验证器动态码 */
  totp: z.string().trim().max(16).optional(),
});

/**
 * 登录：先按后台 adminLoginPolicy 算出这个账号要交哪几样凭据，再按
 * 密码 → 身份验证器 → 邮箱验证码 的顺序校验（第二因子永远在密码之后）。
 * 缺第二因子时回 401 + next，前端据此补出输入框，而不是让人猜。
 */
app.post('/login', async (c) => {
  const env = c.env;
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '请输入邮箱和密码');
  const { email, password, code, totp } = parsed.data;

  await rateLimit(c, 'login', 10, 900, email);
  const rows = await createDb(env).select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  const row = rows[0];
  if (!row) fail(401, '邮箱或密码不正确');
  if (row.status === 'banned') fail(403, '账号已被封禁');

  const plan = await planFactors(env, row);
  const policy = await loginPolicy(env);

  if (plan.githubOnly) {
    failExtra(403, '当前登录策略只允许 GitHub 登录，请用「GitHub 登录」按钮完成验证', {
      next: 'github',
      authorizePath: '/api/auth/github/start?intent=login',
    });
  }

  // 1) 密码（策略为 totp / github 时管理员可以不交密码）
  if (plan.password) {
    if (!password) fail(400, '请输入密码');
    if (!row.passwordHash || !(await verifyPassword(password, row.passwordHash))) fail(401, '邮箱或密码不正确');
  }

  // 2) 身份验证器：紧跟在密码之后
  if (plan.totp) {
    const value = (totp ?? (plan.emailCode ? '' : code ?? '')).trim();
    if (!value) failExtra(401, '请输入身份验证器上的 6 位动态码', { next: 'totp', policy });
    if (!(await checkTotp(env, row, value))) failExtra(401, '动态验证码不正确', { next: 'totp', policy });
  }

  // 3) 邮箱验证码第二因子
  if (plan.emailCode) {
    if (!code) failExtra(401, '请输入邮箱收到的 6 位验证码', { next: 'email-code', policy });
    const check = await verifyEmailOtp(env, email, code);
    if (!check.ok) failExtra(401, check.message ?? '验证码不正确', { next: 'email-code', policy });
  }

  if (!row.emailVerified && (await getConfigBool(env, 'requireEmailVerified', false))) {
    fail(403, '邮箱尚未验证，请先用验证码登录');
  }

  // 凭据都过了才判开关：关闭登录时只拦非管理员，站长仍要从后台地址进来
  await loginGate(env, row);

  const { token, expiresAt } = await issueSession(env, row.id, { ip: clientIp(c), userAgent: userAgent(c) });
  sessionHeaders(c, token, expiresAt);
  if (plan.notice) {
    await writeAudit(env, { actor: { id: row.id, name: row.name }, action: 'user', target: row.id, detail: { event: 'login.policy-notice', policy }, ip: clientIp(c) });
  }
  return ok({
    user: toAuthUser(row),
    ...accountPayload(row),
    policy,
    notice: plan.notice,
    message: plan.notice ?? '登录成功',
  });
});

app.post('/logout', async (c) => {
  // 只清 Cookie 的话，拿到 token 的一方在 30 天内仍能直接调接口
  await destroySession(c.env, tokenFromRequest(c));
  c.header('Set-Cookie', clearSessionCookie(isSecure(c)));
  return ok({ loggedOut: true });
});

/**
 * GET /api/auth/me —— 会话是否有效 + 身份字段。
 * 前端（account.js / 用户中心）据此决定跳去 /account/me/?u=@<account_slug>。
 */
app.get('/me', async (c) => {
  const env = c.env;
  const user = await resolveSession(env, tokenFromRequest(c));
  if (!user) return ok({ user: null, isAdmin: false });
  const rows = await createDb(env).select().from(users).where(eq(users.id, user.id)).limit(1);
  const row = rows[0];
  return ok({
    user: row ? { ...user, userGroup: displayUserGroup(row) } : user,
    isAdmin: user.role === 'admin',
    ...(row ? accountPayload(row) : {}),
    centerPath: row?.accountSlug ? `/account/me/?u=@${row.accountSlug}` : '/account/me/',
    policy: await loginPolicy(env),
  });
});

/* ------------------------------------------------------------------ 登录方式提示（给登录面板用） */

export default app;
