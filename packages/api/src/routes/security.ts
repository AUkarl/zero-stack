/**
 * security.ts — 账号安全（挂在 /api/auth 下，会话走 Cookie）
 *
 * 覆盖三件事，全部只对「本人」开放（管理员代管别人的账号在 /api/admin/*）。
 * 这一组挂在 app.route('/api/security', security) 下，所以对外路径前缀是 /api/security，
 * 不是 /api/auth —— 早前这段注释和几处默认值都写成 /api/auth/*，那是 404（GitHub 回调
 * 尤其致命：默认值拼错时，站长不设 GITHUB_REDIRECT_URI 就永远收不到授权回跳）。
 *   GET  /api/security/              安全概览：策略、已启用凭据、可选登录方式
 *   GET  /api/security/totp/status   验证器状态（密钥是密文，这里不回明文）
 *   POST /api/security/totp/setup    生成验证器密钥（只暂存 KV，不落库）
 *   POST /api/security/totp/enable   用一个动态码确认绑定
 *   POST /api/security/totp/disable  关闭绑定（要动态码或密码）
 *   GET|POST /api/security/github/start   拿 authorizeUrl
 *   GET  /api/security/github/callback    换 token → 写 accounts 表 → 登录或绑定
 *   POST /api/security/github/unbind      解绑
 *   GET  /api/security/github/status      是否配置、是否已绑
 *
 * GitHub 凭据没配时一律 501 + 中文说明缺哪个环境变量，不静默退回。
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { accounts, users } from '../db/schema';
import { requireUser, sessionCookie } from '../middleware/auth';
import { issueSession } from '../services/auth';
import { writeAudit } from '../services/audit';
import { getConfig, getConfigBool } from '../services/config';
import { generateSecret, openSecret, otpauthUri, protectSecret, verifyTotp } from '../services/totp';
import {
  checkTotp,
  clearPendingSecret,
  githubAccountOf,
  githubAuthorizeUrl,
  githubExchange,
  githubOAuth,
  githubUnavailableMessage,
  loginPolicy,
  planFactors,
  readPendingSecret,
  secondFactorChoices,
  securityMethods,
  siteBase,
  stashOAuthState,
  stashPendingSecret,
  takeOAuthState,
  type UserRow,
} from '../services/account-shared';
import { newId, randomToken, verifyPassword } from '../lib/crypto';
import { clientIp, userAgent } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';
import { ok } from '../lib/errors';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

/** errors.ts 的 fail() 只收录了常用状态码，501 这里拼一个同样形状的响应 */
function httpError(status: number, message: string, extra: Record<string, unknown> = {}): never {
  throw new HTTPException(status as 501, { res: Response.json({ error: status, message, ...extra }, { status }) });
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 用户组的显示口径：管理员恒为 owner（站长），其余按库里的 user_group */
function displayGroup(row: { role: string | null; userGroup: string | null }): string {
  return row.role === 'admin' ? 'owner' : row.userGroup || 'friend';
}

function groupLabel(group: string): string {
  return group === 'owner' ? '站长' : group === 'coauthor' ? '共创' : '朋友';
}

function requestOrigin(c: Context): string {
  return new URL(c.req.url).origin;
}

/** 给跳转地址补一个查询参数，路径里已经有 ? 时用 & */
function withParam(path: string, key: string, value: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}

function redirectWith(target: string, cookie?: string): Response {
  const headers = new Headers({ location: target });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

async function loadUserRow(env: Env, userId: string): Promise<UserRow> {
  const rows = await createDb(env).select().from(users).where(eq(users.id, userId)).limit(1);
  const row = rows[0];
  if (!row) httpError(404, '账号不存在');
  return row;
}

/** 密钥密文用 SESSION_SECRET 派生；没配时退回明文，本地开发不至于卡在加解密上 */
function secretMaster(env: Env): string {
  return env.SESSION_SECRET ?? env.AUTH_SECRET ?? '';
}

/** 密钥能不能解开：换了 SESSION_SECRET 就解不开，只能重新绑定 */
async function totpReadable(env: Env, row: UserRow): Promise<boolean> {
  if (!row.totpEnabled) return false;
  return Boolean(await openSecret(row.totpSecret ?? '', secretMaster(env)));
}

/* ------------------------------------------------------------------ 概览 */

app.get('/', async (c) => {
  const sessionUser = requireUser(c);
  const row = await loadUserRow(c.env, sessionUser.id);
  const policy = await loginPolicy(c.env);
  const plan = await planFactors(c.env, row);
  const oauth = githubOAuth(c.env, requestOrigin(c));
  const linked = await githubAccountOf(c.env, row.id);
  const group = displayGroup(row);

  return ok({
    id: row.id,
    email: row.email,
    name: row.name,
    accountSlug: row.accountSlug,
    account_slug: row.accountSlug,
    /** 显示口径：管理员恒为 owner（站长）；普通账号按库里的 user_group */
    userGroup: group,
    user_group: group,
    userGroupName: groupLabel(group),
    /** 库里的原始值：POST /api/security/group 回填当前选中项用 */
    userGroupStored: row.userGroup || 'friend',
    /** 本人可切换的取值，管理员是 owner|friend|coauthor，普通账号为空（由站主在后台改） */
    groupChoices: row.role === 'admin' ? ['owner', 'friend', 'coauthor'] : [],
    role: row.role,
    isAdmin: row.role === 'admin',
    emailVerified: row.emailVerified,
    totpEnabled: row.totpEnabled,
    /** 绑了验证器后登录是否要那道动态码（普通用户自己的开关，默认开启；管理员走站点策略不看它） */
    totpAtLogin: row.totpAtLogin !== false,
    totpReadable: await totpReadable(c.env, row),
    githubLinked: Boolean(linked),
    githubAccountId: linked?.providerAccountId ?? null,
    policy,
    required: {
      password: plan.password,
      emailCode: plan.emailCode,
      totp: plan.totp,
      githubOnly: plan.githubOnly,
    },
    notice: plan.notice,
    methods: await securityMethods(c.env, row),
    secondFactors: await secondFactorChoices(c.env, row),
    github: {
      configured: oauth.configured,
      missing: oauth.missing,
      redirectConfigured: Boolean(oauth.redirectUri),
      message: oauth.configured ? '' : githubUnavailableMessage(oauth),
    },
    totpIssuer: (await getConfig(c.env, 'totpIssuer')) ?? (await getConfig(c.env, 'siteName')) ?? 'Zero',
  });
});

/* -------------------------------------------------- 站长自己的用户组 */

const groupSchema = z.object({
  userGroup: z.enum(['owner', 'friend', 'coauthor']),
});

/**
 * POST /api/security/group {userGroup} —— 只有管理员本人能调。
 *
 * owner（站长）就是「保持现在的管理员身份」；选 friend / coauthor 等于交出站长身份：
 * 除了写 user_group，还把 role 降成 reader，会话仍然有效但后台立刻进不去。
 * 降级前必须库里还有别的管理员，否则 409 —— 站不能没人管。
 * 提权没有接口（与「站内只保留一个管理员、不能把读者提成管理员」一致），
 * 真要收回这个决定得由另一位管理员或手工改库。
 */
app.post('/group', async (c) => {
  const sessionUser = requireUser(c);
  await rateLimit(c, 'security-group', 10, 3600, sessionUser.id);
  const parsed = groupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) httpError(400, 'userGroup 只能是 owner / friend / coauthor');

  const db = createDb(c.env);
  const row = await loadUserRow(c.env, sessionUser.id);
  if (row.role !== 'admin') {
    httpError(403, '只有管理员（站长）能在这里切换用户组；普通账号的用户组请让站主在后台「用户管理」里改。');
  }

  const target = parsed.data.userGroup;
  const set: Record<string, unknown> = { userGroup: target, updatedAt: nowSec() };
  let demoted = false;
  if (target !== 'owner') {
    const others = await db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(and(eq(users.role, 'admin'), sql`${users.id} <> ${row.id}`))
      .limit(1);
    if (Number(others[0]?.n ?? 0) === 0) {
      httpError(409, '站内只有你一个管理员：切成「朋友 / 共创」就没人能进后台了。请先让另一个账号接手管理员，或保持站长身份。');
    }
    set.role = 'reader';
    demoted = true;
  }

  await db.update(users).set(set).where(eq(users.id, row.id));
  await writeAudit(c.env, {
    actor: sessionUser,
    action: 'user',
    target: row.id,
    detail: { event: 'user.group', from: { role: row.role, userGroup: row.userGroup }, to: set },
    ip: clientIp(c),
  });

  const after = (await loadUserRow(c.env, row.id));
  const group = displayGroup(after);
  return ok({
    userGroup: group,
    user_group: group,
    userGroupName: groupLabel(group),
    userGroupStored: after.userGroup || 'friend',
    isAdmin: after.role === 'admin',
    demoted,
    message: demoted
      ? `已切换为「${groupLabel(group)}」，后台权限同时交出（当前会话仍可用于个人中心）。`
      : '已设为「站长」，管理员身份不变。',
  });
});

/* ------------------------------------------------------------------ 身份验证器 */

app.get('/totp/status', async (c) => {
  const user = requireUser(c);
  const row = await loadUserRow(c.env, user.id);
  return ok({
    enabled: row.totpEnabled,
    /** 绑了验证器后登录是否要那道动态码（普通用户自己的开关，默认开启） */
    atLogin: row.totpAtLogin !== false,
    readable: await totpReadable(c.env, row),
    issuer: (await getConfig(c.env, 'totpIssuer')) ?? 'Zero',
    account: row.email,
  });
});

app.post('/totp/setup', async (c) => {
  const user = requireUser(c);
  await rateLimit(c, 'totp-setup', 10, 3600, user.id);
  const row = await loadUserRow(c.env, user.id);
  if (row.totpEnabled) httpError(409, '本账号已经开启身份验证器，请先关闭后再重新绑定');
  const reqBody = (await c.req.json().catch(() => null)) as { issuer?: string } | null;
  const reqIssuer = String(reqBody?.issuer ?? '').trim().slice(0, 60);

  const secret = generateSecret();
  await stashPendingSecret(c.env, user.id, secret);
  const issuer =
    reqIssuer ||
    (await getConfig(c.env, 'totpIssuer')) ||
    (await getConfig(c.env, 'siteName')) ||
    'Zero';
  return ok({
    secret,
    manualEntry: secret,
    otpauthUrl: otpauthUri({ secret, issuer, account: row.email }),
    issuer,
    account: row.email,
    expiresIn: 900,
    message: '密钥 15 分钟内有效，扫码后输入验证器给出的 6 位码完成绑定。',
  });
});

const enableSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, { message: '请输入验证器上的 6 位动态码' }),
  /** KV 不可用的环境可以把刚拿到的密钥带回来，不带就用暂存的那份 */
  secret: z.string().trim().max(64).optional(),
});

app.post('/totp/enable', async (c) => {
  const user = requireUser(c);
  await rateLimit(c, 'totp-enable', 10, 3600, user.id);
  const parsed = enableSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) httpError(400, parsed.error.issues[0]?.message ?? '参数有误');
  const row = await loadUserRow(c.env, user.id);
  if (row.totpEnabled) httpError(409, '身份验证器已经开启，无需重复绑定');

  const pending = parsed.data.secret || (await readPendingSecret(c.env, user.id));
  if (!pending) httpError(400, '密钥已过期，请重新生成后再扫码');
  if (!(await verifyTotp(pending, parsed.data.code, { window: 1 }))) {
    httpError(400, '动态验证码不正确，请确认验证器时间与扫码的是同一把密钥');
  }

  await createDb(c.env)
    .update(users)
    .set({ totpSecret: await protectSecret(pending, secretMaster(c.env)), totpEnabled: true, updatedAt: nowSec() })
    .where(eq(users.id, user.id));
  await clearPendingSecret(c.env, user.id);
  await writeAudit(c.env, { actor: user, action: 'user', target: user.id, detail: { event: 'totp.enable' }, ip: clientIp(c) });
  return ok({ enabled: true, atLogin: true, message: '身份验证器已开启，下次登录需要动态码；不想每次都填可以关掉那一步。' });
});

const atLoginSchema = z.object({ atLogin: z.boolean() });

/**
 * 「登录时要两步验证」这个开关：只对绑了验证器的账号有意义，由账号主人自己定。
 * 站点那条「管理员登录方式」管不到普通用户，普通用户永远是邮箱 + 密码，
 * 要不要多这一道动态码就看这一列（users.totpAtLogin，默认开）。
 */
app.post('/totp/at-login', async (c) => {
  const user = requireUser(c);
  const parsed = atLoginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) httpError(400, '参数有误：atLogin 需为 true / false');
  const row = await loadUserRow(c.env, user.id);
  if (!row.totpEnabled) httpError(409, '还没有绑定身份验证器，绑好之后才有这个开关');

  await createDb(c.env).update(users).set({ totpAtLogin: parsed.data.atLogin, updatedAt: nowSec() }).where(eq(users.id, user.id));
  await writeAudit(c.env, {
    actor: user,
    action: 'user',
    target: user.id,
    detail: { event: 'totp.at-login', atLogin: parsed.data.atLogin },
    ip: clientIp(c),
  });
  return ok({
    atLogin: parsed.data.atLogin,
    message: parsed.data.atLogin ? '已开启：这个账号登录时要填动态码。' : '已关闭：这个账号登录只填邮箱与密码。',
  });
});

const disableSchema = z.object({
  code: z.string().trim().max(16).optional(),
  password: z.string().max(200).optional(),
});

app.post('/totp/disable', async (c) => {
  const user = requireUser(c);
  await rateLimit(c, 'totp-disable', 10, 3600, user.id);
  const parsed = disableSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) httpError(400, '参数有误');
  const row = await loadUserRow(c.env, user.id);
  if (!row.totpEnabled) httpError(409, '本账号还没有开启身份验证器');

  const passed = await ownProof(c, row, parsed.data.code ?? '', parsed.data.password ?? '');
  if (!passed) httpError(401, '关闭身份验证器需要当前动态码或账号密码');

  // 顺手把「登录时要两步验证」复位：将来重新绑定后默认仍要动态码，不沿用上次关掉的偏好
  await createDb(c.env)
    .update(users)
    .set({ totpSecret: null, totpEnabled: false, totpAtLogin: true, updatedAt: nowSec() })
    .where(eq(users.id, user.id));
  await writeAudit(c.env, { actor: user, action: 'user', target: user.id, detail: { event: 'totp.disable' }, ip: clientIp(c) });

  const plan = await planFactors(c.env, { ...row, totpEnabled: false });
  return ok({
    enabled: false,
    notice: plan.notice,
    message: plan.notice ? `身份验证器已关闭。${plan.notice}` : '身份验证器已关闭，密钥已从数据库中清除。',
  });
});

/** 动态码或密码，二选一即算本人 */
async function ownProof(c: Context, row: UserRow, code: string, password: string): Promise<boolean> {
  if (code && (await checkTotp(c.env, row, code))) return true;
  if (password && row.passwordHash && (await verifyPassword(password, row.passwordHash))) return true;
  return false;
}

/* ------------------------------------------------------------------ GitHub */

/** redirect 只接受站内相对路径，免得被人拿来当跳转钓鱼 */
function safeRedirect(raw: string | undefined, fallback: string): string {
  const v = (raw ?? '').trim();
  return /^\/(?!\/)[\w\-./?%&=#@~+]*$/.test(v) ? v : fallback;
}

async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  if (c.req.method === 'GET') return {};
  return ((await c.req.json().catch(() => null)) as Record<string, unknown> | null) ?? {};
}

async function githubStart(c: Context): Promise<Response> {
  const body = await readJsonBody(c);
  const hint = String(c.req.query('intent') ?? body.intent ?? '').trim();
  const oauth = githubOAuth(c.env, requestOrigin(c));
  if (!oauth.configured) httpError(501, githubUnavailableMessage(oauth), { githubConfigured: false, missing: oauth.missing });
  if (!oauth.redirectUri) {
    httpError(
      501,
      `GitHub 回调地址未配置：请设置环境变量 GITHUB_REDIRECT_URI，值为 ${requestOrigin(c)}/api/security/github/callback`,
      { githubConfigured: true },
    );
  }

  const user = c.get('user');
  // 已登录时默认是「绑定到自己的账号」，未登录或显式 login 才是「用 GitHub 登录」
  const intent: 'login' | 'bind' = hint === 'login' || !user ? 'login' : 'bind';
  const state = randomToken(16);
  const fallback = intent === 'login' ? '/account/me/' : '/account/me/?tab=security';
  await stashOAuthState(c.env, state, {
    intent,
    userId: user?.id,
    redirect: safeRedirect(typeof body.redirect === 'string' ? body.redirect : c.req.query('redirect'), fallback),
  });
  return ok({ authorizeUrl: githubAuthorizeUrl(oauth, state), intent, state, callbackUrl: oauth.redirectUri });
}

/** POST /api/security/github/start { intent?, redirect? } —— 同时支持 GET，方便前端直接放链接 */
app.post('/github/start', githubStart);
app.get('/github/start', githubStart);

app.get('/github/callback', async (c) => {
  const base = siteBase(c);
  const failBack = (message: string) => redirectWith(withParam(`${base}/account/`, 'ghError', message));

  const oauthError = c.req.query('error');
  if (oauthError) return failBack(`GitHub 拒绝了授权（${c.req.query('error_description') ?? oauthError}），请重新发起登录`);

  const code = (c.req.query('code') ?? '').trim();
  const state = (c.req.query('state') ?? '').trim();
  if (!code || !state) return failBack('回调参数不完整，请重新发起 GitHub 登录');

  const saved = await takeOAuthState(c.env, state);
  if (!saved) return failBack('登录状态已过期（10 分钟内有效），请重新点击 GitHub 登录');

  const oauth = githubOAuth(c.env, requestOrigin(c));
  if (!oauth.configured) return failBack(githubUnavailableMessage(oauth));

  const exchanged = await githubExchange(c.env, oauth, code);
  if ('error' in exchanged) return failBack(exchanged.error);
  const identity = exchanged.identity;

  const db = createDb(c.env);
  const found = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.provider, 'github'), eq(accounts.providerAccountId, identity.providerAccountId)))
    .limit(1);
  const link = found[0];

  /* 绑定：必须是已登录的本人，且这个 GitHub 账号还没被别人占用 */
  if (saved.intent === 'bind') {
    const sessionUser = c.get('user');
    if (!sessionUser || sessionUser.id !== saved.userId) return failBack('登录状态已变化，请重新绑定 GitHub');
    if (link && link.userId !== sessionUser.id) return failBack('这个 GitHub 账号已经绑定了站内另一个账号');

    const now = nowSec();
    if (link) {
      await db.update(accounts).set({ accessToken: identity.accessToken }).where(eq(accounts.id, link.id));
    } else {
      await db.insert(accounts).values({
        id: newId(),
        userId: sessionUser.id,
        provider: 'github',
        providerAccountId: identity.providerAccountId,
        accessToken: identity.accessToken,
        createdAt: now,
      });
    }
    await writeAudit(c.env, {
      actor: sessionUser,
      action: 'user',
      target: sessionUser.id,
      detail: { event: 'github.bind', providerAccountId: identity.providerAccountId, login: identity.login },
      ip: clientIp(c),
    });
    return redirectWith(withParam(base + safeRedirect(saved.redirect, '/account/me/?tab=security'), 'gh', 'GitHub 绑定成功'));
  }

  /* 登录：已绑定的发会话；没绑定的不自动注册，免得任何人拿 GitHub 账号开洞 */
  if (!link) {
    return failBack('这个 GitHub 账号还没有绑定站内账号。请先用邮箱登录，再到「安全设置」里绑定 GitHub。');
  }
  const rows = await db.select().from(users).where(eq(users.id, link.userId)).limit(1);
  const account = rows[0];
  if (!account) return failBack('绑定的账号已被注销，请联系站主');
  if (account.status === 'banned') return failBack('账号已被封禁，请联系站主');
  // 关闭登录时非管理员也进不来（与 POST /api/auth/login 同一口径，管理员照常放行）
  if (account.role !== 'admin' && !(await getConfigBool(c.env, 'allowRegister', true))) {
    return failBack('站点当前关闭了登录，如需访问请联系站长');
  }

  const { token, expiresAt } = await issueSession(c.env, account.id, { ip: clientIp(c), userAgent: userAgent(c) });
  await writeAudit(c.env, {
    actor: { id: account.id, name: account.name },
    action: 'user',
    target: account.id,
    detail: { event: 'github.login' },
    ip: clientIp(c),
  });
  const target = base + safeRedirect(saved.redirect, '/account/me/');
  return redirectWith(withParam(target, 'gh', '已通过 GitHub 登录'), sessionCookie(token, expiresAt - nowSec(), c.req.url.startsWith('https://')));
});

const unbindSchema = z.object({
  password: z.string().max(200).optional(),
  code: z.string().trim().max(16).optional(),
});

app.post('/github/unbind', async (c) => {
  const user = requireUser(c);
  await rateLimit(c, 'github-unbind', 5, 3600, user.id);
  const parsed = unbindSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) httpError(400, '参数有误');

  const row = await loadUserRow(c.env, user.id);
  const linked = await githubAccountOf(c.env, user.id);
  if (!linked) httpError(404, '本账号还没有绑定 GitHub');

  if (!(await ownProof(c, row, parsed.data.code ?? '', parsed.data.password ?? ''))) {
    httpError(401, '解绑需要当前密码或验证器动态码');
  }
  const plan = await planFactors(c.env, row);
  if (plan.githubOnly) httpError(403, '当前登录策略只允许 GitHub 登录，请先在后台把策略改成其它方式再解绑');

  await createDb(c.env).delete(accounts).where(eq(accounts.id, linked.id));
  await writeAudit(c.env, {
    actor: user,
    action: 'user',
    target: user.id,
    detail: { event: 'github.unbind', providerAccountId: linked.providerAccountId },
    ip: clientIp(c),
  });
  return ok({ linked: false, message: '已解绑 GitHub，之后可以用邮箱密码登录。' });
});

app.get('/github/status', async (c) => {
  const user = requireUser(c);
  const oauth = githubOAuth(c.env, requestOrigin(c));
  const linked = await githubAccountOf(c.env, user.id);
  return ok({
    configured: oauth.configured,
    redirectConfigured: Boolean(oauth.redirectUri),
    missing: oauth.missing,
    message: oauth.configured ? '' : githubUnavailableMessage(oauth),
    linked: Boolean(linked),
    providerAccountId: linked?.providerAccountId ?? null,
    boundAt: linked?.createdAt ?? null,
  });
});

export default app;
