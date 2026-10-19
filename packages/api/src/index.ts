import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware, requireAdmin } from './middleware/auth';
import comments from './routes/comments';
import auth from './routes/auth';
import likes from './routes/likes';
import subscribe from './routes/subscribe';
import moments from './routes/moments';
import friends from './routes/friends';
import analytics from './routes/analytics';
import admin from './routes/admin';
import invites from './routes/invites';
import users from './routes/users';
import userCenter, { authorsPublic } from './routes/user';
import { authorsAdmin, draftsAdmin } from './routes/reviews';
import applications, { publicApp as publicApply } from './routes/applications';
import translate from './routes/translate';
import backup from './routes/backup';
import frontendAdmin from './routes/frontend';
import publicMedia from './routes/media';
import account, { deletionsAdmin } from './routes/account';
import security from './routes/security';
import broadcastJobs from './routes/broadcast';
import { getAllowedOrigins, getConfig, getPublicConfig, getAdminContactEmail } from './services/config';
import { rateLimit } from './lib/rate-limit';
import { errorMessage } from './lib/errors';
import type { AppEnv } from './lib/app';
import { runScheduledJobs } from './services/scheduler';
import { handleEmailBatch } from './services/email-queue';

const app = new Hono<AppEnv>();

/* ---------------- CORS：白名单来自 vars，未配置则只允许同源与本地 ---------------- */

/** 这个来源能不能带凭据来：白名单写了 * 、就是本站自己、或是本地开发端口 */
function isAllowedOrigin(origin: string, allowed: string[], self: string): boolean {
  if (allowed.includes('*')) return true;
  if (origin === self) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return allowed.includes(origin);
}

/**
 * 被拒的跨源请求不能留下「可以带凭据」这个信号。hono 的 cors 在 origin 不匹配时
 * 只是不回 Access-Control-Allow-Origin，凭据头却照样挂着 —— 浏览器确实拦住了，
 * 但以后谁改这段中间件时照着「有 creds 就是允许」判断就会踩坑，所以在这里抹平。
 * 必须注册在 cors **外面**（先 use）：cors 是在它自己的 next() 返回之后才写头的，
 * 排在其后的中间件看到的还是旧头。
 */
app.use('*', async (c, next) => {
  await next();
  if (!c.res.headers.get('Access-Control-Allow-Origin')) c.res.headers.delete('Access-Control-Allow-Credentials');
});

app.use('*', async (c, next) => {
  const allowed = await getAllowedOrigins(c.env);
  const self = new URL(c.req.url).origin;
  return cors({
    origin: (origin) => {
      if (!origin) return null;
      return isAllowedOrigin(origin, allowed, self) ? origin : null;
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  })(c, next);
});

/* ---------------- 安全响应头（CSP 暂不做：要先给 Font Awesome 的 onload、百度系
   之外的第三方播放器等开白名单，配漏一项就是整站样式或评论挂掉，单独排期） ---------------- */

app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Worker 只出 JSON 与错误页，不该被任何页面框住，也不该拿到摄像头/定位这类能力
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), fullscreen=(self)');
});

/* ---------------- 会话解析：所有路由都能拿到可选的 user ---------------- */

app.use('*', authMiddleware);

app.get('/api/health', async (c) => {
  const env = c.env;
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    const row = await env.DB.prepare('select count(*) as n from users').first<{ n: number }>();
    checks.d1 = { ok: true, detail: `users=${row?.n ?? 0}` };
  } catch (e) {
    checks.d1 = { ok: false, detail: errorMessage(e) };
  }

  try {
    await env.CACHE.get('__probe__');
    checks.kv = { ok: true };
  } catch (e) {
    checks.kv = { ok: false, detail: errorMessage(e) };
  }

  try {
    await env.R2.head('__probe__');
    checks.r2 = { ok: true };
  } catch (e) {
    checks.r2 = { ok: false, detail: errorMessage(e) };
  }

  checks.email = {
    ok: Boolean(env.SMTP_PASSWORD || env.RESEND_API_KEY || (await getConfig(env, 'smtpPassword')) || (await getConfig(env, 'resendApiKey'))),
    detail: 'SMTP / Resend 任一可用即可：密钥可以后台填，也可以用 wrangler secret（SMTP_PASSWORD / RESEND_API_KEY）',
  };
  checks.queue = { ok: Boolean(env.EMAIL_QUEUE) };
  checks.secret = { ok: Boolean(env.SESSION_SECRET && env.AUTH_SECRET) };

  // 头像哈希依赖运行时 MD5，先探测，免得部署后才发现不支持
  try {
    const digest = await crypto.subtle.digest('MD5', new TextEncoder().encode('abc'));
    checks.md5 = { ok: new Uint8Array(digest).length === 16 };
  } catch {
    checks.md5 = { ok: false, detail: '运行时不支持 MD5，需改用其它头像模板' };
  }

  const broken = Object.entries(checks).filter(([, v]) => !v.ok);
  return Response.json({
    ok: broken.length === 0,
    runtime: 'cloudflare-workers',
    environment: env.ENVIRONMENT ?? 'development',
    time: new Date().toISOString(),
    checks,
    broken: broken.map(([k]) => k),
  });
});

app.route('/api/comments', comments);
app.route('/api/auth', auth);
app.route('/api/reactions', likes);
app.route('/api/subscribe', subscribe);
app.route('/api/moments', moments);
app.route('/api/friends', friends);
app.route('/api/friends', publicApply);
app.route('/api/authors', authorsPublic);
app.route('/api/analytics', analytics);
app.route('/api/media', publicMedia);

app.get('/api/config', (c) => getPublicConfig(c.env).then((data) => Response.json({ data })));

/**
 * 站长联系邮箱：只在访客真打开「找回密码」面板时才给，不再混在整站公开配置里
 * （Cloudflare 的邮箱保护只改写 HTML，curl 这个接口就是明文）。
 * 限流按 IP 每小时 30 次，够一个正常用户反复开关面板，不够爬一趟名单。
 */
app.get('/api/config/admin-email', async (c) => {
  await rateLimit(c, 'admin-email', 30, 3600);
  const email = await getAdminContactEmail(c.env);
  return Response.json({ data: { email } }, { headers: { 'Cache-Control': 'no-store' } });
});

/* ---------------- 后台：需管理员 ---------------- */

app.use('/api/admin/*', async (c, next) => {
  requireAdmin(c);
  await next();
});
app.route('/api/admin', admin);
app.route('/api/admin/broadcast', broadcastJobs);
app.route('/api/admin/invites', invites);
app.route('/api/admin/users', users);
app.route('/api/admin/applications', applications);
app.route('/api/admin/translate', translate);
app.route('/api/admin/backup', backup);
app.route('/api/admin/frontend', frontendAdmin);
app.route('/api/admin/drafts', draftsAdmin);
app.route('/api/admin/author-requests', authorsAdmin);

/* ---------------- 用户中心：需登录，权限位在各接口内部逐条判定 ---------------- */

app.route('/api/user', userCenter);
app.route('/api/account', account);
app.route('/api/admin/deletions', deletionsAdmin);
app.route('/api/security', security);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error('[zero-api]', err);
  return Response.json({ error: 500, message: errorMessage(err) }, { status: 500 });
});

app.notFound(() => Response.json({ error: 404, message: '接口不存在' }, { status: 404 }));

/** Cron 与队列的入参类型（不引 DOM 事件定义，字段按需取） */
interface CronEvent {
  cron: string;
  scheduledTime: number;
  noRetry?: () => void;
  waitUntil?: (p: Promise<unknown>) => void;
}

export default {
  fetch: app.fetch,

  scheduled: async (event: CronEvent, env: Env) => {
    await runScheduledJobs(env, event.cron);
  },

  queue: async (batch: MessageBatch<EmailJob>, env: Env) => {
    await handleEmailBatch(batch, env);
  },
} satisfies ExportedHandler<Env, EmailJob>;

