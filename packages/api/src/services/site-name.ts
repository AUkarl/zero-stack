/**
 * site-name.ts — 站点名的**唯一**取法。
 *
 * 为什么要单独一个文件：这个名字以前有两个存放处，却只有一处能改。
 *   · D1 的 site_config.siteName —— 邮件标题、验证码信、评论通知、后台署名都读它；
 *   · 内容仓 data/site.json 的 name —— 后台「前端管理 → 基本信息」里能改的就是这一份，前台 <title> 也用它。
 * 界面上没有改前者的入口，所以一座按 README 装好的新站，所有邮件标题都是「【Zero】…」。
 * （站长本人的站恰好早期通过接口设过 siteName，所以一直没暴露。）
 *
 * 顺序按「谁显式说过话」来：D1 设过就用 D1（不推翻已有站点的选择），
 * 否则用站主在后台真改过的那一份，最后才回落 'Zero'。
 */
import { getConfig } from './config';
import { readRepoFile } from './repo';

/** isolate 内 60 秒缓存：一封群发里会取好几次站点名，没必要每封都回仓库读 */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: string }>();

/**
 * 站主真说过的名字；没有则空串。
 * 作者署名那条兜底链要用它——那里返回 'Zero' 会变成「作者：Zero」，比留空更糟。
 */
export async function configuredSiteName(env: Env): Promise<string> {
  const explicit = ((await getConfig(env, 'siteName')) ?? '').trim();
  if (explicit) return explicit;

  const hit = cache.get('name');
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let value = '';
  try {
    const dir = ((await getConfig(env, 'githubDataDir')) ?? '').trim() || 'data';
    const file = await readRepoFile(env, `${dir}/site.json`).catch(() => null);
    if (file?.content) {
      const parsed = JSON.parse(file.content) as { name?: unknown; navName?: unknown };
      value = String(parsed?.name ?? '').trim() || String(parsed?.navName ?? '').trim();
    }
  } catch {
    /* 仓库没配、文件读不到或不是合法 JSON：都当成没改过 */
  }
  cache.set('name', { at: Date.now(), value });
  return value;
}

/** 带 'Zero' 兜底的版本：邮件标题、验证码信、TOTP 发行方这类「必须有字」的地方用它 */
export async function resolveSiteName(env: Env): Promise<string> {
  return (await configuredSiteName(env)) || 'Zero';
}

/** 站点段被后台改过之后调用，免得 60 秒内还按老名字发信 */
export function invalidateSiteNameCache(): void {
  cache.clear();
}
