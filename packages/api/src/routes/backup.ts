/**
 * 全站备份的后台口子：导出 / 存档到 R2 / 取回 / 删除 / 导入。
 * 导入默认只做演习（dryRun），确认影响面之后再真写。
 */

import { Hono } from 'hono';
import { clientIp } from '../lib/http';
import { errorMessage, fail, ok } from '../lib/errors';
import { requireAdmin } from '../middleware/auth';
import { writeAudit } from '../services/audit';
import { backupKey, exportBackup, importBackup, pruneBackups, type BackupScope, type ImportOutcome } from '../services/backup';
import { applyCommentImport, parseCsvRows, planCommentImport, planSummary, type CommentFormat } from '../services/comment-import';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

function scopeOf(v: string | undefined): BackupScope {
  return v === 'full' ? 'full' : 'core';
}

/** 只允许访问自己的备份目录，别让后台变成任意对象读取器 */
function safeKey(key: string): string {
  const clean = key.replace(/^\/+/, '');
  if (!clean.startsWith('backups/') || clean.includes('..')) fail(400, '只能访问 backups/ 下的文件');
  if (!clean.endsWith('.json')) fail(400, '备份文件必须是 .json');
  return clean;
}

app.get('/export', async (c) => {
  const admin = requireAdmin(c);
  const scope = scopeOf(c.req.query('scope'));
  const includeSecrets = c.req.query('secrets') === '1';
  const save = c.req.query('save') === '1';

  const { payload, warnings } = await exportBackup(c.env, { scope, includeSecrets });
  await writeAudit(c.env, {
    actor: admin,
    action: 'backup',
    target: `export:${scope}`,
    detail: { counts: payload.counts, warnings, saved: save, withSecrets: includeSecrets },
    ip: clientIp(c),
  });

  if (!save) {
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${backupKey().split('/').pop()}"`,
      },
    });
  }

  const key = backupKey();
  await c.env.R2.put(key, JSON.stringify(payload), { httpMetadata: { contentType: 'application/json' } });
  const removed = await pruneBackups(c.env, 10);
  return ok({ key, counts: payload.counts, warnings, pruned: removed });
});

app.get('/list', async (c) => {
  requireAdmin(c);
  const listed = await c.env.R2.list({ prefix: 'backups/', limit: 100 });
  return ok(
    listed.objects
      .sort((a, b) => (b.uploaded?.getTime() ?? 0) - (a.uploaded?.getTime() ?? 0))
      .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded?.toISOString() ?? null })),
  );
});

app.get('/file', async (c) => {
  requireAdmin(c);
  const object = await c.env.R2.get(safeKey(c.req.query('key') ?? ''));
  if (!object) fail(404, '备份文件不存在');
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeKey(c.req.query('key') ?? '').split('/').pop()}"`,
    },
  });
});

app.delete('/file', async (c) => {
  const admin = requireAdmin(c);
  const key = safeKey(c.req.query('key') ?? '');
  await c.env.R2.delete(key);
  await writeAudit(c.env, { actor: admin, action: 'backup', target: key, detail: { event: 'delete' }, ip: clientIp(c) });
  return ok({ deleted: key });
});

app.post('/import', async (c) => {
  const admin = requireAdmin(c);
  const body = (await c.req.json().catch(() => null)) as { payload?: unknown; dryRun?: boolean } | null;
  if (!body?.payload) fail(400, '请在请求体里带上 payload（备份文件解析后的对象）');
  const dryRun = body.dryRun !== false;

  let outcome: ImportOutcome;
  try {
    outcome = await importBackup(c.env, body.payload, { dryRun });
  } catch (e) {
    fail(400, errorMessage(e));
  }

  await writeAudit(c.env, {
    actor: admin,
    action: 'backup',
    target: dryRun ? 'import:dry-run' : 'import:apply',
    detail: { tables: outcome.tables, errors: outcome.errors },
    ip: clientIp(c),
  });
  return ok(outcome);
});

/**
 * POST /api/admin/backup/comments
 * 第三方评论导入：Waline / Twikoo / Artalk / Giscus / CommentBox / 通用 JSON。
 * 与 /import（整库备份恢复）分开：那个要求文件是自家备份格式，这个是「别的系统导出的评论」。
 * 默认 dryRun —— 先让站主看清识别成了什么格式、多少条、落到哪些 slug、跳过哪些，
 * 再带 dryRun:false 真写。写入的每条都打 isLegacy 标记，同一份文件重复导入不会翻倍。
 */
app.post('/comments', async (c) => {
  const admin = requireAdmin(c);
  const body = (await c.req.json().catch(() => null)) as {
    payload?: unknown;
    /** CSV 原文（Waline / Artalk 控制台的 .csv 导出），与 payload 二选一 */
    csv?: string;
    format?: string;
    status?: string;
    dryRun?: boolean;
  } | null;
  const payload = body?.csv && body.csv.trim() ? parseCsvRows(body.csv) : body?.payload;
  if (!payload) fail(400, '请带上 payload（解析后的 JSON）或 csv（表格原文）');
  const dryRun = body?.dryRun !== false;

  let plan;
  try {
    plan = await planCommentImport(c.env, payload, {
      format: (body?.format || '') as CommentFormat | '',
      status: body?.status === 'pending' || body?.status === 'spam' ? body.status : 'keep',
    });
  } catch (e) {
    fail(400, errorMessage(e));
  }

  const applied = dryRun ? undefined : await applyCommentImport(c.env, plan);
  await writeAudit(c.env, {
    actor: admin,
    action: 'backup',
    target: dryRun ? 'comments:dry-run' : 'comments:import',
    detail: { format: plan.format, rows: plan.rows.length, skipped: plan.skipped, applied },
    ip: clientIp(c),
  });
  return ok({
    dryRun,
    format: plan.format,
    total: plan.total,
    rows: plan.rows.length,
    skipped: plan.skipped,
    slugs: plan.slugs,
    notice: plan.notice,
    summary: planSummary(plan, applied),
    applied,
  });
});

export default app;
