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
 * 搜索引擎 / 社交爬虫 / 监控探针 / 空 UA 的请求不算浏览量。
 *
 * 之前 /api/analytics/beat 谁来都记一行，Pages 的爬虫与 Uptime 监控会把热门页 Top 与
 * 浏览量抬到虚高（同一台机器每秒一次、一天就是几万次）。判据只看 User-Agent，
 * 成本一次正则；漏掉的少数伪装 UA 交给「按访客去重」那套口径兜。
 */
const BOT_RE =
  /bot|crawler|spider|slurp|curl|wget|python-requests|httpie|go-http-client|java\/|okhttp|headlesschrome|phantomjs|lighthouse|pagespeed|pingdom|uptime|monitor|newman|postmanruntime|feedfetcher|rss|archive|ahrefs|semrush|mj12|dotpet|baidujapan|yandex|sogou|360spider|googleweblight|miniflux|fever|reeder|neteasefetcher|bingpreview|facebookexternalhit|telegrambot|whatsapp|slackbot|discordbot|line-pk/i;

export function isBot(ua: string | undefined | null): boolean {
  const s = String(ua ?? '').trim();
  if (!s || s === '-') return true;
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
