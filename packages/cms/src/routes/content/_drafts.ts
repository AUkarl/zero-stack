/**
 * 文章编辑器的「存草稿」队列（存在私有 R2 桶里）。
 *
 * 交互：编辑完点「存草稿」→ PUT /api/admin/article-drafts，同一篇文章只占一个对象
 * （键里带文章路径，再存就是覆盖，不会改一次多一个文件），不碰内容仓库；
 * 攒够几篇后点右上角「保存到 Git」→ 整批一次推送（POST /api/admin/content/batch），
 * 推成功的从草稿箱删掉。
 *
 * 存的是"能直接提交的请求体"（front / body / 本地拼好的整篇 content / 打开文件时拿到的 sha），
 * 所以推送环节不需要再回到编辑器取一次值。
 *
 * 列表接口只回元数据（路径、标题、保存时间、字节数），正文按需再取 ——
 * 否则十几篇草稿一次拉下来，打开后台就先卡一下。
 */
import { del, get, put } from '#lib/api';

export interface DraftMeta {
  path: string;
  title: string;
  savedAt: number;
  bytes: number;
  notifySubscribers?: boolean;
}

export interface Draft extends DraftMeta {
  front: Record<string, unknown>;
  body: string;
  content: string;
  sha: string;
  notifySubscribers: boolean;
}

/** 旧的浏览器本地队列：只用来把之前攒的草稿导入云端，导入后清掉 */
const LEGACY_KEY = 'zero_cms_post_drafts_v1';

export async function loadDrafts(): Promise<DraftMeta[]> {
  const d = await get<{ data: { items: DraftMeta[] } }>('/api/admin/article-drafts');
  return (d.data?.items ?? []).map((x) => ({ ...x, title: String(x.title ?? ''), savedAt: Number(x.savedAt ?? 0), bytes: Number(x.bytes ?? 0) }));
}

export async function fetchDraft(path: string): Promise<Draft> {
  const d = await get<{ data: Draft }>(`/api/admin/article-drafts?path=${encodeURIComponent(path)}`);
  return d.data;
}

export async function saveDraft(draft: Omit<Draft, 'savedAt' | 'bytes'>): Promise<DraftMeta> {
  const d = await put<{ data: { path: string; savedAt: number } }>('/api/admin/article-drafts', draft);
  return { path: d.data.path, title: draft.title, savedAt: d.data.savedAt, bytes: draft.content.length, notifySubscribers: !!draft.notifySubscribers };
}

export async function deleteDraft(path: string): Promise<void> {
  await del(`/api/admin/article-drafts?path=${encodeURIComponent(path)}`);
}

/** 同一路径覆盖旧的，并挪到列表末尾（推送顺序＝保存顺序） */
export function upsertDraft(list: DraftMeta[], meta: DraftMeta): DraftMeta[] {
  return [...list.filter((x) => x.path !== meta.path), meta];
}

export function draftOf(list: DraftMeta[], path: string): DraftMeta | undefined {
  return list.find((x) => x.path === path);
}

/** 老版本留在 localStorage 里的草稿（只用于导入；没有就回空数组） */
export function legacyDrafts(): Draft[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((x): x is Draft => !!x && typeof (x as Draft).path === 'string' && typeof (x as Draft).content === 'string')
      .map((x) => ({ ...x, title: String(x.title ?? ''), savedAt: Number(x.savedAt ?? 0) }));
  } catch {
    return [];
  }
}

export function clearLegacyDrafts(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* 隐私模式写不了，下次再提示一次也无妨 */
  }
}

export function formatSavedAt(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
