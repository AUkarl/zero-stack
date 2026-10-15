import { tr } from './i18n';

export function resolveBase(explicit?: string): string {
  const g = (globalThis as { ZERO_COMMENT_API_BASE?: string }).ZERO_COMMENT_API_BASE;
  return (explicit || g || '').replace(/\/+$/, '');
}

export async function apiFetch<T = any>(b: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(b + path, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && (data.message || data.error)) || `请求失败 (${res.status})`);
  return data as T;
}

/**
 * 与后端 canonSlug() 同族的最小归一：解码 → 补前导 / → 去尾随 / → 折叠重复斜杠。
 * ownerKey 在 localStorage 里按文章分组，分组键必须先归一，
 * 否则同一个页面用 /posts/x 与 /posts/x/ 两种写法就会存成两份。
 */
export function canonSlug(raw: string): string {
  let s = String(raw ?? '')
    .trim()
    .replace(/[?#].*$/, '');
  s = s
    .split('/')
    .map((seg) => {
      if (!seg.includes('%')) return seg;
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
  s = s.replace(/\/{2,}/g, '/');
  if (s && !s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+$/, '');
  return s || '/';
}

/** 相对时间；lang 以 en 开头时出英文，其余走中文（与后端无关，纯展示） */
export function timeAgo(ts: number, lang?: string): string {
  const t = tr(lang);
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 60) return t('justNow');
  if (diff < 3600) return t('minutesAgo', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('hoursAgo', { n: Math.floor(diff / 3600) });
  if (diff < 2592000) return t('daysAgo', { n: Math.floor(diff / 86400) });
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
