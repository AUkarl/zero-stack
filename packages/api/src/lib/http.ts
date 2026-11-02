import type { Context } from 'hono';

/** 整点对应的 KV 键；本地 dev 与线上都够用（KV 有最终一致性，计数只作趋势看） */
const fallbackKey = (hour = Math.floor(Date.now() / 3_600_000)) => `ipfb:${hour}`;

/**
 * 记一笔「这次请求没带 cf-connecting-ip」。
 *
 * 为什么要有这一笔：所有按 IP 的限流键都把 clientIp 拼在里面，而这个头只有 Cloudflare
 * 的边缘会加。哪天接口被别的入口直连（内部脚本、绕过 Pages 的自定义域、迁移期），
 * 全体访客就会挤进兜底常量那一个桶里互相顶额度，而现场看不出来 —— 本地体检就得手动送这个头才测得准。
 * 计数是近似值（读-改-写有竞态），够用来判断「有没有在发生」。
 */
function bumpIpFallback(c: Context): void {
  const env = c.env as { CACHE?: { get: (k: string) => Promise<string | null>; put: (k: string, v: string, o?: unknown) => Promise<unknown> } };
  const kv = env.CACHE;
  if (!kv) return;
  const run = async () => {
    try {
      const n = Number(await kv.get(fallbackKey()));
      await kv.put(fallbackKey(), String((Number.isFinite(n) ? n : 0) + 1), { expirationTtl: 3 * 3600 });
    } catch {
      /* 计数本身坏了不能拖累请求 */
    }
  };
  const ctx = c.executionCtx as { waitUntil?: (p: Promise<unknown>) => void };
  if (ctx?.waitUntil) ctx.waitUntil(run());
  else void run();
}

/** Cloudflare 提供的真实客户端 IP；本地 dev 时回退到占位值 */
export function clientIp(c: Context): string {
  const cf = c.req.raw.headers.get('cf-connecting-ip');
  if (cf) return cf;
  bumpIpFallback(c);
  const env = c.env as { CF_CLIENT_IP_FALLBACK?: string };
  return env.CF_CLIENT_IP_FALLBACK ?? '203.0.113.1';
}

/** 近 N 小时有多少请求走的是兜底 IP（健康页用；没带过就是 0） */
export async function ipFallbackCount(env: unknown, hours = 3): Promise<number> {
  const kv = (env as { CACHE?: { get: (k: string) => Promise<string | null> } }).CACHE;
  if (!kv) return 0;
  const nowHour = Math.floor(Date.now() / 3_600_000);
  let total = 0;
  for (let i = 0; i < hours; i++) {
    const v = await kv.get(fallbackKey(nowHour - i)).catch(() => null);
    const n = Number(v);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

export function userAgent(c: Context): string {
  return c.req.raw.headers.get('user-agent') ?? '';
}

export function country(c: Context): string {
  return c.req.raw.headers.get('cf-ipcountry') ?? '';
}

export interface DeviceInfo {
  device: 'mobile' | 'tablet' | 'desktop';
  browser: string;
  os: string;
}

/** 粗粒度 UA 分类，够用且零依赖；统计只需要分组维度，不需要精确型号 */
export function parseUserAgent(ua: string): DeviceInfo {
  const s = ua.toLowerCase();
  let device: DeviceInfo['device'] = 'desktop';
  if (/iPad|Tablet|PlayBook|Silk/.test(ua)) device = 'tablet';
  else if (/Mobi|Android|iPhone|Pod|iPod|BlackBerry|IEMobile|Opera Mini/.test(ua)) device = 'mobile';

  let browser = 'other';
  if (/edg|edge/.test(s)) browser = 'edge';
  else if (/opr\/|opera/.test(s)) browser = 'opera';
  else if (/firefox|fxios/.test(s)) browser = 'firefox';
  else if (/chrome|crios/.test(s)) browser = 'chrome';
  else if (/safari/.test(s)) browser = 'safari';

  let os = 'other';
  if (/windows/.test(s)) os = 'windows';
  else if (/android/.test(s)) os = 'android';
  else if (/iphone|ipad|ipod/.test(s)) os = 'ios';
  else if (/mac os x|macos/.test(s)) os = 'macos';
  else if (/linux/.test(s)) os = 'linux';
  else if (/cros/.test(s)) os = 'chromeos';

  return { device, browser, os };
}

/**
 * 只把「真的是浏览器」的请求算作浏览量。
 *
 * 之前这份黑名单挨个列爬虫（bot/curl/监控…），漏一条就算真人 ——
 * 实测 axios/1.6.8、node-fetch、aiohttp 全被记成访客，同一台机器想刷多少行就多少行。
 * 现在反过来认：这条 beacon 只由页面里的 navigator.sendBeacon 发出，浏览器 UA 一定带
 * 「Mozilla/5.0」，脚本默认的 UA 不带。黑名单继续留着，管的是「浏览器壳子的爬虫」（Headless 等）。
 */
const BOT_RE =
  /bot|crawler|spider|slurp|curl|wget|python-requests|httpie|go-http-client|java\/|okhttp|headlesschrome|phantomjs|lighthouse|pagespeed|pingdom|uptime|monitor|newman|postmanruntime|feedfetcher|rss|archive|ahrefs|semrush|mj12|dotpet|baidujapan|yandex|sogou|360spider|googleweblight|miniflux|fever|reeder|neteasefetcher|bingpreview|facebookexternalhit|telegrambot|whatsapp|slackbot|discordbot|line-pk/i;

export function isBot(ua: string | undefined | null): boolean {
  const s = String(ua ?? '').trim();
  if (!s || s === '-') return true;
  if (!s.includes('Mozilla/5.0')) return true;
  return BOT_RE.test(s);
}

/** 站点绝对地址，用于邮件里的确认链接；优先取后台配置 */
export function siteUrl(c: Context): string {
  const env = c.env as { SITE_URL?: string };
  return (env.SITE_URL ?? new URL(c.req.url).origin).replace(/\/+$/, '');
}

export function referrerHost(referrer: string | undefined): string {
  if (!referrer) return '';
  try {
    return new URL(referrer).host;
  } catch {
    return '';
  }
}
