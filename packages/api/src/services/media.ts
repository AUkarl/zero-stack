/**
 * 媒体库多桶：一份配置（site_config 的 mediaBuckets）描述多个存储位置，
 * kind = 'r2' 走 Workers 绑定的 R2，kind = 's3' 走 services/storage-s3 的 S3 兼容签名。
 *
 * 配置形如：
 *   [{"id":"r2","label":"默认 R2","kind":"r2","binding":"R2","baseUrl":""},
 *    {"id":"oss","label":"阿里 OSS","kind":"s3","bucket":"my-bucket","endpoint":"https://oss-cn-hangzhou.aliyuncs.com",
 *     "region":"oss-cn-hangzhou","accessKeyId":"LTAI...","secretAccessKey":"...","baseUrl":"https://cdn.example.com","prefix":"media/"}]
 *
 * 秘钥就存在这份 JSON 里，所以任何回给浏览器的视图都必须先过 maskBucket：
 * secretAccessKey 只以 hasSecret 的形式出现。
 */

import { getConfig, getConfigJson } from './config';
import { fail } from '../lib/errors';
import { s3DeleteObject, s3GetObject, s3ListObjects, s3PublicUrl, s3PutObject, type S3Object } from './storage-s3';

export interface MediaBucket {
  id: string;
  label: string;
  kind: 'r2' | 's3';
  /** r2：Workers 绑定名，缺省 R2 */
  binding?: string;
  /** s3：桶名 */
  bucket?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** 自定义域名 / CDN，留空则走 Worker 代理读 */
  baseUrl?: string;
  /** 对象键前缀，例如 media/ */
  prefix?: string;
  /** 强制路径风格寻址（MinIO 之类） */
  pathStyle?: boolean;
}

export interface MediaObject {
  key: string;
  /** 去掉桶前缀后的相对键，后台展示用 */
  name: string;
  size: number;
  lastModified: string | null;
  url: string;
  bucket: string;
}

const DEFAULT_BUCKET: MediaBucket = { id: 'r2', label: '默认 R2', kind: 'r2', binding: 'R2', baseUrl: '' };

/** 读桶列表；配置坏了也不让媒体库整个不可用，兜底成默认 R2 */
export async function listBuckets(env: Env): Promise<MediaBucket[]> {
  const raw = await getConfigJson<unknown>(env, 'mediaBuckets', []);
  const list = Array.isArray(raw) ? raw : [];
  const parsed = list.map((item) => normalizeBucket(item)).filter((b): b is MediaBucket => b !== null);
  if (parsed.length) return dedupe(env.R2 ? withBoundR2(parsed) : parsed);
  const configured = await getConfig(env, 'mediaBuckets');
  if (configured && configured.trim() && !Array.isArray(raw)) {
    // JSON 写坏了：留给后台一个可用桶，同时把问题暴露出去
    return [DEFAULT_BUCKET];
  }
  return [DEFAULT_BUCKET];
}

/**
 * Worker 绑了 R2，媒体页就必须能选到它。
 *
 * 以前 mediaBuckets 一填（例如只登记了公开桶），配置里的列表就把默认桶整个顶掉，
 * 结果是「原图想放回私有桶」在后台根本点不到 —— 而私有桶是这个 Worker 唯一确定可读的桶。
 * 所以列表里没有 r2/R2 这条时，把默认桶补在最前面（同 id 不会重复出现）。
 */
function withBoundR2(list: MediaBucket[]): MediaBucket[] {
  if (list.some((b) => b.kind === 'r2' && (b.binding ?? 'R2') === DEFAULT_BUCKET.binding)) return list;
  return [DEFAULT_BUCKET, ...list];
}

/**
 * 直链前缀补上协议头：只写 `cdn.example.com` 时拼出来的是
 * `cdn.example.com/uploads/a.png`，浏览器按站内相对路径去解，图片全 404，
 * 而后台那份配置看着像是配好了 —— 裂图比空着更难查。
 */
function normalizeBaseUrl(raw: unknown): string {
  const s = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

function normalizeBucket(item: unknown): MediaBucket | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const kind = String(o.kind ?? 'r2').toLowerCase();
  if (kind !== 'r2' && kind !== 's3') return null;
  const id = String(o.id ?? '').trim();
  if (!id) return null;
  const bucket: MediaBucket = {
    id,
    label: String(o.label ?? id).trim() || id,
    kind: kind as MediaBucket['kind'],
    binding: o.binding ? String(o.binding) : kind === 'r2' ? 'R2' : undefined,
    bucket: o.bucket ? String(o.bucket) : undefined,
    endpoint: o.endpoint ? String(o.endpoint) : undefined,
    region: o.region ? String(o.region) : undefined,
    accessKeyId: o.accessKeyId ? String(o.accessKeyId) : undefined,
    secretAccessKey: o.secretAccessKey ? String(o.secretAccessKey) : undefined,
    baseUrl: normalizeBaseUrl(o.baseUrl),
    prefix: o.prefix ? String(o.prefix) : '',
    pathStyle: o.pathStyle === true ? true : undefined,
  };
  if (bucket.kind === 's3' && !bucket.bucket) return null;
  return bucket;
}

function dedupe(list: MediaBucket[]): MediaBucket[] {
  const seen = new Set<string>();
  const out: MediaBucket[] = [];
  for (const b of list) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    out.push(b);
  }
  return out;
}

/** 回给前端的脱敏视图 */
export function maskBucket(b: MediaBucket): Record<string, unknown> {
  return {
    id: b.id,
    label: b.label,
    kind: b.kind,
    binding: b.binding ?? null,
    bucket: b.bucket ?? null,
    endpoint: b.endpoint ?? '',
    region: b.region ?? '',
    accessKeyId: b.accessKeyId ?? '',
    hasSecret: Boolean(b.secretAccessKey),
    baseUrl: b.baseUrl ?? '',
    prefix: b.prefix ?? '',
    pathStyle: b.pathStyle ?? false,
  };
}

export async function resolveBucket(env: Env, id?: string | null): Promise<MediaBucket> {
  const buckets = await listBuckets(env);
  const want = (id ?? '').trim();
  if (!want) return buckets[0]!;
  const hit = buckets.find((b) => b.id === want);
  if (!hit) fail(404, `存储桶 ${want} 不存在，请从 /api/admin/media/buckets 里选一个 id`);
  return hit!;
}

/* ------------------------------------------------------------------ R2 绑定 */

function r2Bucket(env: Env, bucket: MediaBucket): R2Bucket {
  const name = bucket.binding || 'R2';
  const bound = (env as unknown as Record<string, R2Bucket | undefined>)[name];
  if (bound) return bound;
  if (env.R2) return env.R2;
  fail(500, `未绑定 R2（需要 ${name}）`);
}


/* ------------------------------------------------------------------ 键与地址 */

export function bucketPrefix(bucket: MediaBucket): string {
  const p = (bucket.prefix ?? '').replace(/^\/+|\/+$/g, '');
  return p ? `${p}/` : '';
}

/** 对象在桶里的完整键（含桶前缀） */
export function fullKey(bucket: MediaBucket, key: string): string {
  const clean = key.replace(/^\/+/, '');
  const prefix = bucketPrefix(bucket);
  return prefix && !clean.startsWith(prefix) ? `${prefix}${clean}` : clean;
}

/**
 * 对象的站内地址：配了 baseUrl（自定义域 / CDN，公开可读）才直连对象存储，
 * 否则走 Worker 的公开代理 GET /api/media/<bucket>/<key>。
 * 私有 S3 桶没有签名直连拿不到对象，直连只会给前端一个 403。
 */
export function objectPath(bucket: MediaBucket, key: string): string {
  const base = (bucket.baseUrl ?? '').trim();
  if (base) return s3PublicUrl(s3TargetOf(bucket), base, key);
  return `/api/media/${encodeURIComponent(bucket.id)}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * 写进 Markdown 的地址必须是绝对地址：站点和 API 往往不同源，
 * 相对路径到了 Hugo 那一侧就解析成站点自己的 404。
 * mediaPublicUrl 没配时只能退回站内路径（同域部署可用）。
 */
export async function objectUrl(env: Env, bucket: MediaBucket, key: string): Promise<string> {
  const path = objectPath(bucket, key);
  if (/^https?:\/\//i.test(path)) return path;
  const base = normalizeBaseUrl(await getConfig(env, 'mediaPublicUrl'));
  return base ? `${base}${path}` : path;
}

/** r2 桶拿不到 S3 参数：只用于拼 URL 的 host，不签名 */
function s3TargetOf(bucket: MediaBucket) {
  return {
    endpoint: bucket.endpoint ?? '',
    bucket: bucket.bucket ?? bucket.id,
    accessKeyId: bucket.accessKeyId ?? '',
    secretAccessKey: bucket.secretAccessKey ?? '',
    region: bucket.region,
    pathStyle: bucket.pathStyle,
  };
}

/* ------------------------------------------------------------------ 读写动作 */

export async function putMediaObject(
  env: Env,
  bucket: MediaBucket,
  input: { key: string; data: ArrayBuffer | Uint8Array | ReadableStream; contentType: string },
): Promise<{ key: string; url: string; size: number }> {
  const key = fullKey(bucket, input.key);
  if (bucket.kind === 'r2') {
    await r2Bucket(env, bucket).put(key, input.data as ArrayBuffer | ArrayBufferView, {
      httpMetadata: { contentType: input.contentType },
    });
    const size = input.data instanceof Uint8Array ? input.data.length : 0;
    return { key, url: await objectUrl(env, bucket, key), size };
  }
  const data =
    input.data instanceof ReadableStream
      ? new Uint8Array(await new Response(input.data).arrayBuffer())
      : input.data instanceof ArrayBuffer
        ? new Uint8Array(input.data)
        : input.data;
  await s3PutObject(s3TargetOf(bucket), { key, data, contentType: input.contentType });
  return { key, url: await objectUrl(env, bucket, key), size: data.byteLength };
}

export async function listMediaObjects(
  env: Env,
  bucket: MediaBucket,
  opts: { prefix?: string; limit?: number; cursor?: string } = {},
): Promise<{ objects: MediaObject[]; truncated: boolean; cursor: string | null }> {
  const limit = Math.min(Math.max(Number(opts.limit ?? 200) || 200, 1), 1000);
  const prefix = bucketPrefix(bucket) + (opts.prefix ?? '').replace(/^\/+/, '');

  if (bucket.kind === 'r2') {
    const listed = await r2Bucket(env, bucket).list({ prefix, limit, cursor: opts.cursor || undefined });
    return {
      objects: await Promise.all(listed.objects.map((o) => toMedia(env, bucket, o.key, o.size, o.uploaded?.toISOString() ?? null))),
      truncated: listed.truncated,
      cursor: listed.truncated ? (listed.cursor ?? null) : null,
    };
  }

  const listed = await s3ListObjects(s3TargetOf(bucket), { prefix, maxKeys: limit, cursor: opts.cursor || undefined });
  return {
    objects: await Promise.all(listed.objects.map((o: S3Object) => toMedia(env, bucket, o.key, o.size, o.lastModified))),
    truncated: listed.truncated,
    cursor: listed.cursor,
  };
}

async function toMedia(env: Env, bucket: MediaBucket, key: string, size: number, lastModified: string | null): Promise<MediaObject> {
  const prefix = bucketPrefix(bucket);
  return { key, name: prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key, size, lastModified, url: await objectUrl(env, bucket, key), bucket: bucket.id };
}

export async function getMediaObject(
  env: Env,
  bucket: MediaBucket,
  key: string,
): Promise<{ data: ArrayBuffer | ReadableStream; contentType: string } | null> {
  const full = fullKey(bucket, key);
  if (bucket.kind === 'r2') {
    const obj = await r2Bucket(env, bucket).get(full);
    if (!obj) return null;
    return { data: obj.body as ReadableStream, contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream' };
  }
  const obj = await s3GetObject(s3TargetOf(bucket), full);
  if (!obj) return null;
  return { data: obj.data, contentType: obj.contentType };
}

/**
 * 这个键在桶里有没有。**用 list 而不是 get**：恢复图片时同名要先让路，
 * 为判断存在就把一张原图整份读回来，白烧流量也把 Worker 的 CPU 时间耗光。
 */
export async function mediaObjectExists(env: Env, bucket: MediaBucket, key: string): Promise<boolean> {
  const full = fullKey(bucket, key);
  if (bucket.kind === 'r2') {
    const listed = await r2Bucket(env, bucket).list({ prefix: full, limit: 5 });
    return (listed.objects ?? []).some((o) => o.key === full);
  }
  const listed = await s3ListObjects(s3TargetOf(bucket), { prefix: full, maxKeys: 5 });
  return listed.objects.some((o) => o.key === full);
}

export async function deleteMediaObject(env: Env, bucket: MediaBucket, key: string): Promise<{ key: string }> {
  const full = fullKey(bucket, key);
  if (bucket.kind === 'r2') await r2Bucket(env, bucket).delete(full);
  else await s3DeleteObject(s3TargetOf(bucket), full);
  return { key: full };
}

