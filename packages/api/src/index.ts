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
import buildReport from './routes/build-report';
import backup from './routes/backup';
import frontendAdmin from './routes/frontend';
import publicMedia from './routes/media';
import account, { deletionsAdmin } from './routes/account';
import security from './routes/security';
import broadcastJobs from './routes/broadcast';
import { getAllowedOrigins, getConfig, getPublicConfig, getAdminContactEmail, recordApiOrigin } from './services/config';
import { listBuckets } from './services/media';
import { rateLimit } from './lib/rate-limit';
import { errorMessage } from './lib/errors';
import type { AppEnv } from './lib/app';
import { runScheduledJobs } from './services/scheduler';
import { handleEmailBatch } from './services/email-queue';

const app = new Hono<AppEnv>();

/* ---------------- CORS：白名单来自 vars，未配置则只允许同源与本地 ---------------- */

/**
 * 这个来源能不能带凭据来：白名单写了 * 、就是本站自己、或是本地开发端口。
 *
 * 环回那条分支只在「本站自己也是环回地址」时才放行。以前它不分环境，
 * 于是线上 Worker 也对 http://localhost:任意端口 回 ACAO + Access-Control-Allow-Credentials: true
 * —— 访客本机只要跑着一个页面，就能带着 cookie 跨源打这个站。
 * 用 self 的 host 判断而不是读 ENVIRONMENT：真实部署的 self 是 https://api 域，自然不满足；
 * 本地 wrangler dev 的 self 是 http://127.0.0.1:8795，本地后台与前台跨端口带凭据照样能用，
 * 不需要谁再去设一个环境变量开关。
 */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function isAllowedOrigin(origin: string, allowed: string[], self: string): boolean {
  if (allowed.includes('*')) return true;
  if (origin === self) return true;
  if (LOOPBACK.test(origin) && LOOPBACK.test(self)) return true;
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
    /* 评论凭证这两个头是 R43 起前端改走请求头用的（以前挤在 ?owner= 查询串里，
       于是凭证会进浏览器历史、代理日志与任何记录完整 URL 的地方）。
       hono 的 cors 在预检里**只回这一份固定清单**，不在清单里的头会被浏览器拦下 ——
       前台域与接口域不同是默认部署形状，漏掉这一行等于把匿名访客的「编辑/删除自己的评论」改死
       （台架实测：带 X-Comment-Owner 的 DELETE 直接 Failed to fetch，而 ?owner= 那条 200）。
       允许的来源仍然只有 isAllowedOrigin 那一份名单，这里只是让被允许的前端能把头带上。 */
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Comment-Owner', 'X-Comment-Owners'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  })(c, next);
});

/* ---------------- 安全响应头 ----------------
 * CSP 分两档，按响应的 content-type 挑：
 *   · 接口绝大部分回 JSON / 图片 / 文件流 —— default-src 'none'，什么都不许加载。
 *     这一条挡的是「响应被当成页面打开」那一类：接口域名下永远不该有能取数据的脚本。
 *   · 只有两页真出 HTML（订阅确认 donePage、后台的邮件预览），它们整页靠 style="…" 与 <style> 排版，
 *     所以那一档放开 style-src 'unsafe-inline' 与图片，其余照旧全禁。
 * 前端页面自己往这些地址发请求时，受的是页面那份 CSP 的 connect-src 管，不是这份 ——
 * 接口回 default-src 'none' 不会拦下浏览器里对它的 fetch。
 */
const CSP_DATA = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const CSP_HTML = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

app.use('*', async (c, next) => {
  await next();
  const type = c.res.headers.get('content-type') ?? '';
  c.res.headers.set('Content-Security-Policy', type.includes('text/html') ? CSP_HTML : CSP_DATA);
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Worker 只出 JSON 与错误页，不该被任何页面框住，也不该拿到摄像头/定位这类能力
  c.res.headers.set('X-Frame-Options', 'DENY');
  /* 接口域同样不进索引：它有两页真出 HTML（订阅确认的 donePage、后台的邮件预览），
     而这两个地址都是「带一个 token/uuid 的一次性页面」，被收进搜索结果就是把订阅链接
     与邮件内容摆到外人面前。JSON 那一路本来也没索引价值，一起挂上，省得以后又新增一页 HTML 忘了。 */
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), fullscreen=(self)');
});

/* ---------------- 尾斜杠归一 ----------------
 * `/api/security` 通、`/api/security/` 回 404 这种事（台架 F-07）对写调用方的人是最费解的一类错：
 * 路径看着一模一样。按 REST 习惯带斜杠的人占多数，所以在这里归一而不是让它 404。
 * 用 308：方法与请求体都不改，客户端自动跟一次。`/api/media/<桶>/<键>` 那种键里带斜杠的不受影响
 * （它们的键不以斜杠结尾，且已由 checkMediaKey 挡过越界）。
 *
 * 位置必须在 cors 与安全头**之后**：hono 的这些中间件都是「等 next() 回来再写头」，
 * 谁排在它们前面就地返回，响应就绕过了它们。放前面时 308 上没有任何 CORS 头，
 * 而前台域与接口域不同是默认部署形状 —— 浏览器会把这个跳转整个拦掉，
 * 「归一」只对同源调用生效，跨源的人看到的还是 Failed to fetch（第一轮实测就是这个）。
 */
app.use('/api/*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.pathname === '/api/' || !url.pathname.endsWith('/')) return next();
  return c.redirect(`${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`, 308);
});

/* ---------------- 会话解析：所有路由都能拿到可选的 user ---------------- */

app.use('*', authMiddleware);

/* ---------------- 记下接口自己的域名（只记一次，见 services/config.ts 里的说明）：
   群发邮件的退订链接、订阅确认链接都要用它，而那些场合手里没有请求可问。 */
app.use('*', async (c, next) => {
  /* 这一步只是「顺手记下接口自己的域名」，每个 isolate 一次，失败不影响这一单请求。
     不加 try 时：库还没建表（新站先起了 dev:api）这里抛出去，**所有**接口一律 500，
     连专门用来自查的 /api/health 也一起倒下，新人完全看不出是「还没跑迁移」。 */
  try {
    await recordApiOrigin(c.env, c.req.url);
  } catch (e) {
    console.warn('[zero-api] 记录接口域名失败（不影响本次请求）：', errorMessage(e));
  }
  await next();
});

app.get('/api/health', async (c) => {
  const env = c.env;
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    const row = await env.DB.prepare('select count(*) as n from users').first<{ n: number }>();
    /**
     * 只数行数不够：`wrangler d1 migrations apply` 会偶发失败（实测报与 SQL 无关的 `bad port`），
     * 而部署脚本常常打印完退出码就继续 —— 于是库停在前面几条迁移，`users` 少了 `can_publish`、
     * `email_logs` 少了 `detail`，health 照样绿，直到第一次 `POST /api/auth/register` 才 500，
     * 现场长得像产品崩了（第 5 轮整轮就是这么废的）。这里补探一条**只有跑到 0012 之后才存在**的列，
     * 迁移没跑完就当场在 /api/health 里露出来。用 limit 0 是为了不读任何数据。
     */
    await env.DB.prepare('select detail from email_logs limit 0').all();
    checks.d1 = { ok: true, detail: `users=${row?.n ?? 0}` };
  } catch (e) {
    checks.d1 = { ok: false, detail: `表结构比代码旧（大概率是迁移没跑完，缺 email_logs.detail 这类较新的列）：${errorMessage(e)}` };
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

  /**
   * 后台可以登记多个 R2 存储位置（mediaBuckets），它们的绑定名只写在 site_config 里，
   * `wrangler deploy` 用本地 wrangler.jsonc 整体覆盖远端时，控制台手加的绑定会被抹掉 ——
   * 2026-10-21 就发生过一次 R2_MOL 被覆盖：媒体库少一个桶，直链却照常能开，属于静默半坏。
   * 这里把每个 R2 存储位置的绑定逐个探一遍，缺哪个当场让 /api/health 变红。
   */
  try {
    const r2Buckets = (await listBuckets(env)).filter((b) => b.kind === 'r2');
    const bindings = env as unknown as Record<string, R2Bucket | undefined>;
    let missing = 0;
    for (const b of r2Buckets) {
      const bucket = bindings[b.binding || 'R2'];
      if (!bucket) {
        missing++;
        continue;
      }
      try {
        await bucket.head('__probe__');
      } catch {
        missing++;
      }
    }
    checks.mediaBuckets = missing
      ? { ok: false, detail: `${r2Buckets.length} 个 R2 存储位置里有 ${missing} 个绑定不可用（多半是部署时被本地 wrangler.jsonc 覆盖掉了）` }
      : { ok: true, detail: `${r2Buckets.length} 个 R2 存储位置可用` };
  } catch (e) {
    checks.mediaBuckets = { ok: false, detail: errorMessage(e) };
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

/**
 * 整站公开配置：显式写死「不缓存」。
 * 这一份决定评论区/各面板开不开，R31-9 的口径是「后台一改就生效」——以前靠 Cloudflare
 * 对 API 响应默认不缓存（线上实测确实 DYNAMIC、没有 cache-control 头），但那属于「别人帮你不存」，
 * 中间多一层代理就可能变成开关晚生效。写在自己的响应头上，行为不再取决于边缘默认值。
 */
app.get('/api/config', async (c) => {
  const data = await getPublicConfig(c.env);
  return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } });
});

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
/**
 * 内容仓 CI 的构建结果回报。**必须挂在 /api/admin/* 那道统一登录闸之外** ——
 * CI 没有会话 Cookie，挂在下面时它连处理函数都进不去（实测 401「请先登录」）。
 * 写口靠 `x-build-report-token` 认，读口在自己内部 requireAdmin。
 */
app.route('/api/build-report', buildReport);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  const traceId = crypto.randomUUID().slice(0, 8);
  console.error(`[zero-api] 500 trace=${traceId}`, err);
  /**
   * 500 的回包不能原样带 `err.message`：实测里面是**完整 SQL 与列名清单**
   * （`Failed query: insert into "users" ("id","name",…,"can_publish","can_author"…)`），
   * 并发压测那次还带出 miniflare 的堆栈与本地绝对路径 —— 等于把表结构和内部路径公开。
   * 只有显式 `ENVIRONMENT=development`（本地 wrangler dev）才回原文，那正是需要它的场合；
   * 线上给人看的是日志里那同一个 trace。
   */
  const dev = c.env.ENVIRONMENT === 'development';
  /* 表不存在 = 迁移还没跑（或只跑了一半）。这种情况不该回那句「联系站长并附上 trace」：
     照 README 先起了 dev:api 还没跑迁移的新人，会拿到一个只会说「内部异常」的 500，
     而唯一该用来自查的 /api/health 也是同一个 500，等于把最该给的那句「先跑迁移」藏起来了。
     这里只回一句固定的操作指引（不外泄列名清单、堆栈与绝对路径），细节仍留在带 trace 的日志里。 */
  const uninitialized = /no such table|missing table|SQLITE_ERROR/i.test(errorMessage(err));
  /* Drizzle 抛的那句以 `Failed query: select …` 开头，后面跟着**整条 SQL 与绑定参数**，
     压测时还带出堆栈与本地绝对路径。开发档要看的也是这句，但看的地方是日志（同一个 trace），
     不是回给访客的 JSON —— 所以这一类即使在 development 档也不外发。 */
  const leaksSchema = /Failed query|Prepare statement|no such column|SQLITE_BUSY/i.test(errorMessage(err));
  const msg = uninitialized
    ? '数据库还没有初始化（表不存在）：先应用迁移再访问接口 —— 本地 `pnpm db:migrate:local`，线上 `pnpm db:migrate:remote`（或 `wrangler d1 migrations apply zero-db --remote`）'
    : leaksSchema
      ? '服务内部异常，请联系站长并附上 trace'
      : dev
        ? errorMessage(err)
        : '服务内部异常，请联系站长并附上 trace';
  return Response.json(
    {
      error: 500,
      message: msg,
      trace: traceId,
      ...(uninitialized && dev ? { detail: errorMessage(err) } : {}),
    },
    { status: 500 },
  );
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

