import type { Context } from 'hono';

/** Cloudflare 提供的真实客户端 IP；本地 dev 时回退到占位值 */
export function clientIp(c: Context): string {
  const cf = c.req.raw.headers.get('cf-connecting-ip');
  if (cf) return cf;
  const env = c.env as { CF_CLIENT_IP_FALLBACK?: string };
  return env.CF_CLIENT_IP_FALLBACK ?? '203.0.113.1';
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
