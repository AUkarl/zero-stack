import { get, siteOf } from './api';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

class CmsSession {
  user = $state<AdminUser | null>(null);
  checked = $state(false);
  /**
   * 站点前台地址（配置键 siteUrl，去掉尾部斜杠）。
   * 后台里每一条「去前台看这篇文章 / 这个用户」的链接都必须拼它：
   * 直接写 /posts/xxx 会在后台自己的域名下解析，落到 Pages 的 404（还带着后端的错误模板）。
   * 取不到就是空串，调用方据此降级成纯文本，不给坏链接。
   */
  site = $state('');

  async refresh() {
    try {
      const d = await get<{ data: { user: AdminUser | null } }>('/api/auth/me');
      this.user = d.data.user;
    } catch {
      this.user = null;
    }
    // 公开配置，跟着这次会话检查一起取，省得每个页面各拉一遍 siteUrl
    try {
      const c = await get<{ data: { siteUrl?: string } }>('/api/config');
      this.site = (c.data?.siteUrl ?? '').trim().replace(/\/+$/, '');
    } catch {
      this.site = '';
    }
    this.checked = true;
  }

  logout() {
    this.user = null;
    this.site = '';
  }
}

export const session = new CmsSession();

/** 前台页面的完整地址；siteUrl 没配时返回空串，调用方要降级成纯文本 */
export function frontUrl(path: string): string {
  return siteOf(session.site, path);
}
