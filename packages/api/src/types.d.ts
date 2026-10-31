/**
 * 环境绑定与全局类型。纯声明文件：不写 import / export，
 * 这样其中的 interface 与 type 才是真正的全局名字，路由里无需反复引入。
 */
/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  R2: R2Bucket;
  /**
   * 公开桶（绑了自定义域名后图片走直链）。可选：老部署的 wrangler.jsonc 里没这条绑定，
   * 媒体库按 mediaBuckets 里的 binding 名取桶，取不到才退回 R2。
   */
  R2_PUBLIC?: R2Bucket;
  /** 只读缓存：站点配置、友链列表等 */
  CACHE: KVNamespace;
  /** 会话与限流计数 */
  SESSION: KVNamespace;
  /** 邮件出站队列，消费者是本 Worker 的 queue handler */
  EMAIL_QUEUE: Queue<EmailJob>;

  /* wrangler vars：默认值，可被 site_config 表覆盖 */
  ENVIRONMENT?: string;
  SITE_NAME?: string;
  SITE_URL?: string;
  COMMENT_MAX_DEPTH?: string;
  ALLOWED_ORIGINS?: string;

  /* secrets（wrangler secret put） */
  AUTH_SECRET?: string;
  SESSION_SECRET?: string;
  SMTP_PASSWORD?: string;
  RESEND_API_KEY?: string;
  CF_ACCOUNT_ID?: string;
  CF_EMAIL_API_TOKEN?: string;
  /** 允许 zero-cms 通过 API 提交内容到 Git */
  GITHUB_TOKEN?: string;
  /**
   * GitHub OAuth 登录 / 账号绑定（/api/security/github/*，注意前缀不是 /api/auth）。
   * 三项缺一，接口就返回 503（这项没开通）并说明缺哪一项，不会静默退回密码登录。
   *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET：GitHub OAuth App 的凭据
   *   GITHUB_REDIRECT_URI：形如 https://你的域名/api/security/github/callback，
   *                        必须与 OAuth App 里登记的回调地址完全一致
   */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_REDIRECT_URI?: string;

  /* 内容仓库默认值，同样可被 site_config 覆盖 */
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
}

/** 邮件出站队列的消息体 */
interface EmailJob {
  to: string;
  subject: string;
  html: string;
  from?: string;
  /** email_logs 里入队时就写好的那一行：消费者更新它，不再新插一行 */
  logId?: string;
  html: string;
  from?: string;
  /** 关联的文章标识，用于群发去重 */
  postId?: string;
  /** 确认 / 找回密码 / 新文章群发 / 即时通知 */
  kind?: 'confirm' | 'reset' | 'broadcast' | 'notice';
}

type EmailProvider = 'smtp' | 'resend' | 'cloudflare';

/** Hono 全站统一的上下文类型 */
type AppEnv = {
  Bindings: Env;
  Variables: { user: import('./services/auth').AuthUser | null };
};
