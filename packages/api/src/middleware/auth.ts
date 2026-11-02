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

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean, crossSite = false): string {
  /* SameSite=Lax 在同一个可注册域（cms.example.com ↔ api.example.com）下工作；
     默认的 pages.dev ↔ workers.dev 是跨站，Lax Cookie 不会被浏览器带上。
     跨站请求且 HTTPS 时改用 None；HTTP 本地开发不能发 None（会被浏览器丢弃），保持 Lax。 */
  const sameSite = crossSite && secure ? 'None' : 'Lax';
  const flags = [`${COOKIE_NAME}=${token}`, 'Path=/', `Max-Age=${Math.max(0, maxAgeSeconds)}`, 'HttpOnly', `SameSite=${sameSite}`];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

/** 请求 Origin 与接口 Host 是否属于不同站点；只看最后两级域名，够处理 pages.dev/workers.dev 这类默认域。 */
export function isCrossSiteRequest(c: Ctx): boolean {
  const origin = c.req.header('origin');
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const h = new URL(c.req.url);
    const site = (host: string) => host.toLowerCase().split('.').slice(-2).join('.');
    return site(o.hostname) !== site(h.hostname);
  } catch {
    return false;
  }
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure);
}
