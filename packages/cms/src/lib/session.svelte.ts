import { get } from './api';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

class CmsSession {
  user = $state<AdminUser | null>(null);
  checked = $state(false);

  async refresh() {
    try {
      const d = await get<{ data: { user: AdminUser | null } }>('/api/auth/me');
      this.user = d.data.user;
    } catch {
      this.user = null;
    }
    this.checked = true;
  }

  logout() {
    this.user = null;
  }
}

export const session = new CmsSession();
