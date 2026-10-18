import { browser } from '$app/env';

export function getApiBase(): string {
  if (!browser) return '';
  return (localStorage.getItem('zero_api_base') || import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
}

export function setApiBase(value: string): void {
  if (!browser) return;
  localStorage.setItem('zero_api_base', value.trim().replace(/\/+$/, ''));
}

/** 后端错误固定是 { error, message, ...extra }；extra 里可能带 next，用来告诉页面下一步要补什么凭据 */
export interface ApiError extends Error {
  body?: Record<string, unknown> | null;
}

function apiError(message: string, body: Record<string, unknown> | null): ApiError {
  const e = new Error(message) as ApiError;
  e.body = body;
  return e;
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  // 地址留空表示同源：本地开发走 vite 的 /api 代理，生产在登录页填 worker 域名
  const base = getApiBase();
  const res = await fetch(base + path, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    // 401 有两种：登录时凭据不对、以及会话过期。后端两种都回了人话，
    // 先用它的话术，只有拿不到 message 才退回 AUTH_EXPIRED 这个内部标记。
    const text = typeof data?.message === 'string' && data.message.trim() ? data.message.trim() : 'AUTH_EXPIRED';
    throw apiError(text, data);
  }
  if (!res.ok) {
    /* 地址留空 = 打到同源。这在 vite 开发服务器里有 /api 代理，在 Pages 上没有 ——
       结果是后台自己的 SPA 壳子回一个 404，看着像「接口不存在」。说白点让用户去填地址。 */
    if (!base && res.status === 404) {
      throw apiError('API 地址没填：Pages 部署没有 /api 代理，请在上方「API 地址」填 worker 域名（如 https://zero-api.xxx.workers.dev）', data);
    }
    throw apiError(data?.message || `请求失败 (${res.status})`, data);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown) =>
  api<T>(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const patch = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PATCH', body: JSON.stringify(body) });
export const put = <T = any>(p: string, body: unknown) => api<T>(p, { method: 'PUT', body: JSON.stringify(body) });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

/** DELETE /api/admin/content/file 与投稿撤回里那段 purge 的结果（没配 Cloudflare 时为 null） */
export interface PurgeOut {
  attempted: boolean;
  ok: boolean;
  detail: string;
  urls: string[];
}

/**
 * 删完文章在界面上补的那半句：缓存清没清、没清的话地址是什么。
 * 边缘缓存不清，用户看到的仍是「删了还能打开」，所以这句必须显眼地说出来，不能只躺在响应体里。
 */
export function purgeNote(p: PurgeOut | null | undefined): string {
  if (!p) return '';
  if (p.ok) return `；${p.detail}`;
  return `；边缘缓存没清掉（${p.detail}），在 Cloudflare 控制台「缓存 → 清除缓存 → 自定义缓存清除」里粘贴这行地址：${p.urls.join('  ')}`;
}

/**
 * 审核结果那封信的回执：已交给中继 / 只排进队列 / 失败，三种说法必须分开。
 * 以前只有一句「已发送邮件通知」，队列还没投、甚至已经 failed，界面照样报成功。
 */
export function mailNote(data: { state?: 'sent' | 'queued' | 'failed'; notifyError?: string | null } | null | undefined): string {
  if (!data || !data.state) return '';
  if (data.state === 'sent') return ' · 通知信已交给发信中继';
  if (data.state === 'queued') return ' · 通知信已排进发送队列，稍后投出（后台「订阅」页下方的邮件日志能核对结果）';
  return ` · 通知信没发出去${data.notifyError ? `：${data.notifyError}` : ''}`;
}

/** 站点绝对地址：后台显示的站内路径要点开就是真页面，没配 siteUrl 时返回空串（调用方降级成纯文本） */
export function siteOf(site: string | null | undefined, path: string): string {
  const base = (site ?? '').replace(/\/+$/, '');
  if (!base) return '';
  return base + (path.startsWith('/') ? path : '/' + path);
}

export function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function fmtDate(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
}
