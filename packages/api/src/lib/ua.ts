/**
 * ua.ts — 访客指纹、属地与 UA 解析（评论写库用，零依赖）
 *
 * 三条纪律：
 *   1. 明文 IP 一律不入库，只存加盐 SHA-256（ip_hash）。
 *   2. 属地只取 Cloudflare 附带的信息（c.req.raw.cf），本地 dev 没有 cf 就留空。
 *   3. UA 解析只做粗分类（浏览器/系统/设备），够前台展示即可，不追求型号精确。
 */

import type { Context } from 'hono';

export interface UaInfo {
  device: string;
  browser: string;
  os: string;
}

export interface GeoInfo {
  country: string;
  city: string;
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

/** 盐优先用运行时 secret，都没配时用固定串兜底（本地开发不至于报错，但别依赖它） */
function salt(env: Env | undefined): string {
  return env?.AUTH_SECRET || env?.SESSION_SECRET || 'zero-static-salt';
}

/** 明文 IP → 加盐 SHA-256。空 IP 也返回稳定值，避免 NULL 让去重失效 */
export async function hashIp(ip: string, env?: Env): Promise<string> {
  const value = String(ip || '').trim();
  return sha256Hex(`${salt(env)}|ip|${value}`);
}

/** 匿名点赞/匿名评论的访客指纹：IP 哈希 + UA 前缀，同样不落明文 */
export async function visitorFingerprint(env: Env | undefined, ip: string, userAgent: string): Promise<string> {
  const hashed = await hashIp(ip, env);
  return sha256Hex(`${salt(env)}|fp|${hashed}|${String(userAgent || '').slice(0, 120)}`);
}

/** UA 粗解析：够做「Chrome / macOS / 桌面端」这种展示粒度 */
export function parseUA(ua: string): UaInfo {
  const s = String(ua || '');
  const isTablet = /iPad|Tablet|PlayBook|Silk/i.test(s);
  const isMobile = /Mobi|Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(s);
  const device = isTablet ? 'tablet' : isMobile ? 'mobile' : 'desktop';

  let browser = 'other';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/MicroMessenger|WeChat/i.test(s)) browser = 'WeChat';
  else if (/QQ\//.test(s)) browser = 'QQ';
  else if (/Firefox|Fxios/.test(s)) browser = 'Firefox';
  else if (/Chrome|Crios/.test(s)) browser = 'Chrome';
  else if (/Safari/.test(s)) browser = 'Safari';

  let os = 'other';
  if (/Windows/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod|iOS/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X|Macintosh|macOS/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';

  return { device, browser, os };
}

type CfProps = { country?: string; city?: string; region?: string } | undefined;

function cfOf(c: Context): CfProps {
  return (c.req.raw as Request & { cf?: { country?: string; city?: string; region?: string } }).cf;
}

/**
 * 属地：CF 的 cf.country 是 ISO 码（CN/US…），cf.city 是英文城市名。
 * 本地 dev 没有 cf → 两个都留空，前端就不显示属地，不编造。
 */
export function geoFromRequest(c: Context): GeoInfo {
  const cf = cfOf(c);
  const city = String(cf?.city ?? '').trim().slice(0, 60);
  const region = String(cf?.region ?? '').trim().slice(0, 60);
  return {
    country: String(cf?.country ?? '').trim().slice(0, 8),
    city: (city || region).slice(0, 60),
  };
}

/** 一次拿齐评论要写的访客维度字段（属地 + UA），调用点只管塞进 insert */
export async function visitorMeta(c: Context, env: Env, ip: string, ua: string) {
  const geo = geoFromRequest(c);
  const parsed = parseUA(ua);
  return {
    ipHash: await hashIp(ip, env),
    country: geo.country,
    city: geo.city,
    browser: parsed.browser,
    os: parsed.os,
    device: parsed.device,
  };
}
