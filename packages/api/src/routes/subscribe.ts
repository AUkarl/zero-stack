import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../db/client';
import { subscribers } from '../db/schema';
import { getConfig, getConfigBool } from '../services/config';
import { newId, randomToken } from '../lib/crypto';
import { fail, ok } from '../lib/errors';
import { clientIp } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';
import { renderEmail, sendEmail } from '../services/email';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

const emailSchema = z.string().email().max(200);

function confirmLink(env: Env, token: string): string {
  const base = (env.SITE_URL ?? '').replace(/\/+$/, '');
  return `${base}/subscribe/?confirm=${token}`;
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

  const token = randomToken(16);
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
    { url: confirmLink(env, token), siteName, email },
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
    fail(502, '确认邮件发送失败，请稍后再试或联系站主');
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
  return Response.redirect((await getConfig(env, 'siteUrl')) ?? env.SITE_URL ?? 'https://example.com/', 302);
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

  const base = (await getConfig(env, 'siteUrl')) ?? env.SITE_URL ?? '/';
  return Response.redirect(`${base.replace(/\/+$/, '')}/subscribe/?unsubscribed=1`, 302);
});

/** GET /api/subscribe/status?email= —— 页脚显示"已订阅"用 */
app.get('/status', async (c) => {
  const env = c.env;
  const email = (c.req.query('email') ?? '').trim().toLowerCase();
  if (!email) return ok({ status: 'none' });
  // 该接口会透露某个邮箱是否在名单里，限流把枚举成本抬高
  await rateLimit(c, 'subscribe-status', 10, 600, clientIp(c));
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

/** GET /api/subscribe/count —— 后台统计卡片 */

export default app;
