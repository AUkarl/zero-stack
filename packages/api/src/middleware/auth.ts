import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { resolveSession, type AuthUser } from '../services/auth';
import { fail } from '../lib/errors';
import type { AppEnv } from '../lib/app';

export const COOKIE_NAME = 'zero_session';

/** 全站统一的上下文类型 */
export type Ctx = Context<AppEnv>;

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return undefined;
}

/** 会话来源二选一：HttpOnly Cookie（浏览器）或 Bearer（CMS 跨站调用） */
export function tokenFromRequest(c: Ctx): string | undefined {
  const bearer = c.req.header('authorization');
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7).trim();
  return readCookie(c.req.header('cookie') ?? null, COOKIE_NAME);
}

export const authMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  c.set('user', await resolveSession(c.env, tokenFromRequest(c)));
  await next();
});

export function requireUser(c: Ctx): AuthUser {
  const user = c.get('user');
  if (!user) fail(401, '请先登录');
  return user;
}

export function requireAdmin(c: Ctx): AuthUser {
  const user = requireUser(c);
  if (user.role !== 'admin') fail(403, '需要管理员权限');
  return user;
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const flags = [`${COOKIE_NAME}=${token}`, 'Path=/', `Max-Age=${Math.max(0, maxAgeSeconds)}`, 'HttpOnly', 'SameSite=Lax'];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure);
}
