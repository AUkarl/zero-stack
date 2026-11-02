import { getConfig } from './config';
import { fetchWithTimeout } from '../lib/fetch';

/**
 * Cloudflare 边缘缓存按 URL 清除（Purge Cache）。
 *
 * 为什么删完文章还要这一步：重建只换掉**源站**那一份 HTML，Cloudflare 边缘上那条地址
 * 还留着它自己缓存的旧副本 —— 用户拿到的是 CDN 命中（响应头 cf-cache-status: HIT 就是
 * 这件事的凭据），连强刷都刷不掉，因为他请求的是边缘。仓库里的 markdown 删了、站点也
 * 重建了，边缘那一层照旧把旧的 index.html 端出来。所以删除接口在重建之后还要清一次边缘。
 * （浏览器侧的 HTML 已经由 _headers 成 max-age=0, must-revalidate，那是防「老访客停在旧页」，
 *   管不到边缘这一份。）
 *
 * 只清被删的那几条地址（同一篇文章的带斜杠与不带斜杠两种写法），绝不调 purge_everything：
 * 整站清空会让后面每个访问都回源，免费计划的配额与首屏速度都吃亏。
 *
 * 凭据是后台「设置 → 内容仓库」里的 cfZoneId + cfPurgeToken（令牌只写不回读）。
 * 没配时不报错，而是回一句带具体地址的说明：删都已经删了，让人知道接下来还差一步就行。
 */

export interface PurgeResult {
  /** 是否真的向 Cloudflare 发了请求（没配 zone / token 时是 false） */
  attempted: boolean;
  ok: boolean;
  detail: string;
  /** 这次要清（或本该清）的完整地址，界面上原样给人看 */
  urls: string[];
}

const skipped = (urls: string[], detail: string): PurgeResult => ({ attempted: false, ok: false, detail, urls });

export async function purgePageUrls(env: Env, webPaths: string[]): Promise<PurgeResult> {
  /* 只用站点前台域名：Pages 的 HTML 只在那一个域名下。曾经这里用的是 apiBase()，
     而 apiBaseUrl 优先 —— 那个是接口域名（后台登录过一次、订阅者点过确认链接就会被自动记下），
     结果是「删了文章、清掉了接口域名下一条根本不存在的地址」，边缘那条旧 HTML 照旧端给访客。 */
  const base = (((await getConfig(env, 'siteUrl')) ?? env.SITE_URL ?? '').trim()).replace(/\/+$/, '');
  if (!base) return skipped([], '站点地址（siteUrl）没配，不知道该清哪条 URL —— 请到后台「设置 → 站点信息」填站点域名后重新删除，或在 Cloudflare 控制台手动清');
  const urls = [...new Set(webPaths.filter(Boolean).map((p) => `${base}/${String(p).replace(/^\/+|\/+$/g, '')}/`))];
  if (!urls.length) return skipped([], '没有要清除的地址');

  const zone = (await getConfig(env, 'cfZoneId'))?.trim();
  const token = (await getConfig(env, 'cfPurgeToken'))?.trim();
  if (!zone || !token) {
    return skipped(
      urls,
      `没配 Cloudflare 的 cfZoneId / cfPurgeToken，这一条缓存还留在边缘：请到 Cloudflare 控制台「${zoneDomain(zone)} → 缓存 → 清除缓存 → 自定义缓存清除」里粘贴下面这行地址清掉，或直接把这条地址发给访客让他们清自己的浏览器（后者通常没用，因为是 CDN 命中）：${urls.join('  ')}`,
    );
  }

  try {
    const res = await fetchWithTimeout(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone)}/purge_cache`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: urls }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: { message?: string }[] } | null;
    if (!res.ok || body?.success === false) {
      const why = body?.errors?.[0]?.message || `HTTP ${res.status}`;
      return { attempted: true, ok: false, detail: `Cloudflare 没接受这次清除：${why}`, urls };
    }
    return { attempted: true, ok: true, detail: `已清除 ${urls.length} 条地址的边缘缓存`, urls };
  } catch (e) {
    return { attempted: true, ok: false, detail: `清除请求失败：${e instanceof Error ? e.message : String(e)}`, urls };
  }
}

/** 提示语里那句「到控制台哪里点」：配了 zone 就直接说那一段没配，没配就说整个开关 */
function zoneDomain(zone: string | undefined): string {
  return zone?.trim() ? '对应域名（zone）' : '站点域名（cfZoneId 那一栏的域名）';
}
