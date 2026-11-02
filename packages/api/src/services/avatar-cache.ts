/**
 * avatar-cache.ts — 把评论者头像在**提交评论时抓一份进桶**（R45）
 *
 * 为什么：前台原来的做法是浏览器逐档去试 gravatar → cravatar → QQ，每档 1.2 秒超时才往下走，
 * 慢源上表现为「先看到首字母、几秒后头像才出来」。改成服务端抓一次存进自己的桶：
 *   · 键：`avatars/<email md5>`（不带扩展名，Content-Type 按实际图片类型存）
 *   · 地址规则与媒体库一致（桶有 baseUrl 走直链，没配就走 /api/media/<桶>/avatars/<md5>）
 *   · 桶对象带 immutable 一年，配合图片域 Cache Rule，之后每个访客都是边缘命中
 *
 * 不引入新表：URL 可以按邮箱哈希**确定性推导**，所以列表侧不需要查库、也不需要「存在性判断」——
 * 没缓存过的那张会 404，前端 onerror 会自然落到下一档（已有逻辑），下一次评论提交/懒预热就补上了。
 *
 * 刷新策略：同一个人**再发评论**时重抓一次（头像换了的最终会被更新）；
 * 列表侧每次最多预热 2 个最近没试过的（隔离内去重，10 分钟内不重复试），避免把慢源拖成雪崩。
 */
import { emailMd5 } from '../lib/avatar';
import { apiBase } from './config';
import { objectUrl, putMediaObject, resolveBucket, type MediaBucket } from './media';
import { fetchWithTimeout } from '../lib/fetch';

/** 头像超过这个大小就不收（正常头像 5~80KB） */
const MAX_BYTES = 300 * 1024;
/** 单次抓取总预算：三档加起来不超过这个时间 */
const FETCH_BUDGET_MS = 6000;

const recentAttempt = new Map<string, number>();
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

export function avatarCacheKey(email: string): string | null {
  const mail = String(email ?? '').trim().toLowerCase();
  if (!mail.includes('@')) return null;
  return `avatars/${emailMd5(mail)}`;
}

/** 该邮箱对应的稳定地址（不判断是否已缓存） */
export async function avatarCachedUrl(env: Env, bucket: MediaBucket, email: string): Promise<string | null> {
  const key = avatarCacheKey(email);
  if (!key) return null;
  const url = await objectUrl(env, bucket, key);
  /* objectUrl 在 mediaPublicUrl/桶 baseUrl 都没配时回的是站内相对路径；
     评论组件会把 avatar 原样放进 <img src>，相对路径在站点域上就是 404（API 在另一个域）。
     头像出口在这里统一补接口 origin，和 CMS 的 media-url 保持同一口径。 */
  if (url && url.startsWith('/')) return `${(await apiBase(env)).replace(/\/+$/, '')}${url}`;
  return url;
}

/**
 * 在预算内按顺序试那几个源，拿到第一张像样的图就写进桶。
 * 任何失败都安静吞掉：头像只是装饰，不该影响评论本身。
 */
export async function refreshAvatarCache(env: Env, email: string, urls: string[], budgetMs: number = FETCH_BUDGET_MS): Promise<boolean> {
  const key = avatarCacheKey(email);
  if (!key) return false;
  /* 按「这台机器到各源的实际速度」排序再试：gravatar 在部分网络里会挂满超时，
     排在后面才不会把预算吃光（实测：预算 2.5s 时轮到 QQ 已经没时间了）。 */
  const rank = (u: string) => (/qlogo\.cn/.test(u) ? 0 : /cravatar/.test(u) ? 1 : /gravatar/.test(u) ? 3 : 2);
  const list = urls.filter((u) => /^https?:\/\//i.test(u)).sort((a, b) => rank(a) - rank(b)).slice(0, 4);
  if (!list.length) return false;

  let bucket;
  try { bucket = await resolveBucket(env, null); } catch { return false; }
  const deadline = Date.now() + Math.max(200, budgetMs);
  for (const url of list) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(left, budgetMs >= 3000 ? 3000 : 900));
    try {
      const res = await fetchWithTimeout(url, { signal: ctrl.signal, headers: { 'user-agent': 'zero-avatar-fetch/1.0' }, redirect: 'follow' });
      if (!res.ok) continue;
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!type.startsWith('image/')) continue;
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len && len > MAX_BYTES) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (!buf.byteLength || buf.byteLength > MAX_BYTES) continue;
      await putMediaObject(env, bucket, { key, data: buf, contentType: type.split(';')[0] ?? 'image/webp' });
      recentAttempt.set(key, Date.now());
      return true;
    } catch (e) {
    } finally {
      clearTimeout(timer);
    }
  }
  recentAttempt.set(key, Date.now());
  return false;
}

/** 列表侧懒预热：同一 isolate 里 10 分钟内不重复尝试同一个邮箱 */
export function shouldWarm(email: string): boolean {
  const key = avatarCacheKey(email);
  if (!key) return false;
  const at = recentAttempt.get(key);
  return !at || Date.now() - at > ATTEMPT_TTL_MS;
}

export function markWarmAttempt(email: string): void {
  const key = avatarCacheKey(email);
  if (key) recentAttempt.set(key, Date.now());
}
