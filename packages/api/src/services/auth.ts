import { and, eq } from 'drizzle-orm';
import { sessions, users } from '../db/schema';
import { createDb } from '../db/client';
import { hashPassword, newId, verifyToken, signToken, randomToken } from '../lib/crypto';
import { fail } from '../lib/errors';

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  /** 'active' | 'banned'，会话解析阶段就已过滤，这里只会是 active */
  status: string;
  emailVerified: boolean;
  /** 注册时间，审核引擎据此判断「新号首评带链接」 */
  createdAt: number;
  /** 以下三项由管理员在后台授予；resolveSession 每次查库，所以改完立即生效 */
  canPublish: boolean;
  canAuthor: boolean;
  authorVerified: boolean;
  /** 用户中心地址用的账号标识（注册时按邮箱前缀分配，可能为空，前端按需回退到 id） */
  accountSlug: string | null;
  /** 'friend' | 'coauthor'，决定前台评论徽章 */
  userGroup: string;
  /** 是否已绑定身份验证器；登录时的第二因子判定要用它 */
  totpEnabled: boolean;
}

const SESSION_DAYS = 30;

function secret(env: Env): string {
  if (!env.SESSION_SECRET) fail(500, '服务端未配置 SESSION_SECRET，请执行 wrangler secret put SESSION_SECRET');
  return env.SESSION_SECRET!;
}

export async function createUser(
  env: Env,
  input: { email: string; password?: string; name?: string; role?: string; emailVerified?: boolean; invitedBy?: string | null },
): Promise<string> {
  const db = createDb(env);
  const id = newId();
  await db.insert(users).values({
    id,
    email: input.email.trim().toLowerCase(),
    name: input.name ?? null,
    role: input.role ?? 'reader',
    emailVerified: input.emailVerified ?? false,
    invitedBy: input.invitedBy ?? null,
    passwordHash: input.password ? await hashPassword(input.password) : null,
  });
  return id;
}

export async function findUserByEmail(env: Env, email: string) {
  const db = createDb(env);
  const rows = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  return rows[0] ?? null;
}

export async function issueSession(env: Env, userId: string, meta: { ip: string; userAgent: string }) {
  const db = createDb(env);
  const id = newId();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  await db.insert(sessions).values({ id, userId, expiresAt, ip: meta.ip, userAgent: meta.userAgent });
  const token = await signToken(secret(env), { sid: id, uid: userId, exp: Math.floor(expiresAt * 1000 / 1000) });
  return { token, expiresAt };
}

export async function resolveSession(env: Env, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  const payload = await verifyToken<{ sid: string; uid: string }>(secret(env), token);
  if (!payload) return null;
  const db = createDb(env);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      status: users.status,
      emailVerified: users.emailVerified,
      createdAt: users.createdAt,
      canPublish: users.canPublish,
      canAuthor: users.canAuthor,
      authorVerified: users.authorVerified,
      accountSlug: users.accountSlug,
      userGroup: users.userGroup,
      totpEnabled: users.totpEnabled,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, payload.sid), eq(users.id, payload.uid)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt * 1000 < Date.now()) return null;
  // 封禁即刻生效：不用等 token 自然过期
  if (row.status === 'banned') return null;
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
    accountSlug: row.accountSlug ?? null,
    userGroup: row.userGroup ?? 'friend',
    totpEnabled: Boolean(row.totpEnabled),
  };
}

export async function destroySession(env: Env, token: string | undefined) {
  if (!token) return;
  const payload = await verifyToken<{ sid: string }>(secret(env), token).catch(() => null);
  if (!payload) return;
  const db = createDb(env);
  await db.delete(sessions).where(eq(sessions.id, payload.sid));
}

/** 封禁或改密后调用，一次性作废该用户的所有会话 */
export async function destroyUserSessions(env: Env, userId: string): Promise<number> {
  const db = createDb(env);
  const res = await db
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return res.length;
}

/**
 * resolveSession 对被封禁账号一律返回 null，调用方分不清「没登录」还是「登了但被封」。
 * 评论接口需要后者给出明确提示，这里用 token 反查账号状态。
 */
export async function bannedByToken(env: Env, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const payload = await verifyToken<{ uid: string }>(secret(env), token).catch(() => null);
  if (!payload) return false;
  const db = createDb(env);
  const rows = await db.select({ status: users.status }).from(users).where(eq(users.id, payload.uid)).limit(1);
  return rows[0]?.status === 'banned';
}

/** 首个账号自动成为管理员，省掉手工初始化 */
export async function isFirstUser(env: Env): Promise<boolean> {
  const db = createDb(env);
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return rows.length === 0;
}

export function randomOtp(): string {
  return String(Number.parseInt(randomToken(4).slice(0, 6), 16) % 1000000).padStart(6, '0');
}
