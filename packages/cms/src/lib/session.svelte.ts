import { assetSrc, get, siteOf } from './api';

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
   * 会话检查已经等了几秒还没回来 —— workers.dev 在国内经常要等十几秒，
   * 以前界面上就是一句「正在验证登录状态…」一直挂着，用户以为坏了（站主第 12 条）。
   * 到点改成说清楚在等哪个地址，并给重试与去登录页两个出口。
   */
  slow = $state(false);
  /**
   * 站点前台地址（配置键 siteUrl，去掉尾部斜杠）。
   * 后台里每一条「去前台看这篇文章 / 这个用户」的链接都必须拼它：
   * 直接写 /posts/xxx 会在后台自己的域名下解析，落到 Pages 的 404（还带着后端的错误模板）。
   * 取不到就是空串，调用方据此降级成纯文本，不给坏链接。
   */
  site = $state('');
  private timer: ReturnType<typeof setTimeout> | null = null;

  async refresh() {
    this.slow = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => (this.slow = true), 4000);
    /* 两个请求一前一后，不并发：并发版实测在本地这套 dev 代理上会让其中一个挂住不回，
       开屏那句「正在验证登录状态」就一直挂着（第八轮 c9 第 3.1 条抓到，串行 64/64 全过）。
       省一个来回不值这个风险 —— 第 12 条的慢是 API 地址指到 workers.dev 造成的，已经按自定义域部署修好。 */
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.slow = false;
    this.checked = true;
  }

  logout() {
    this.user = null;
    this.site = '';
  }
}

export const session = new CmsSession();

/** 前台页面的完整地址；siteUrl 没配时返回空串，调用方要降级成纯文本。时刻的挂载键在 siteOf 里换成锚点 */
export function frontUrl(path: string): string {
  return siteOf(session.site, path);
}

/** 后台预览图片的地址（站内相对路径拼上站点域名）；见 api.ts 里 assetSrc 的说明 */
export function assetUrl(value: string | null | undefined): string {
  return assetSrc(session.site, value);
}
