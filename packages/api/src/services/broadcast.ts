/**
 * broadcast.ts — 群发任务的执行体
 *
 * 路由（routes/broadcast.ts）与 cron（services/scheduler.ts）都调这里的 runBroadcastJob，
 * 两边共用同一套状态机，免得「手工点运行」和「到点自动跑」走出两种结果。
 *
 * 状态流转：queued →(抢占)→ running → done / failed；只有 queued 能被取消。
 * 抢占用一条带 status 条件的 UPDATE：meta.changes 为 0 就说明别人（或上一次点击）已经在跑了，
 * Worker 没有事务锁，这种 compare-and-set 是最省事的互斥手段。
 *
 * 收件人按批取（BATCH_SIZE 个一批），每批发完就把 sent_count / failed_count 落一次库：
 * 万一中途被 CPU 时间上限打断，后台至少能看到已经发到哪了。
 */

import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { broadcastJobs, subscribers } from '../db/schema';
import { apiBase, getConfig } from './config';
import { postWebPath } from './frontmatter';
import { mailQuotaCheck, queueEmail, renderEmail } from './email';
import { newId } from '../lib/crypto';

/** 一次取多少收件人：既是 D1 的分页粒度，也是每次回写计数的粒度 */
const BATCH_SIZE = 50;

export type BroadcastStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface RunSummary {
  id: string;
  status: BroadcastStatus;
  recipients: number;
  sent: number;
  failed: number;
  error?: string;
}

/** 每封群发邮件底部都要带的退订行：退订只能凭 token 链接 */
async function unsubscribeFooter(env: Env, token: string): Promise<string> {
  if (!token) return '';
  const base = await apiBase(env);
  const href = `${base}/api/subscribe/unsub?token=${encodeURIComponent(token)}`;
  return `<p style="color:#999;font-size:12px;margin-top:24px;">不再想收到本站邮件？<a href="${href}">点这里退订</a>。</p>`;
}

/** 站点前台地址：邮件里的文章链接只能用它拼成绝对地址 */
async function siteBaseUrl(env: Env): Promise<string> {
  const raw = ((await getConfig(env, 'siteUrl')) ?? env.SITE_URL ?? '').trim();
  return raw.replace(/\/+$/, '');
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

/**
 * 关联文章在邮件里可点开的地址。
 * 传进来的可能是仓库路径（content/posts/x.mdx，后台下拉给的就是这个），也可能已经是
 * /posts/slug/，一律先归一到站内路径再拼上域名 —— 只给路径的话，邮件客户端点进去是
 * 「本地文件」或「客户端自己的域名」，文章根本打不开。
 */
export async function postEmailUrl(env: Env, pathOrUrl: string): Promise<string> {
  const raw = String(pathOrUrl ?? '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const webPath = postWebPath(raw);
  const base = await siteBaseUrl(env);
  return base ? `${base}${webPath}` : webPath;
}

/** 正文里还没有这篇文章的地址时补一段「阅读全文」；已经带了就不重复加 */
export function appendPostLink(html: string, url: string): string {
  const link = String(url ?? '').trim();
  if (!link || html.includes(link)) return html;
  return `${html}<p style="margin:18px 0 0 0;"><a href="${escapeAttr(link)}">阅读全文</a></p>`;
}

/**
 * 执行一个群发任务。
 * 传入 jobId 已经被抢占（status=running）时才调用；未抢占时用 force=false 走抢占流程。
 */
export async function runBroadcastJob(env: Env, jobId: string): Promise<RunSummary> {
  const db = createDb(env);
  const rows = await db.select().from(broadcastJobs).where(eq(broadcastJobs.id, jobId)).limit(1);
  const job = rows[0];
  if (!job) return { id: jobId, status: 'failed', recipients: 0, sent: 0, failed: 0, error: '任务不存在' };
  if (job.status === 'running') return { id: jobId, status: 'running', recipients: job.recipientCount, sent: job.sentCount, failed: job.failedCount, error: '任务正在执行中' };
  if (job.status === 'done' || job.status === 'canceled') {
    return { id: jobId, status: job.status as BroadcastStatus, recipients: job.recipientCount, sent: job.sentCount, failed: job.failedCount, error: `任务已是 ${job.status}` };
  }

    // 发信服务按天限量，群发一跑就是「订阅者数 × 1 封」。
  // 额度不够时整批不发、也不抢占状态：任务留在 queued，明天的 Cron 自然续跑，
  // 比发到一半被服务商拒掉、再重跑时把已发过的人再发一遍要好。
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(subscribers)
    .where(eq(subscribers.status, 'confirmed'));
  const recipients = Number(total[0]?.n ?? 0);
  const quota = await mailQuotaCheck(env, recipients);
  if (!quota.ok) {
    /* 把原因和人数落回任务行：只在响应里给一次，后台刷新就只剩一个没有解释的 queued。 */
    await db
      .update(broadcastJobs)
      .set({ recipientCount: recipients, error: quota.reason })
      .where(eq(broadcastJobs.id, jobId));
    return { id: jobId, status: 'queued', recipients, sent: 0, failed: 0, error: quota.reason };
  }

  const claimed = await claimJob(env, jobId);
  if (!claimed) {
    return { id: jobId, status: 'running', recipients: job.recipientCount, sent: job.sentCount, failed: job.failedCount, error: '任务已被其它请求抢占' };
  }
  return executeJob(env, { ...job, status: 'running' });
}

/** compare-and-set：queued/failed 才能进 running，返回是否抢到 */
export async function claimJob(env: Env, jobId: string): Promise<boolean> {
  const db = createDb(env);
  const result = await db
    .update(broadcastJobs)
    .set({ status: 'running', error: null })
    .where(and(eq(broadcastJobs.id, jobId), inArray(broadcastJobs.status, ['queued', 'failed'])));
  const changes = (result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
  return changes > 0;
}

/** 真正的发送循环：分批取 confirmed 订阅者，逐批回写计数 */
async function executeJob(env: Env, job: typeof broadcastJobs.$inferSelect): Promise<RunSummary> {
  const db = createDb(env);
  const footerOf = new Map<string, string>();
  let sent = 0;
  let failed = 0;
  let offset = 0;
  let runError: string | null = null;

  try {
    /* 关联文章的地址一次算好：后台群发选了文章时正文里只有文字，链接靠这里补；
       「发布后自动群发」那封已把地址写进正文，appendPostLink 认得出来就不再补第二份。 */
    const bodyWithLink = appendPostLink(job.html, await postEmailUrl(env, job.postPath ?? ''));
    const total = await db
      .select({ n: sql<number>`count(*)` })
      .from(subscribers)
      .where(eq(subscribers.status, 'confirmed'));
    const recipients = Number(total[0]?.n ?? 0);
    await db.update(broadcastJobs).set({ recipientCount: recipients }).where(eq(broadcastJobs.id, job.id));

    for (;;) {
      // 按 id 排序分页：created_at 同秒的记录用 offset 翻页会重复或漏人
      const batch = await db
        .select({ email: subscribers.email, token: subscribers.token })
        .from(subscribers)
        .where(eq(subscribers.status, 'confirmed'))
        .orderBy(asc(subscribers.id))
        .limit(BATCH_SIZE)
        .offset(offset);
      if (!batch.length) break;

      for (const s of batch) {
        let footer = footerOf.get(s.token);
        if (footer === undefined) {
          footer = await unsubscribeFooter(env, s.token);
          footerOf.set(s.token, footer);
        }
        // 站主自己写的正文套上统一外壳（站点名 / Logo / 称呼 / 落款），
        // 模板固定成 {content}：群发内容本来就是整段 HTML，不再套通知模板那句开头语
        const html = await renderEmail(
          env,
          'notice',
          { content: bodyWithLink + footer },
          { template: '{content}', rawKeys: ['content'] },
        );
        const res = await queueEmail(env, {
          to: s.email,
          subject: job.subject,
          html,
          kind: 'broadcast',
          postId: job.postId ?? undefined,
        });
        if (res.success) sent++;
        else failed++;
      }

      offset += batch.length;
      // 每批回写一次：进度可见，中断也不丢已完成的部分
      await db
        .update(broadcastJobs)
        .set({ sentCount: sent, failedCount: failed, recipientCount: Math.max(offset, recipients) })
        .where(eq(broadcastJobs.id, job.id));
      if (batch.length < BATCH_SIZE) break;
    }

    await db
      .update(broadcastJobs)
      .set({
        status: 'done',
        sentCount: sent,
        failedCount: failed,
        finishedAt: Math.floor(Date.now() / 1000),
        error: runError,
      })
      .where(eq(broadcastJobs.id, job.id));
    return { id: job.id, status: 'done', recipients: offset, sent, failed };
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
    await db
      .update(broadcastJobs)
      .set({
        status: 'failed',
        sentCount: sent,
        failedCount: failed,
        error: runError,
        finishedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(broadcastJobs.id, job.id));
    return { id: job.id, status: 'failed', recipients: offset, sent, failed, error: runError };
  }
}

/** 新建任务：scheduleAt 为空表示「现在就发」 */
export async function createBroadcastJob(
  env: Env,
  input: { subject: string; html: string; postId?: string | null; postPath?: string | null; scheduleAt?: number | null; createdBy?: string | null },
): Promise<string> {
  const db = createDb(env);
  const id = newId();
  await db.insert(broadcastJobs).values({
    id,
    subject: input.subject,
    html: input.html,
    postId: input.postId ?? null,
    postPath: input.postPath ?? null,
    scheduleAt: input.scheduleAt ? Math.floor(input.scheduleAt) : null,
    status: 'queued',
    recipientCount: 0,
    sentCount: 0,
    failedCount: 0,
    createdBy: input.createdBy ?? null,
    createdAt: Math.floor(Date.now() / 1000),
  });
  return id;
}

/**
 * cron 入口：把到点的任务挨个跑掉。
 * 单次 cron 最多跑 DUE_LIMIT 个，剩下的下一轮再来，免得一个批处理把整个定时任务拖超时。
 */
const DUE_LIMIT = 5;

export async function runDueBroadcastJobs(env: Env): Promise<string> {
  const db = createDb(env);
  const now = Math.floor(Date.now() / 1000);
  const due = await db
    .select({ id: broadcastJobs.id })
    .from(broadcastJobs)
    .where(and(eq(broadcastJobs.status, 'queued'), or(lt(broadcastJobs.scheduleAt, now), sql`${broadcastJobs.scheduleAt} IS NULL`)))
    .orderBy(asc(broadcastJobs.scheduleAt))
    .limit(DUE_LIMIT);
  if (!due.length) return '没有到点的群发任务';

  const summaries: string[] = [];
  for (const row of due) {
    const s = await runBroadcastJob(env, row.id);
    summaries.push(`${row.id.slice(0, 8)}:${s.status}(发${s.sent}/败${s.failed})`);
  }
  return `执行 ${due.length} 个到点任务：${summaries.join('，')}`;
}

/** 后台列表：最近 N 个任务，字段与前端 Job 接口一一对应 */
export async function listBroadcastJobs(env: Env, limit = 50) {
  const db = createDb(env);
  const rows = await db.select().from(broadcastJobs).orderBy(desc(broadcastJobs.createdAt)).limit(Math.min(limit, 200));
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    postId: r.postId,
    postPath: r.postPath,
    scheduleAt: r.scheduleAt,
    status: r.status,
    recipientCount: r.recipientCount,
    sentCount: r.sentCount,
    failedCount: r.failedCount,
    error: r.error,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
  }));
}
