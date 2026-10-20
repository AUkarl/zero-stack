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
 * SESSION 未绑定时直接放过，不阻塞本地开发。
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
  const key = limitKey(name, c, keyHint);

  let hits: number[] = [];
  try {
    const raw = await env.SESSION.get(key, { type: 'text' });
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) hits = parsed.filter((t): t is number => typeof t === 'number' && t > since);
  } catch {
    hits = [];
  }

  if (hits.length >= limit) tooOften(hits[0]!, since);

  hits.push(now);
  try {
    await env.SESSION.put(key, JSON.stringify(hits), { expirationTtl: windowSeconds + 60 });
  } catch {
    /* 写不进去就当作没记，宁可放过也不要卡住正常用户 */
  }
}

/**
 * 同一个窗口的内存版：口径、键、提示语都与 KV 版一致，只是记在本 isolate 里。
 *
 * 为什么要分开：一次 KV 限流 = 一读一写，而 KV 免费额度只有 1000 次写/天，
 * 5000 访问/天的站光 /beat 就要 5000 次写。所以前台每个页面都会打的高频低危口走这条
 * （/beat、/heartbeat、/api/reactions、subscribe-status），其余继续用 KV
 * （注册、发码、找回密码、登录、订阅提交、退订、评论正文、评论点赞、友链申请、群发、翻译、
 * 站长邮箱）—— KV 那份跨 isolate 生效，冷启动不会把额度还回来。
 *
 * 内存版的边界要认下来：只在本 isolate 内准确，冷启动清零、多 isolate 不共享。
 * 它挡的是「同一个会话/同一个 IP 无节制地打」，不是严格配额；
 * 换来的是这四条口一次 KV 都不写。
 * KV 是最终一致的，读-改-写本来也不原子，两版都是够用的防刷。
 */
export function rateLimitLocal(c: Context, name: string, limit: number, windowSeconds: number, keyHint = ''): void {
  if (limit <= 0) return;

  const now = Date.now();
  const since = now - windowSeconds * 1000;
  const key = limitKey(name, c, keyHint);
  const hits = activeHits(key, since);

  if (hits.length >= limit) tooOften(hits[0]!, since);

  hits.push(now);
  buckets.set(key, { windowSeconds, hits });
  if (buckets.size > MAX_KEYS) prune(now);
}

function limitKey(name: string, c: Context, keyHint: string): string {
  return `rl:${name}:${clientIp(c)}:${keyHint}`;
}

/** 超出窗口时抛 429，提示给出真实等待秒数（两版共用这一句） */
function tooOften(first: number, since: number): never {
  const wait = Math.max(1, Math.ceil((first - since) / 1000));
  fail(429, `操作过于频繁，请 ${wait >= 60 ? `${Math.ceil(wait / 60)} 分钟` : `${wait} 秒`}后再试`);
}

type Bucket = { windowSeconds: number; hits: number[] };
const buckets = new Map<string, Bucket>();

/** 一个 IP 一条记录，量级就是「这一小时来过多少个 IP」；到上限时整桶过期的先丢掉 */
const MAX_KEYS = 20_000;

function activeHits(key: string, since: number): number[] {
  const bucket = buckets.get(key);
  if (!bucket) return [];
  const hits = bucket.hits.filter((t) => t > since);
  if (!hits.length) buckets.delete(key);
  return hits;
}

function prune(now: number) {
  for (const [key, bucket] of buckets) {
    if (!bucket.hits.length || bucket.hits[bucket.hits.length - 1]! <= now - bucket.windowSeconds * 1000) {
      buckets.delete(key);
    }
  }
}
