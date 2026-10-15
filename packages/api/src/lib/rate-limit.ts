import type { Context } from 'hono';
import { fail } from './errors';
import { clientIp } from './http';

/**
 * 滑动窗口限流：一个键里存窗口内各次命中的时间戳，每次先丢掉过期的那几个。
 *
 * 之前是按整点切的固定窗口，「每小时 10 条」实际会在整点突然重置或让人白等
 * 将近一小时，而且提示语写死窗口长度，于是出现「过了时间还是发不出去」。
 * 现在窗口跟着上一次的动作走，提示也给出真实等待秒数。
 *
 * KV 是最终一致的，这里的读-改-写不保证原子，突发并发可能少算一两次：
 * 这是够用的防刷，不是严格配额。SESSION 未绑定时直接放过，不阻塞本地开发。
 */
export async function rateLimit(
  c: Context,
  name: string,
  limit: number,
  windowSeconds: number,
  keyHint = '',
): Promise<void> {
  const env = c.env as Env;
  if (!env.SESSION || limit <= 0) return;

  const now = Date.now();
  const since = now - windowSeconds * 1000;
  const key = `rl:${name}:${clientIp(c)}:${keyHint}`;

  let hits: number[] = [];
  try {
    const raw = await env.SESSION.get(key, { type: 'text' });
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) hits = parsed.filter((t): t is number => typeof t === 'number' && t > since);
  } catch {
    hits = [];
  }

  if (hits.length >= limit) {
    const wait = Math.max(1, Math.ceil((hits[0] - since) / 1000));
    fail(429, `操作过于频繁，请 ${wait >= 60 ? `${Math.ceil(wait / 60)} 分钟` : `${wait} 秒`}后再试`);
  }

  hits.push(now);
  try {
    await env.SESSION.put(key, JSON.stringify(hits), { expirationTtl: windowSeconds + 60 });
  } catch {
    /* 写不进去就当作没记，宁可放过也不要卡住正常用户 */
  }
}
