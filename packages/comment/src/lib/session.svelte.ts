import { apiFetch, resolveBase } from './api';

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

/** 跨 Custom Element 共享的会话状态：同一模块实例被各元素导入 */
class Session {
  user = $state<User | null>(null);
  ready = $state(false);
  apiBase = $state('');

  constructor() {
    $effect.root(() => {
      $effect(() => {
        if (this.apiBase) void this.#load();
      });
    });
  }

  async #load() {
    try {
      const d = await apiFetch<{ data?: { user?: User | null } }>(this.apiBase, '/api/auth/me');
      this.user = d?.data?.user ?? null;
    } catch {
      this.user = null;
    }
    this.ready = true;
  }

  init(apiBase?: string) {
    const b = resolveBase(apiBase);
    if (b && b !== this.apiBase) this.apiBase = b;
  }

  isAdmin() {
    return this.user?.role === 'admin';
  }
}

export const session = new Session();
