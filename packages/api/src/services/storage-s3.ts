import { fetchWithTimeout } from '../lib/fetch';
/**
 * 最小 S3 兼容客户端：AWS Signature V4（AWS4-HMAC-SHA256）手写，零依赖，Workers 直接跑。
 *
 * 覆盖媒体库需要的四个动作：PUT Object、GET Object、DELETE Object、ListObjectsV2。
 * 能对上 Cloudflare R2 的 S3 端点、阿里 OSS、腾讯 COS、MinIO —— 它们都是同一套签名规则，
 * 差别只在寻址风格（虚拟主机 vs 路径）与 region：
 *   · endpoint 的 host 已经带 bucket 前缀  → 虚拟主机风格
 *   · host 是 IP / localhost / 含 minio     → 路径风格（也可用 pathStyle 强制）
 *   · 其余                                   → 自动拼成 bucket.host 的虚拟主机风格
 *
 * 没绑 SDK 的另一个原因：Wrangler 的 Workers 体积与冷启动都很在意这点预算。
 */

export interface S3Target {
  /** 形如 https://oss-cn-hangzhou.aliyuncs.com 或 https://abc123.r2.dev */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 默认 us-east-1；R2 用 auto 也认 */
  region?: string;
  /** 强制路径风格（MinIO / 自建网关常用） */
  pathStyle?: boolean;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string | null;
}

export interface S3ListResult {
  objects: S3Object[];
  truncated: boolean;
  cursor: string | null;
}

export class S3Error extends Error {}

const enc = new TextEncoder();
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/* ------------------------------------------------------------------ 原语 */

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data)));
}

async function hmac(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data)));
}

/** S3 要求的路径段编码：按 RFC3986，斜杠是否编码由调用方决定 */
function uriEncode(value: string, encodeSlash = true): string {
  const base = encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return encodeSlash ? base.replace(/\//g, '%2F') : base;
}

function canonicalPath(segments: string[]): string {
  const joined = segments.map((s) => uriEncode(s)).join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** 从 endpoint 与 bucket 推出实际请求的 host / 路径前缀 */
function addressing(target: S3Target): { origin: string; host: string; prefix: string; base: URL } {
  const raw = (target.endpoint || '').trim();
  if (!raw) throw new S3Error('存储桶缺少 endpoint');
  const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  const hostHasBucket = url.hostname === `${target.bucket}.${url.hostname}` || url.hostname.startsWith(`${target.bucket}.`);
  const looksPathStyle =
    target.pathStyle === true ||
    /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) ||
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.local') ||
    /minio|cos|localhost/i.test(url.hostname);
  const trailing = url.pathname.replace(/\/+$/, '');

  if (hostHasBucket) {
    return { origin: `${url.protocol}//${url.host}`, host: url.host, prefix: trailing, base: url };
  }
  if (looksPathStyle) {
    return { origin: `${url.protocol}//${url.host}`, host: url.host, prefix: `${trailing}/${uriEncode(target.bucket)}`, base: url };
  }
  const virtualHost = `${target.bucket}.${url.hostname}${url.port ? `:${url.port}` : ''}`;
  return { origin: `${url.protocol}//${virtualHost}`, host: virtualHost, prefix: trailing, base: url };
}

/** 公共访问地址：优先桶里配的 baseUrl，其次按寻址风格推一个 */
export function s3PublicUrl(target: S3Target, baseUrl: string | undefined, key: string): string {
  const segments = key.split('/').filter(Boolean).map((s) => uriEncode(s));
  const custom = (baseUrl ?? '').trim();
  if (custom) {
    const base = custom.replace(/\/+$/, '');
    return `${base}/${segments.join('/')}`;
  }
  const { origin, prefix } = addressing(target);
  return `${origin}${prefix ? `${prefix}/` : ''}${segments.join('/')}`;
}

async function signedFetch(
  target: S3Target,
  input: { method: 'GET' | 'PUT' | 'DELETE'; key: string; query?: Record<string, string>; body?: Uint8Array; contentType?: string },
): Promise<Response> {
  const { origin, host, prefix } = addressing(target);
  const segments = input.key.split('/').filter(Boolean);
  const pathSegments = prefix ? [...prefix.split('/').filter(Boolean), ...segments] : segments;
  const canonicalUri = pathSegments.length ? canonicalPath(pathSegments) : '/';
  const query = input.query ?? {};
  const canonicalQs = canonicalQuery(query);

  const payloadHash = input.body ? await sha256Hex(input.body) : EMPTY_SHA;
  const now = new Date();
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
  const dateStamp = amzDate.slice(0, 8);
  const region = target.region || 'us-east-1';

  const headerMap: Record<string, string> = {
    host: host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (input.contentType) headerMap['content-type'] = input.contentType;
  const sortedNames = Object.keys(headerMap).sort();
  const canonicalHeaders = sortedNames.map((n) => `${n}:${headerMap[n]!.trim()}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQs,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(enc.encode(canonicalRequest))].join('\n');

  const kDate = await hmac(`AWS4${target.secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = toHex(await hmac(kSigning, stringToSign));

  const url = `${origin}${canonicalUri}${canonicalQs ? `?${canonicalQs}` : ''}`;
  const res = await fetchWithTimeout(url, {
    method: input.method,
    headers: {
      ...headerMap,
      Authorization: `AWS4-HMAC-SHA256 Credential=${target.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: input.method === 'GET' || input.method === 'DELETE' ? undefined : input.body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new S3Error(`S3 ${res.status}：${extractXml(text, 'Message') || text.slice(0, 200) || res.statusText}`);
  }
  return res;
}

function extractXml(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? m[1]!.trim() : '';
}

/* ------------------------------------------------------------------ 对外动作 */

export async function s3PutObject(
  target: S3Target,
  input: { key: string; data: ArrayBuffer | Uint8Array | string; contentType?: string },
): Promise<{ key: string; etag: string | null }> {
  const body =
    typeof input.data === 'string'
      ? enc.encode(input.data)
      : input.data instanceof Uint8Array
        ? input.data
        : new Uint8Array(input.data);
  const res = await signedFetch(target, {
    method: 'PUT',
    key: input.key,
    body,
    contentType: input.contentType || 'application/octet-stream',
  });
  return { key: input.key, etag: res.headers.get('etag') };
}

export async function s3GetObject(target: S3Target, key: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  try {
    const res = await signedFetch(target, { method: 'GET', key });
    return { data: await res.arrayBuffer(), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  } catch (e) {
    if (e instanceof S3Error && /404|NoSuchKey/.test(e.message)) return null;
    throw e;
  }
}

export async function s3DeleteObject(target: S3Target, key: string): Promise<void> {
  await signedFetch(target, { method: 'DELETE', key });
}

/** ListObjectsV2；cursor 是上一页的 NextContinuationToken */
export async function s3ListObjects(
  target: S3Target,
  opts: { prefix?: string; maxKeys?: number; cursor?: string } = {},
): Promise<S3ListResult> {
  const query: Record<string, string> = {
    'list-type': '2',
    maxKeys: String(Math.min(Math.max(Number(opts.maxKeys ?? 200) || 200, 1), 1000)),
  };
  if (opts.prefix) query.prefix = opts.prefix;
  if (opts.cursor) query['continuation-token'] = opts.cursor;

  const res = await signedFetch(target, { method: 'GET', key: '', query });
  const xml = await res.text();
  const objects: S3Object[] = (xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []).map((block) => ({
    key: decodeXml(extractXml(block, 'Key')),
    size: Number(extractXml(block, 'Size') || '0'),
    lastModified: extractXml(block, 'LastModified') || null,
  }));
  return {
    objects,
    truncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml),
    cursor: extractXml(xml, 'NextContinuationToken') || null,
  };
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

