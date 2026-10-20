/**
 * 全站备份的后台口子：导出一份 JSON、按分区恢复。
 *
 * 路由只剩一条主线：
 *   GET  /export          导出（?save=1 同时存档到 R2）
 *   GET  /catalog         分区目录，导入前先给界面渲染勾选清单用
 *   GET  /list /file      R2 存档的列表、取回
 *   DELETE /file          删存档
 *   POST /import          按分区演习 / 恢复
 *   POST /comments        第三方评论系统（Waline / Twikoo …）的历史评论导入
 *
 * 备份只有一种（全站），被备份的表一律整表；scope=core|full 两档与「最近 N 条高频表」的
 * 截断都删了 —— 恢复一个半套的备份比不恢复更难查。
 * credentials=1 这一档是 2026-10-20 加回来的，别再当冗余删掉：默认的「全站备份」会剔掉
 * users.passwordHash / users.totpSecret / subscribers.token / comments.ownerKey
 * 这四列「拿到就能直接冒用」的数据（上一版这里写的是「密钥永不进文件」，实际只做到了配置侧，
 * 数据表侧整份带着）。真要整库搬家才显式勾选，勾了会在响应与审计里点名。
 */

import { Hono } from 'hono';
import { clientIp } from '../lib/http';
import { errorMessage, fail, ok } from '../lib/errors';
import { requireAdmin } from '../middleware/auth';
import { writeAudit } from '../services/audit';
import {
  backupKey,
  exportBackup,
  importBackup,
  pruneBackups,
  sectionCatalog,
  type ImportOutcome,
  type SectionId,
} from '../services/backup';
import {
  applyCommentImport,
  applyCounters,
  extractCounters,
  parseCsvRows,
  planCommentImport,
  planCounters,
  planSummary,
  type CommentFormat,
} from '../services/comment-import';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

/** 只允许访问自己的备份目录，别让后台变成任意对象读取器 */
function safeKey(key: string): string {
  const clean = key.replace(/^\/+/, '');
  if (!clean.startsWith('backups/') || clean.includes('..')) fail(400, '只能访问 backups/ 下的文件');
  if (!clean.endsWith('.json')) fail(400, '备份文件必须是 .json');
  return clean;
}

app.get('/catalog', async (c) => {
  requireAdmin(c);
  return ok({ sections: sectionCatalog() });
});

app.get('/export', async (c) => {
  const admin = requireAdmin(c);
  const save = c.req.query('save') === '1';
  const note = c.req.query('note') ?? '';
  /** 默认 false：口令散列 / TOTP 密钥 / 退订令牌 / 评论 ownerKey 不进文件。见 services/backup.ts 的 CREDENTIAL_COLUMNS */
  const includeCredentials = c.req.query('credentials') === '1';

  const { payload, warnings } = await exportBackup(c.env, { note, includeCredentials });
  await writeAudit(c.env, {
    actor: admin,
    action: 'backup',
    target: 'export',
    detail: {
      sections: payload.sections.map((s) => ({ id: s.id, counts: s.counts })),
      warnings,
      saved: save,
      includeCredentials,
      未包含: payload.omitted.map((o) => o.key),
    },
    ip: clientIp(c),
  });

  if (!save) {
    return new Response(JSON.stringify({ ...payload, warnings }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${backupKey().split('/').pop()}"`,
      },
    });
  }

  const key = backupKey();
  await c.env.R2.put(key, JSON.stringify(payload), { httpMetadata: { contentType: 'application/json' } });
  const removed = await pruneBackups(c.env, 10);
  return ok({
    key,
    createdAt: payload.createdAt,
    siteName: payload.siteName,
    sections: payload.sections.map((s) => ({ id: s.id, counts: s.counts, notes: s.notes ?? [] })),
    omitted: payload.omitted.length,
    warnings,
    pruned: removed,
  });
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

/**
 * POST /api/admin/backup/import
 * body: { payload, sections?: string[], dryRun?: boolean, overwrite?: boolean, fileStart?: number, fileCount?: number }
 * 不带 sections 表示整份恢复；带就是只恢复勾选的那几区。
 * dryRun 默认为 true：先看每区会写多少、哪些文件同名冲突，再决定推。
 * fileStart / fileCount 是文件区的分批写入游标，响应里的 resume 非空就代表这一区还有剩下的没推，
 * 后台接着发下一批 —— 一个请求写二十几个文件会中途断掉且不报错。
 */
app.post('/import', async (c) => {
  const admin = requireAdmin(c);
  const body = (await c.req.json().catch(() => null)) as {
    payload?: unknown;
    sections?: string[];
    dryRun?: boolean;
    overwrite?: boolean;
    fileStart?: number;
    fileCount?: number;
  } | null;
  if (!body?.payload) fail(400, '请在请求体里带上 payload（备份文件解析后的对象）');
  const dryRun = body.dryRun !== false;
  const sections = (body.sections ?? []).filter((s): s is SectionId => typeof s === 'string');
  const fileStart = Number.isFinite(body.fileStart) ? Math.max(0, Math.floor(body.fileStart as number)) : 0;
  /** 一批最多写多少个文件：Worker 单次请求要逐个调 GitHub，二十几个就顶不住，默认 5 个 */
  const fileCount = Number.isFinite(body.fileCount) ? Math.min(20, Math.max(1, Math.floor(body.fileCount as number))) : 5;

  let outcome: ImportOutcome;
  try {
    outcome = await importBackup(c.env, body.payload, {
      sections,
      dryRun,
      overwrite: body.overwrite === true,
      fileStart: dryRun ? 0 : fileStart,
      fileCount: dryRun ? undefined : fileCount,
      actor: admin,
      ip: clientIp(c),
    });
  } catch (e) {
    fail(400, errorMessage(e));
  }

  await writeAudit(c.env, {
    actor: admin,
    action: 'backup',
    target: dryRun ? 'import:dry-run' : 'import:apply',
    detail: {
      sections: outcome.sections.map((s) => ({ id: s.id, files: s.files?.write ?? 0, rows: s.tables?.reduce((n, t) => n + t.inserted, 0) ?? 0, settings: s.settings?.write ?? 0 })),
      overwrite: outcome.overwrite,
      errors: outcome.sections.flatMap((s) => s.errors),
      build: outcome.build,
      /** 分批写入时每批一行流水，出问题能看出断在第几个文件 */
      resume: outcome.resume,
    },
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
    /** 导出里没带文章地址时（Giscus 按页导出）统一补这个地址 */
    defaultSlug?: string;
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
      defaultSlug: body?.defaultSlug,
    });
  } catch (e) {
    fail(400, errorMessage(e));
  }

  /*
   * 附属计数（Waline 的 Counter 那张表：浏览量与表态数）跟评论一起搬，但口径是「只增不减」：
   * 本站已经比旧站多的地址保持本站，补差值时用固定的 legacy 指纹，同一份文件重复导不会翻倍。
   */
  const counterEntries = extractCounters(payload);
  const counters = dryRun ? await planCounters(c.env, counterEntries) : await applyCounters(c.env, counterEntries);

  const applied = dryRun ? undefined : await applyCommentImport(c.env, plan);
  await writeAudit(c.env, {
    actor: admin,
    action: 'backup',
    target: dryRun ? 'comments:dry-run' : 'comments:import',
    detail: { format: plan.format, rows: plan.rows.length, skipped: plan.skipped, applied, counters },
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
    counters,
    counterSlugs: counterEntries.length,
    summary: planSummary(plan, applied),
    applied,
  });
});

export default app;
