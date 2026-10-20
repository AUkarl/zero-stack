import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../db/client';
import { subscribers } from '../db/schema';
import { getConfig, getConfigBool } from '../services/config';
import { newId, randomToken } from '../lib/crypto';
import { fail, ok } from '../lib/errors';
import { clientIp } from '../lib/http';
import { rateLimit, rateLimitLocal } from '../lib/rate-limit';
import { renderEmail, sendEmail } from '../services/email';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

const emailSchema = z.string().email().max(200);

/**
 * 确认订阅的链接必须指向**接口自己**的 /api/subscribe/confirm：
 * 站点域名是 Pages 上的一份 Hugo 静态站，没有 /api 代理，写成 ${siteUrl}/api/... 或
 * ${siteUrl}/subscribe/?confirm= 都点不开（前者 404，后者前台根本没有读 ?confirm= 的代码，
 * 于是订阅永远确认不上、后台名单一直堆着一排 pending）。
 * 这里直接用当次请求的 origin；接口域名要留给拿不到请求的场合（群发、定时任务）用，
 * 那份记录在 services/config.ts 的 recordApiOrigin 里做。
 */
function confirmLink(c: { req: { url: string } }, token: string): string {
  const self = new URL(c.req.url).origin.replace(/\/+$/, '');
  return `${self}/api/subscribe/confirm?token=${encodeURIComponent(token)}`;
}

/**
 * 确认 / 退订点完之后落到的那一页。
 *
 * 原来这里是 302 跳回站点首页：订阅者点开链接后什么都没看到（首页不会弹「已确认」），
 * 所以既不知道点成功了、也不知道是谁点的 —— 后台名单里只有一排 pending。
 * 接口自己回一页最省事：不依赖前台页面读查询参数（它并没有这种代码）。
 */
async function donePage(env: Env, title: string, message: string): Promise<Response> {
  const [site, home] = [((await getConfig(env, 'siteName')) ?? '').trim() || '本站', ((await getConfig(env, 'siteUrl')) ?? env.SITE_URL ?? '').trim()];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const back = home ? `<p><a href="${esc(home.replace(/\/+$/, ''))}/" style="color:#0d8368">回到 ${esc(site)} 首页</a></p>` : '';
  return new Response(
    `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title></head>` +
      `<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7f6;font-family:system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif">` +
      `<main style="max-width:30rem;padding:2rem 1.4rem;background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.06);text-align:center">` +
      `<h1 style="margin:0 0 .6rem;font-size:1.25rem;color:#1f2328">${esc(title)}</h1>` +
      `<p style="margin:0 0 1rem;font-size:.95rem;line-height:1.8;color:#4b5563">${esc(message)}</p>${back}</main></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } },
  );
}
/** POST /api/subscribe —— 订阅；双重确认开启时发确认邮件 */
app.post('/', async (c) => {
  const env = c.env;
  if (!(await getConfigBool(env, 'subscribeEnabled', true))) fail(403, '订阅功能已关闭');

  const parsed = z.object({ email: emailSchema }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '邮箱格式不正确');
  const email = parsed.data.email.trim().toLowerCase();

  await rateLimit(c, 'subscribe', 5, 3600, email);
  const db = createDb(env);
  const now = Math.floor(Date.now() / 1000);
  const doubleOptIn = await getConfigBool(env, 'subscribeDoubleOptIn', true);
  const existing = await db.select().from(subscribers).where(eq(subscribers.email, email)).limit(1);
  const row = existing[0];

  // 已确认过就不重复走一遍确认流程
  if (row && row.status === 'confirmed') return ok({ status: 'confirmed', message: '该邮箱已订阅' });

  /* 重复提交（没点到确认信、或退订后再来一次）沿用原来那个 token。
     以前每次都换新 token，上一封还躺在收件箱里的确认信一点就是「链接无效或已过期」，
     而订阅者根本不知道自己有两封，试几次都失败 —— 这跟 SMTP 通不通没有关系。 */
  const token = row?.token || randomToken(16);
  const status = doubleOptIn ? 'pending' : 'confirmed';
  const values = {
    email,
    token,
    status,
    ip: clientIp(c),
    createdAt: row?.createdAt ?? now,
    confirmedAt: doubleOptIn ? null : now,
    unsubscribedAt: null,
  };

  if (row) await db.update(subscribers).set(values).where(eq(subscribers.id, row.id));
  else await db.insert(subscribers).values({ id: newId(), ...values });

  if (!doubleOptIn) return ok({ status, message: '订阅成功' });

  const siteName = (await getConfig(env, 'siteName')) ?? 'Zero';
  const html = await renderEmail(
    env,
    'subscribe',
    { url: confirmLink(c, token), siteName, email },
    { title: '确认订阅', nickname: '订阅者', actionNote: '确认链接 24 小时内有效，过期后重新提交一次订阅即可。' },
  );
  const sent = await sendEmail(env, {
    to: email,
    subject: `请确认订阅 ${siteName}`,
    html,
    kind: 'confirm',
  });
  if (!sent.success) {
    console.warn(`[subscribe] 确认邮件发送失败 ${email}: ${sent.error ?? '未知原因'}`);
    /* 这一行留在库里是对的（他确实就是「待确认」），要说的只是：信没出去、地址没丢、
       再提交一次还是同一个链接。回 502 让前台显示成失败，别报成功。 */
    fail(502, `确认邮件这次没发出去（${sent.error ?? '发信通道未就绪'}）。邮箱已记为「待确认」，稍后重新提交一次即可，确认链接不变；一直收不到就联系站主查发信设置。`);
  }
  return ok({ status, message: '确认邮件已发送，请在邮箱中点击确认' });
});

/** GET /api/subscribe/confirm?token= —— 点邮件链接完成订阅 */
app.get('/confirm', async (c) => {
  const env = c.env;
  const token = c.req.query('token') ?? '';
  if (!token) fail(400, '缺少确认令牌');
  const db = createDb(env);
  const rows = await db.select().from(subscribers).where(eq(subscribers.token, token)).limit(1);
  const row = rows[0];
  if (!row) fail(404, '确认链接无效或已过期');

  await db
    .update(subscribers)
    .set({ status: 'confirmed', confirmedAt: Math.floor(Date.now() / 1000) })
    .where(eq(subscribers.id, row.id));
  return donePage(c.env, '订阅已确认', `邮箱 ${row.email} 已加入订阅名单，站内发布新文章时会给你发一封汇总。`);
});

/** GET /api/subscribe/unsub?token= —— 邮件里的退订链接，点开即退 */
app.get('/unsub', async (c) => {
  const env = c.env;
  const token = c.req.query('token') ?? '';
  if (!token) fail(400, '缺少退订令牌');
  await rateLimit(c, 'subscribe-unsub', 10, 600, token);

  const db = createDb(env);
  const rows = await db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.token, token)).limit(1);
  if (!rows.length) fail(404, '退订链接无效');
  await db
    .update(subscribers)
    .set({ status: 'unsubscribed', unsubscribedAt: Math.floor(Date.now() / 1000) })
    .where(eq(subscribers.id, rows[0]!.id));

  return donePage(c.env, '已退订', '这个邮箱不会再收到本站的邮件。想重新订阅，到订阅页再提交一次即可。');
});

/** GET /api/subscribe/status?email= —— 页脚显示"已订阅"用 */
app.get('/status', async (c) => {
  const env = c.env;
  const email = (c.req.query('email') ?? '').trim().toLowerCase();
  if (!email) return ok({ status: 'none' });
  // 该接口会透露某个邮箱是否在名单里，限流把枚举成本抬高。
  // 键只按 IP（rateLimitLocal 内部已经带了 clientIp），计数走 isolate 内存，不占 KV 写额度。
  rateLimitLocal(c, 'subscribe-status', 10, 600);
  const rows = await createDb(env).select({ status: subscribers.status }).from(subscribers).where(eq(subscribers.email, email)).limit(1);
  return ok({ status: rows[0]?.status ?? 'none' });
});

/** POST /api/subscribe/unsubscribe —— 只认邮件里的 token，防止知道邮箱就能替别人退订 */
app.post('/unsubscribe', async (c) => {
  const env = c.env;
  const body = (await c.req.json().catch(() => null)) as { email?: string; token?: string } | null;
  const db = createDb(env);
  const now = Math.floor(Date.now() / 1000);

  const token = (body?.token ?? '').trim();
  if (!token) fail(400, '请使用邮件中的退订链接');
  const rows = await db.select({ id: subscribers.id }).from(subscribers).where(eq(subscribers.token, token)).limit(1);
  if (!rows.length) fail(404, '退订链接无效');
  await db.update(subscribers).set({ status: 'unsubscribed', unsubscribedAt: now }).where(eq(subscribers.id, rows[0]!.id));
  return ok({ unsubscribed: true });
});

export default app;
