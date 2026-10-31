/**
 * 文章文件名（落到内容仓库的那个 `<名>.md`）的同一套规矩，投稿链路与后台新建文章共用。
 *
 * 口径（站长定的）：**填了文件名就按填的，没填一律「发布那天 YYYYMMDD + 当天三位顺序号」**。
 * 以前两条路各走各的：投稿走日期序号，后台新建文章拿标题当文件名（中文标题就出中文文件名），
 * 两种形状并存；而标题里带着一长串数字时，旧的「算不算日期序号」判据会把它认成已经改过名，
 * 于是那串数字直接变成文件名与地址（T2 体检报告 §6 P3-7）。
 */
import { getConfig } from '../services/config';
import { listRepoDir } from '../services/repo';

/** 「日期 + 序号」那种自动名：20261021001 */
/**
 * 发布那天的键（YYYYMMDD）。日子按站点自己的时区算 —— 复用统计那套 `statsUtcOffsetHours`
 * （默认东八区），不然北京时间早上七点发的那篇会被算进前一天，文件名和站点显示的日期不一致。
 */
export async function dayKey(env: Env): Promise<string> {
  const raw = Number(await getConfig(env, 'statsUtcOffsetHours'));
  const offset = Number.isFinite(raw) ? Math.min(14, Math.max(-12, Math.trunc(raw))) : 8;
  const d = new Date(Date.now() + offset * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** 数出「今天这个目录里最大的序号 + 1」；列目录失败（没配仓库等）就返回 null，让调用方退回原标题名 */
export async function datedSlug(env: Env, dir: string): Promise<string | null> {
  const day = await dayKey(env);
  let names: string[];
  try {
    names = (await listRepoDir(env, dir)).map((e) => String(e.name ?? ''));
  } catch {
    return null;
  }
  let max = 0;
  for (const name of names) {
    const hit = new RegExp(`^${day}(\\d{3,})\\.md$`).exec(name);
    if (hit) max = Math.max(max, Number(hit[1]));
  }
  return `${day}${String(max + 1).padStart(3, '0')}`;
}

/** 站内保留的占位前缀：投稿没填文件名时先挂这个，发布那一刻换成当天的自动名 */
export const PLACEHOLDER_PREFIX = 'draft-';

/**
 * 作者自己填的文件名能不能用。与后台写文章同一套判法：**只拒目录穿越与控制/保留字符，
 * 中文与全角标点放行**（拒中文的话，「标题即文件名」那条习惯就只能退回拼音或日期）。
 *
 * 返回 null 表示可用（已去掉首尾空白与 `.md`），否则是一句能直接给人看的理由。
 */
export function fileNameProblem(raw: string): string | null {
  const v = String(raw ?? '').trim().replace(/\.md$/i, '');
  if (!v) return '文件名留空就行，会自动用「发布那天 + 当天序号」；要自己起名就别只填空白或 .md';
  if (v.length > 80) return `文件名最长 80 个字符（现在 ${v.length} 个）`;
  if (v.includes('/') || v.includes('\\')) return '文件名里不能有斜杠，目录由系统按文章目录决定';
  if (v === '.' || v === '..') return '文件名不能是 . 或 ..';
  if (/[\u0000-\u001f<>:"|?*]/.test(v)) return '文件名含有系统保留字符（<>:"|?* 与控制字符）';
  if (/^\.|^~|~$/.test(v)) return '文件名首尾不要用 . 或 ~（Hugo 与编辑器会当成隐藏文件或备份文件）';
  return null;
}

/** 把作者填的名字收成能落盘的形式：去空白、去 .md 后缀 */
export function normalizeFileName(raw: string): string {
  return String(raw ?? '').trim().replace(/\.md$/i, '');
}
