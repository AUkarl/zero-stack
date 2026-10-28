/**
 * routes/broadcast.ts — 群发任务管理（挂在 /api/admin/broadcast 下，由 src/index.ts 挂载）
 *
 * 执行体在 services/broadcast.ts，这里只做参数校验、审计与状态码；
 * cron 到点的那条路走同一个 runBroadcastJob，行为完全一致。
 *
 * 状态码约定：
 *   GET    /jobs        → { data: Job[] }
 *   POST   /jobs        → 建任务；没给 scheduleAt 就直接跑完再回（前端定时那条只读 id）
 *   POST   /jobs/:id/run → 立刻执行；已在跑 / 已完成 / 已取消回 409
 *   DELETE /jobs/:id     → 只有 queued 能取消，其它状态回 409
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../db/client';
import { broadcastJobs } from '../db/schema';
import { clientIp } from '../lib/http';
import { fail, ok } from '../lib/errors';
import { requireAdmin } from '../middleware/auth';
import { writeAudit } from '../services/audit';
import { createBroadcastJob, listBroadcastJobs, runBroadcastJob } from '../services/broadcast';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

const jobSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  html: z.string().min(1).max(200_000),
  postId: z.string().max(300).optional().nullable(),
  postPath: z.string().max(300).optional().nullable(),
  /** unix 秒；留空表示立刻发送 */
  scheduleAt: z.number().int().positive().optional().nullable(),
});

/** GET /api/admin/broadcast/jobs */
app.get('/jobs', async (c) => {
  requireAdmin(c);
  const limit = Math.min(Number(c.req.query('limit') ?? '50') || 50, 200);
  return ok(await listBroadcastJobs(c.env, limit));
});

/** POST /api/admin/broadcast/jobs */
app.post('/jobs', async (c) => {
  const admin = requireAdmin(c);
  const parsed = jobSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '主题与正文必填，scheduleAt 用 unix 秒');
  const b = parsed.data;
  const scheduleAt = b.scheduleAt ?? null;

  const id = await createBroadcastJob(c.env, {
    subject: b.subject,
    html: b.html,
    postId: b.postId ?? null,
    postPath: b.postPath ?? null,
    scheduleAt,
    createdBy: admin.id ?? null,
  });

  await writeAudit(c.env, {
    actor: admin,
    action: 'broadcast',
    target: b.subject,
    detail: { event: 'job:create', id, scheduleAt, postId: b.postId ?? null, postPath: b.postPath ?? null },
    ip: clientIp(c),
  });

  // 没安排时间就当场发完：前端立即发送走的还是 POST /broadcast，这里是接口侧的「建完即发」
  if (!scheduleAt) {
    const summary = await runBroadcastJob(c.env, id);
    await writeAudit(c.env, {
      actor: admin,
      action: 'broadcast',
      target: b.subject,
      detail: { event: 'job:run', id, status: summary.status, sent: summary.sent, failed: summary.failed, error: summary.error ?? null },
      ip: clientIp(c),
    });
    const jobs = await listBroadcastJobs(c.env, 1);
    return ok({ id, status: summary.status, recipients: summary.recipients, sent: summary.sent, failed: summary.failed, error: summary.error ?? null, job: jobs.find((j) => j.id === id) ?? null });
  }

  const jobs = await listBroadcastJobs(c.env, 1);
  return ok({ id, status: 'queued', scheduleAt, job: jobs.find((j) => j.id === id) ?? null });
});

/** POST /api/admin/broadcast/jobs/:id/run —— 手工立刻执行（定时任务也能提前跑） */
app.post('/jobs/:id/run', async (c) => {
  const admin = requireAdmin(c);
  const db = createDb(c.env);
  const id = c.req.param('id');
  const rows = await db.select({ id: broadcastJobs.id, status: broadcastJobs.status, subject: broadcastJobs.subject }).from(broadcastJobs).where(eq(broadcastJobs.id, id)).limit(1);
  const job = rows[0];
  if (!job) fail(404, '群发任务不存在');
  if (job.status === 'running') fail(409, '该任务正在执行中');
  if (job.status === 'done') fail(409, '该任务已经发过了');
  if (job.status === 'canceled') fail(409, '该任务已取消，不能再执行');

  const summary = await runBroadcastJob(c.env, id);
  await writeAudit(c.env, {
    actor: admin,
    action: 'broadcast',
    target: job.subject,
    detail: { event: 'job:run', id, status: summary.status, sent: summary.sent, failed: summary.failed, error: summary.error ?? null },
    ip: clientIp(c),
  });
  return ok(summary);
});

/** DELETE /api/admin/broadcast/jobs/:id —— 排队中的取消留痕，跑完/已取消的直接删掉这条历史 */
app.delete('/jobs/:id', async (c) => {
  const admin = requireAdmin(c);
  const db = createDb(c.env);
  const id = c.req.param('id');
  const rows = await db.select({ id: broadcastJobs.id, status: broadcastJobs.status, subject: broadcastJobs.subject }).from(broadcastJobs).where(eq(broadcastJobs.id, id)).limit(1);
  const job = rows[0];
  if (!job) fail(404, '群发任务不存在');
  /* 排队中的任务是「取消」（留痕，仍能在列表里看到被取消）；
     已经跑完（done/failed）与早已取消的历史是「删除」—— 原来只有 queued 能走这个口，
     于是每发一次群发就多留一条记录，列表只增不减，也没有任何清理入口。 */
  if (job.status === 'queued') {
    await db.update(broadcastJobs).set({ status: 'canceled', finishedAt: Math.floor(Date.now() / 1000) }).where(eq(broadcastJobs.id, id));
    await writeAudit(c.env, {
      actor: admin,
      action: 'broadcast',
      target: job.subject,
      detail: { event: 'job:cancel', id, from: job.status, to: 'canceled' },
      ip: clientIp(c),
    });
    return ok({ id, status: 'canceled', canceled: true });
  }
  if (job.status === 'running') fail(409, '该任务正在执行中，等它跑完再删');
  await db.delete(broadcastJobs).where(eq(broadcastJobs.id, id));
  await writeAudit(c.env, {
    actor: admin,
    action: 'broadcast',
    target: job.subject,
    detail: { event: 'job:delete', id, from: job.status },
    ip: clientIp(c),
  });
  return ok({ id, deleted: true, subject: job.subject });
});

export default app;
