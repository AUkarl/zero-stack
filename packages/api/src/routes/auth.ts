import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import { users, verifications } from '../db/schema';
import { clearSessionCookie, requireUser, sessionCookie, tokenFromRequest, type Ctx } from '../middleware/auth';
import {
  createUser,
  destroySession,
  destroyUserSessions,
  findUserByEmail,
  isFirstUser,
  issueSession,
  resolveSession,
  type AuthUser,
} from '../services/auth';
import { writeAudit } from '../services/audit';
import { ensureAdminAuthorIdentity, withAdminAuthorBits } from '../services/admin-author';
import { getConfigBool, getAdminContactEmail, rememberCmsOrigin } from '../services/config';
import { consumeInvite, normalizeCode, registerPolicy } from '../services/invites';
import {
  assignAccountSlug,
  checkTotp,
  emailOtpAvailable,
  loginPolicy,
  planFactors,
  sendEmailOtp,
  verifyEmailOtp,
  type UserRow,
} from '../services/account-shared';
import { fail, ok } from '../lib/errors';
import { clientIp, userAgent } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';
import { hashPassword, verifyPassword } from '../lib/crypto';
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
  // 管理员恒为认证作者 + 全权限（见 services/admin-author.ts）：
  // 那三个位是站长给别人授权用的开关，不该反过来把站长自己锁在未认证状态。
  const me = withAdminAuthorBits(row);
  const group = displayUserGroup(me);
  return {
    account_slug: me.accountSlug,
    accountSlug: me.accountSlug,
    slug: me.accountSlug,
    /** 作者标识：前台 /author/<handle>/ 与 data/authors.yaml 的键 */
    handle: me.handle ?? '',
    user_group: group,
    userGroup: group,
    userGroupName: groupLabel(group),
    /** 库里的原始值（PATCH /api/admin/users/:id 回填要用） */
    userGroupStored: me.userGroup || 'friend',
    email: me.email,
    isAdmin: me.role === 'admin',
    role: me.role,
    author_verified: me.authorVerified,
    can_publish: me.canPublish,
    can_author: me.canAuthor,
    totp_enabled: me.totpEnabled,
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

/* ---------------------------------------------------- 初始化状态（公开） */

/**
 * 库里还没有任何账号时回 pending=true，后台登录页据此显示「初始化为站长」表单。
 * 不泄露账号数量，只是一个布尔值；而「谁能抢到第一个账号」这件事
 * /api/auth/register 本来就对所有人开放，所以这里没有新增攻击面。
 */
app.get('/init-status', async (c) => ok({ pending: await isFirstUser(c.env) }));

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

  /* 两层桶：邮箱那条防「盯着一个邮箱刷」，IP 这条防「脚本换邮箱连着提」——
     只有邮箱桶时，同一个出口 IP 换邮箱注册没有总量上限（实测 7 个邮箱全过）。 */
  await rateLimit(c, 'register-ip', 10, 3600);
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
    // 首个账号一注册就补齐作者身份：handle 按刚填的注册信息推导，
    // 三个权限位与用户组全亮。以前这里硬编码 author_verified:false、handle 也不写，
    // 结果站长既不是认证作者也没有作者标识，前台署名一直落在主题的占位作者上。
    const identity = await ensureAdminAuthorIdentity(env, id);
    await rememberCmsOrigin(env, c.req.header('origin'));
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
      handle: identity.handle,
      user_group: 'owner',
      userGroup: 'owner',
      userGroupName: '站长',
      email,
      author_verified: true,
      can_publish: true,
      can_author: true,
      message: '首个账号已自动成为管理员',
    });
  }

  /*
   * 注册时不再自动发验证邮件：很多人注册完就关掉页面，那封信既花 SMTP 额度又没人点。
   * 要验证邮箱的人自己到「账号安全 → 邮箱验证」点发送，验证码登录 / 找回密码那条路
   * 仍然走同一套 send-code 接口（POST /api/auth/send-code、/api/auth/verify-email）。
   */
  const base = { id, role: 'reader', verified: false, account_slug: slug, accountSlug: slug, slug, user_group: 'friend' };
  return ok({
    ...base,
    mailSent: false,
    message: `注册成功，账号标识 ${slug}。现在就能用密码登录；要绑定邮箱验证，登录后到「账号安全 → 邮箱验证」点发送。`,
  });
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

  /* 与注册同一套两层桶：只有邮箱桶时，换一个邮箱就是新的一格，同一个 IP 可以无限发信。 */
  await rateLimit(c, 'send-code-ip', 10, 3600);
  await rateLimit(c, 'send-code', 5, 3600, email);
  const user = await findUserByEmail(env, email);
  if (scene === 'register') {
    if (user) fail(409, '该邮箱已注册');
    // 首个账号不需要邮箱验证，其余场景一律受注册开关约束
    if (!(await isFirstUser(env)) && !(await registerPolicy(env)).allowRegister) fail(403, '站点当前关闭了注册');
  } else if (!user) {
    /* 回 404「该邮箱尚未注册」等于把这份名单挂在公网上让人批量验证哪个邮箱开过号。
       这里与「发信成功」回同一份结构：码不落库、不发信，外面看不出区别。 */
    return ok({ sent: true, ttl: OTP_TTL });
  }

  const otp = await sendEmailOtp(env, email, user?.id ?? null);
  if (!otp.sent) {
    const ready = await emailOtpAvailable(env);
    fail(502, ready ? '验证邮件发送失败，请稍后再试或联系站主' : '本站还没配好邮件通道（SMTP / Resend / Cloudflare 任一），无法发送验证码');
  }
  return ok({ sent: true, ttl: OTP_TTL });
});

/**
 * POST /api/auth/reset-password {email, code, newPassword} —— 忘记密码的唯一出口。
 *
 * 为什么必须有这条：/api/account/password 要求先填当前密码，而 send-code 的 reset 场景
 * 只把码发出去、全站没有任何地方消费它，前台那个「忘记密码」入口等于把人引进死胡同。
 * 码是 send-code {scene:'reset'} 发的那一条，落库时就把 userId 钉在本账号上，
 * 别人的登录码在这里用不上；改完把所有会话踢掉，不留「密码换了、旧浏览器还登录着」。
 */
app.post('/reset-password', async (c) => {
  const env = c.env;
  const parsed = z
    .object({
      email: emailSchema,
      code: z.string().trim().regex(/^\d{6}$/, { message: '验证码是 6 位数字' }),
      newPassword: z.string().min(8).max(200),
    })
    .safeParse(await c.req.json().catch(() => null));
  /* zod 对「整个键没送」给的原话是 Required，直接回出来对人没用；只有它自己写的校验消息才值得原样转达 */
  const issue = parsed.error?.issues?.[0]?.message;
  if (!parsed.success) fail(400, issue && issue !== 'Required' ? issue : '邮箱、6 位验证码与至少 8 位的新密码都要填');
  const { email, code, newPassword } = parsed.data;

  await rateLimit(c, 'reset-password-ip', 10, 3600);
  await rateLimit(c, 'reset-password', 10, 3600, email);

  const user = await findUserByEmail(env, email);
  const bad = '验证码不正确或已过期，请重新获取后再试';
  /* 账号不存在、没有这份码、码属于别人，三种情况回同一句话：
     分开发话就等于让人拿这个接口去验证邮箱开没开号。 */
  if (!user) fail(400, bad);

  const rows = await createDb(env)
    .select({ value: verifications.value })
    .from(verifications)
    .where(eq(verifications.identifier, `otp:${user.email}`))
    .limit(1);
  let owner: string | null = null;
  try {
    owner = (JSON.parse(rows[0]?.value ?? '{}') as { userId?: string | null }).userId ?? null;
  } catch {
    owner = null;
  }
  if (!rows[0] || (owner && owner !== user.id)) fail(400, bad);

  const check = await verifyEmailOtp(env, user.email, code);
  if (!check.ok) fail(400, check.message ?? bad);

  await createDb(env)
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(users.id, user.id));
  await destroyUserSessions(env, user.id);
  await writeAudit(env, {
    actor: { id: user.id, name: user.name },
    action: 'user',
    target: user.id,
    detail: { event: 'password.reset' },
    ip: clientIp(c),
  });
  return ok({ reset: true, message: '密码已重置，请用新密码登录；其他设备上的登录状态已全部退出。' });
});

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
  const me = withAdminAuthorBits(row);
  return {
    id: me.id,
    email: me.email,
    name: me.name,
    role: me.role,
    status: me.status,
    emailVerified: me.emailVerified,
    createdAt: me.createdAt,
    handle: me.handle ?? '',
    canPublish: me.canPublish,
    canAuthor: me.canAuthor,
    authorVerified: me.authorVerified,
    accountSlug: me.accountSlug,
    userGroup: displayUserGroup(me),
    totpEnabled: me.totpEnabled,
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

  // 凭据都过了才判开关：关闭登录时只拦非管理员，站长仍要从后台地址进来
  await loginGate(env, row);

  const { token, expiresAt } = await issueSession(env, row.id, { ip: clientIp(c), userAgent: userAgent(c) });
  sessionHeaders(c, token, expiresAt);
  if (row.role === 'admin') await rememberCmsOrigin(env, c.req.header('origin'));
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
