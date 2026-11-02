import { apiFetch, resolveBase } from './api';

/**
 * config.svelte.ts — 全站公开配置的共享只读缓存（GET /api/config）
 *
 * 后端 getPublicConfig 会把 'true'/'false' 转成布尔、纯数字转成数字，
 * 所以 commentShowMeta 拿到的是 boolean。
 * 五个 Custom Element 共用一份，同一个 apiBase 只请求一次。
 */

export type ConfigValue = string | number | boolean;

function truthy(v: ConfigValue | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return v === 'true' || v === '1';
}

class CommentConfig {
  data = $state<Record<string, ConfigValue> | null>(null);
  loaded = $state(false);
  base = '';
  #pending: Promise<void> | null = null;

  /** 后台 commentShowMeta：控制属地 / 浏览器 / 系统 / 设备的显隐，拿不到配置时默认显示 */
  get showMeta(): boolean {
    return truthy(this.data?.commentShowMeta, true);
  }

  get likeEnabled(): boolean {
    return truthy(this.data?.likeEnabled, true);
  }

  /**
   * 后台「注册用户可登录」（readerLoginEnabled）：评论区的「登录」入口跟着它，
   * 而不是跟「允许注册」—— 关掉注册不等于关掉老用户的登录门。
   * 拿不到配置时按 true 兜底：登录页自己还会再校验一次策略，别把入口整个藏掉。
   */
  get readerLoginEnabled(): boolean {
    return truthy(this.data?.readerLoginEnabled, true);
  }

  /**
   * 后台 accountSystemEnabled：前台账号系统的总开关（导航账号入口、账号页都跟着它）。
   * 关掉时整站没有可登录的地方，评论区的「登录」按钮与注册引导必须一起藏掉，
   * 否则游客点进去只会撞到一个关着的页面。拿不到配置时按 true 兜底。
   */
  get accountSystemEnabled(): boolean {
    return truthy(this.data?.accountSystemEnabled, true);
  }

  load(apiBase?: string): Promise<void> {
    const b = resolveBase(apiBase);
    if (!b) return Promise.resolve();
    if (this.base === b && (this.loaded || this.#pending)) return this.#pending ?? Promise.resolve();
    this.base = b;
    this.#pending = apiFetch<{ data: Record<string, ConfigValue> }>(b, '/api/config')
      .then((d) => {
        this.data = d?.data ?? {};
        this.loaded = true;
      })
      .catch(() => {
        // 配置拿不到就退回兜底：属地默认显示、表情用内置那份
        this.data = this.data ?? null;
        this.loaded = true;
      })
      .finally(() => {
        this.#pending = null;
      });
    return this.#pending;
  }
}

export const commentConfig = new CommentConfig();
