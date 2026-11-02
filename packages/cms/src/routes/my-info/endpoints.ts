/**
 * my-info 页的接口清单：路径与字段名逐条对着 packages/api 源码写死，
 * 改任何一条前先确认源码（routes/security.ts、routes/account.ts、routes/auth.ts、
 * routes/user.ts、routes/admin.ts、services/account-shared.ts）。
 *
 * security 路由挂在 /api/security（index.ts: app.route('/api/security', security)），
 * 概览是它自身的 '/'，所以完整路径就是 GET /api/security。
 */

export const EP = {
  /** GET 安全概览（昵称/邮箱/账号标识/用户组/凭据状态/可用二次凭据/策略） */
  securityOverview: '/api/security',
  /** GET 验证器状态（概览已含，保留给需要单独复查时用） */
  totpStatus: '/api/security/totp/status',
  totpSetup: '/api/security/totp/setup',
  totpEnable: '/api/security/totp/enable',
  totpDisable: '/api/security/totp/disable',
  githubStart: '/api/security/github/start',
  githubStatus: '/api/security/github/status',
  githubUnbind: '/api/security/github/unbind',
  /** POST 管理员改自己的用户组：{ userGroup }，取值 owner | friend | coauthor（只允许管理员本人） */
  securityGroup: '/api/security/group',
  /** GET / PUT 站长本人的作者资料（data/authors.yaml 里自己那一条） */
  authorsMe: '/api/admin/authors/me',
  /** POST 改密码唯一入口：{ current, next, second, code? } */
  password: '/api/account/password',
  /** POST 发验证码：{ email, scene: 'register'|'login'|'reset'|'password' } */
  sendCode: '/api/auth/send-code',
  permissions: '/api/user/permissions',
  profile: '/api/user/profile',
  /** PATCH 站点登录策略与 TOTP 签发者 */
  config: '/api/admin/config',
  /** GET 查进度 / POST 申请注销：{ reason, confirm } */
  /** 站主审核入口（本页只做申请，不做审核 UI） */
} as const;

/** 后端错误响应固定是 { error, message }；401 被 lib/api.ts 折成 AUTH_EXPIRED */
export function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === 'AUTH_EXPIRED') return '请先登录后台';
  return msg || '后端没有返回错误说明';
}

/** services/account-shared.ts 的 LOGIN_POLICIES，顺序与取值都照抄 */
export const LOGIN_POLICIES = ['password', 'password+totp', 'github', 'password+email-code'] as const;

export const POLICY_LABELS: Record<string, string> = {
  password: '单密码',
  'password+totp': '密码 + 身份验证器',
  github: 'GitHub 登录',
  'password+email-code': '密码 + 邮箱验证码',
};

