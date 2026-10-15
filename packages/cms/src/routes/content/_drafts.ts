/**
 * 文章编辑器的「保存本地」队列。
 *
 * 交互：编辑完点「保存本地」→ 存进浏览器 localStorage，不碰仓库；
 * 攒够几篇后点右上角常驻的「保存到 Git」→ 整批一次推送（POST /api/admin/content/batch）。
 * 只点「保存到 Git」而没先「保存本地」时，队列是空的，后端只会收到当前正在编辑的这一篇。
 *
 * 存的是"能直接提交的请求体"（front / body / 本地拼好的整篇 content / 打开文件时拿到的 sha），
 * 所以推送环节不需要再回到编辑器取一次值，切换文章、关掉后台都不影响已存的内容。
 */

export interface Draft {
  path: string;
  title: string;
  front: Record<string, unknown>;
  body: string;
  content: string;
  sha: string;
  notifySubscribers: boolean;
  savedAt: number;
}

const KEY = 'zero_cms_post_drafts_v1';

const canStore = (): boolean => typeof window !== 'undefined' && !!window.localStorage;

/** 读队列；解析失败当作没有暂存（不能让一个坏键把整个编辑页卡死） */
export function loadDrafts(): Draft[] {
  if (!canStore()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter((x): x is Draft => !!x && typeof (x as Draft).path === 'string' && typeof (x as Draft).content === 'string')
      .map((x) => ({ ...x, title: String(x.title ?? ''), savedAt: Number(x.savedAt ?? 0) }));
  } catch {
    return [];
  }
}

export function saveDrafts(list: Draft[]): void {
  if (!canStore()) return;
  try {
    if (list.length) window.localStorage.setItem(KEY, JSON.stringify(list));
    else window.localStorage.removeItem(KEY);
  } catch {
    /* 隐私模式或配额满：队列只在内存里，刷新会丢，界面照常可用 */
  }
}

/** 同一路径覆盖旧的暂存，并把它挪到列表末尾（推送顺序＝保存顺序） */
export function upsertDraft(list: Draft[], draft: Draft): Draft[] {
  return [...list.filter((x) => x.path !== draft.path), draft];
}

export function removeDraft(list: Draft[], path: string): Draft[] {
  return list.filter((x) => x.path !== path);
}

export function draftOf(list: Draft[], path: string): Draft | undefined {
  return list.find((x) => x.path === path);
}

export function formatSavedAt(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
