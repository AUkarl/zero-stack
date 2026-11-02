import { get, getApiBase } from './api';

/**
 * 媒体链接的唯一口径：后台里点出来、复制出去、写进正文的每一条媒体地址，都必须让未登录访客直接打得开。
 *
 * · `/api/admin/media/*` 要管理员 Cookie，放进正文访客只会拿到 401 的 JSON（浏览器按 ORB 拦下来，
 *   现象就是文章页一片裂图），所以这里一条都不给。
 * · 拼法照后端 services/media.ts 的 objectUrl，两边地址必须一模一样：
 *   ① 桶自己的 baseUrl（R2 自定义域 / CDN 直链，不占 Worker 请求数）；
 *   ② 配置项 mediaBaseUrl —— 就是设置页「媒体公开域名」，后端上传响应（admin.ts）也只给 r2 桶用它；
 *   ③ 公开只读代理 `GET /api/media/<bucket>/<key>`（routes/media.ts，匿名可读），绝对前缀依次取
 *      mediaPublicUrl、apiBaseUrl、登录页填的 API 地址。
 * · 三条前缀全都没配出来的相对地址只有站点与接口同源时能用，所以口径单独回给调用方，由界面说清楚。
 */

export interface MediaBucketRef {
  id?: string;
  kind?: string;
  baseUrl?: string;
}

export type MediaLinkKind = 'direct' | 'proxy' | 'relative';

const bases = $state({ mediaBaseUrl: '', mediaPublicUrl: '', apiBaseUrl: '' });
let loading: Promise<void> | null = null;

/** 公开前缀来自配置，整站拉一次就够；读不到就全留空，退到 Worker 代理（代理本来就不需要登录） */
export function loadMediaBases(): Promise<void> {
  loading ??= get<{ data: Record<string, string> }>('/api/admin/config')
    .then((d) => {
      bases.mediaBaseUrl = absBase(d.data?.mediaBaseUrl);
      bases.mediaPublicUrl = absBase(d.data?.mediaPublicUrl);
      bases.apiBaseUrl = absBase(d.data?.apiBaseUrl);
    })
    .catch(() => {});
  return loading;
}

/** 后端 normalizeBaseUrl 同口径：只写 `cdn.example.com` 时补上协议头，否则浏览器按站内相对路径解 */
function absBase(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

/** 分段编码：整串 encodeURIComponent 会把 `uploads/a.png` 变成 `uploads%2Fa.png`，那条路只通向鉴权接口 */
function encodeKey(key: string): string {
  return key
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
}

/** 公开域名候选：桶自己的优先；mediaBaseUrl 后端只给 r2 桶生效，这里跟着同一条限制 */
function directBase(bucket: MediaBucketRef | null | undefined): string {
  return absBase(bucket?.baseUrl) || ((bucket?.kind ?? 'r2') === 'r2' ? bases.mediaBaseUrl : '');
}

function proxyOrigin(): string {
  return bases.mediaPublicUrl || bases.apiBaseUrl || getApiBase();
}

function bucketId(bucket: MediaBucketRef | null | undefined): string {
  return (bucket?.id ?? '').trim() || 'r2';
}

/** 当前桶会给出哪一类地址：direct 直链 / proxy 走 Worker 转发 / relative 相对路径（只有同域部署可用） */
export function mediaLinkKind(bucket: MediaBucketRef | null | undefined): MediaLinkKind {
  if (directBase(bucket)) return 'direct';
  return proxyOrigin() ? 'proxy' : 'relative';
}

/**
 * 永远走 Worker 代理的地址（不管桶有没有配直链域名）。
 * 用途：后台在浏览器里 fetch 原图去做缩略/变体时，直链域是**跨域**且 R2 不发 CORS 头，
 * `fetch().blob()` 会被浏览器拦掉（Failed to fetch）—— 私有桶走的是 /api/media 所以只有它成功。
 * 代理在 /api/* 下，CORS 白名单已经放行后台域，读字节才成立。
 */
export function mediaProxyLink(bucket: MediaBucketRef | null | undefined, key: string): string {
  /* 必须用 getApiBase()（后台此刻真正连的那个 API），不能用 mediaPublicUrl：
     后者是「给访客看的公网地址」，本地台架/调试时它指向线上，回填会去线上找本地键 → 全 404。 */
  return `${getApiBase().replace(/\/+$/, '')}/api/media/${encodeURIComponent(bucketId(bucket))}/${encodeKey(key)}`;
}

export function mediaLink(bucket: MediaBucketRef | null | undefined, key: string): string {
  const base = directBase(bucket);
  if (base) return `${base}/${encodeKey(key)}`;
  const origin = proxyOrigin();
  return `${origin}/api/media/${encodeURIComponent(bucketId(bucket))}/${encodeKey(key)}`;
}
