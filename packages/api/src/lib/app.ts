import type { AuthUser } from '../services/auth';

/** Hono 全站统一类型：绑定 Env，挂载可选登录用户 */
export type AppEnv = {
  Bindings: Env;
  Variables: { user: AuthUser | null };
};
