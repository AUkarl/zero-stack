/**
 * 后台审核：用户中心的投稿与作者认证（挂在 /api/admin/drafts、/api/admin/author-requests）。
 *
 * 投稿通过后才落到 Git：这里拼 Hugo 的 front matter，写到 <内容目录>/<lang>/posts/<slug>.md，
 * 仓库没配置或提交失败都不改 D1 里的审核结论——草稿仍在库里，后台可以点「补发布」重来。
 *
 * 作者认证通过除了写 users 表（author_verified / handle / user_group），还把申请资料落到
 * 站点的 data/authors.yaml（走 services/authors.ts）；那一步失败不推翻审核结论，
 * 只把错误原文回在 authorFile.error 里，让管理员补好料再点一次。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { authorRequests, postDrafts, users } from '../db/schema';
import { writeAudit } from '../services/audit';
import { upsertAuthor, type AuthorSocialRow } from '../services/authors';
import { getConfig, getConfigBool } from '../services/config';
import { writeFile } from '../services/git';
import { repoTarget, triggerPagesBuild } from '../services/git';
import { deleteRepoFile, repoBackend } from '../services/repo';
import { sendDraftReviewResult } from '../services/review-mail';
import { clientIp } from '../lib/http';
import { canonHandle } from '../lib/slug';
import { avatarForEmail } from '../lib/avatar';
import { errorMessage, fail, ok } from '../lib/errors';
import { requireAdmin } from '../middleware/auth';
import type { AppEnv } from '../lib/app';

/** 后台审核台认的状态集合：withdraw_requested 是作者发起的撤回申请 */
const DRAFT_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'withdraw_requested'] as const;

function toYamlString(v: string): string {
  // front matter 里出现冒号、井号或引号都要整体加引号，否则 Hugo 解析会错位
  if (/^[\w\u4e00-\u9fa5 .\-—–]+$/.test(v)) return v;
  return JSON.stringify(v);
}

/**
 * 文章署名用的作者标识：认证过的账号用 handle（前台据此取作者卡片与认证徽章，
 * 也能在 data/authors.yaml 里查到资料）；没认证的保持原有兜底顺序。
 */
export function authorKeyFor(row: { name: string | null; handle: string | null; authorVerified: boolean | null } | undefined): string {
  if (row?.authorVerified && row.handle) return row.handle;
  return row?.handle || row?.name || '读者';
}

/**
 * 拼 Hugo 文章头，字段顺序与站点现有文章保持一致。
 * authorKey 优先传账号的作者标识（users.handle），没有标识的才退回昵称。
 */
export function buildPostMarkdown(row: typeof postDrafts.$inferSelect, authorKey: string): string {
  const date = new Date((row.publishedAt ?? Math.floor(Date.now() / 1000)) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const lines = ['---', `title: ${toYamlString(row.title)}`, `date: ${date}`];
  if (row.summary) lines.push(`description: ${toYamlString(row.summary)}`);
  if (row.category) {
    lines.push('categories:', `  - ${toYamlString(row.category)}`);
  }
  const tags = parseTags(row.tags);
  if (tags.length) {
    lines.push('tags:');
    for (const t of tags) lines.push(`  - ${toYamlString(t)}`);
  }
  if (row.cover) lines.push(`image: ${toYamlString(row.cover)}`);
  lines.push(`author: ${toYamlString(authorKey)}`, 'toc: true', 'math: false', 'comments: true', 'draft: false', '---', '');
  return `${lines.join('\n')}\n${row.content.trim()}\n`;
}

function parseTags(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.map((t) => String(t)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 内容目录来自后台配置，缺省 content；拼出的路径必须仍在 content/ 下 */
async function postPath(env: Env, row: typeof postDrafts.$inferSelect): Promise<string> {
  const base = normalizeDir((await getConfig(env, 'githubContentDir')) ?? 'content');
  const path = `${base}/zh/posts/${row.slug}.md`;
  // 与后台文章保存同一套判法：目录穿越与控制/保留字符才拒，中文与全角标点放行
  const segs = path.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..') || segs[0] !== 'content') {
    fail(400, '投稿的文件名不合法，无法写入仓库');
  }
  if (/[\u0000-\u001f<>:"|?*]/.test(path)) fail(400, '投稿的文件名含有系统保留字符，无法写入仓库');
  return path;
}

function normalizeDir(dir: string): string {
  const d = dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return d || 'content';
}

/* ================= 投稿审核 ================= */

export const draftsAdmin = new Hono<AppEnv>();

draftsAdmin.get('/', async (c) => {
  requireAdmin(c);
  const status = c.req.query('status') ?? '';
  if (status && status !== 'all' && !(DRAFT_STATUSES as readonly string[]).includes(status)) fail(400, `未知的投稿状态：${status}`);
  const q = (c.req.query('q') ?? '').trim();
  const limit = Math.min(Number(c.req.query('limit') ?? '100') || 100, 300);
  const offset = Math.max(0, Number(c.req.query('offset') ?? '0') || 0);

  const conds = [];
  if (status && status !== 'all') conds.push(eq(postDrafts.status, status));
  if (q) conds.push(or(like(postDrafts.title, `%${q}%`), like(postDrafts.slug, `%${q}%`)));
  const where = conds.length ? and(...conds) : undefined;

  const db = createDb(c.env);
  const base = db
    .select({
      id: postDrafts.id,
      userId: postDrafts.userId,
      title: postDrafts.title,
      slug: postDrafts.slug,
      category: postDrafts.category,
      tags: postDrafts.tags,
      summary: postDrafts.summary,
      cover: postDrafts.cover,
      status: postDrafts.status,
      reviewNote: postDrafts.reviewNote,
      publishedPath: postDrafts.publishedPath,
      publishedAt: postDrafts.publishedAt,
      createdAt: postDrafts.createdAt,
      updatedAt: postDrafts.updatedAt,
      authorName: users.name,
      authorEmail: users.email,
    })
    .from(postDrafts)
    .leftJoin(users, eq(users.id, postDrafts.userId));
  const query = where ? base.where(where) : base;
  const rows = await query.orderBy(desc(postDrafts.createdAt)).limit(limit).offset(offset);
  const total = await db.select({ n: sql<number>`count(*)` }).from(postDrafts).where(where);
  return ok({
    items: rows.map((r) => ({ ...r, tags: parseTags(r.tags) })),
    total: Number(total[0]?.n ?? 0),
  });
});

draftsAdmin.get('/stats', async (c) => {
  requireAdmin(c);
  const rows = await createDb(c.env)
    .select({ status: postDrafts.status, n: sql<number>`count(*)` })
    .from(postDrafts)
    .groupBy(postDrafts.status);
  const by: Record<string, number> = { draft: 0, pending: 0, approved: 0, rejected: 0, withdraw_requested: 0 };
  for (const r of rows) by[r.status] = Number(r.n);
  return ok({ ...by, total: Object.values(by).reduce((a, b) => a + b, 0) });
});

/** 正文单独取，列表接口不带长文本 */
draftsAdmin.get('/:id', async (c) => {
  requireAdmin(c);
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '投稿不存在');
  return ok({ ...row, tags: parseTags(row.tags) });
});

const reviewSchema = z.object({ note: z.string().trim().max(500).optional(), publish: z.boolean().optional() });

/** POST /api/admin/drafts/:id/approve —— 通过并按开关写入仓库 */
draftsAdmin.post('/:id/approve', async (c) => {
  const admin = requireAdmin(c);
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '投稿不存在');
  if (row.status === 'approved') fail(409, '该投稿已通过');
  const parsed = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) fail(400, '参数有误');

  const now = Math.floor(Date.now() / 1000);
  const path = await postPath(c.env, row);
  const authorRows = await db
    .select({ name: users.name, handle: users.handle, authorVerified: users.authorVerified })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  const markdown = buildPostMarkdown({ ...row, publishedAt: now }, authorKeyFor(authorRows[0]));

  let synced = false;
  let syncError: string | null = null;
  let commit: string | null = null;
  const autoPublish = await getConfigBool(c.env, 'gitWritebackEnabled', false);
  if (parsed.data.publish !== false && autoPublish) {
    try {
      const settings = await repoTarget(c.env);
      const result = await writeFile({ ...settings, path, content: markdown, message: `zero-cms: 投稿发布 ${row.title}` });
      synced = result.success;
      syncError = result.success ? null : result.error ?? '提交失败';
      commit = result.success ? result.sha ?? null : null;
    } catch (e) {
      syncError = e instanceof Error ? e.message : String(e);
    }
  } else {
    syncError = autoPublish ? '已跳过写入' : '未开启 Git 回写，仅标记通过';
  }

  await db
    .update(postDrafts)
    .set({
      status: 'approved',
      reviewerId: admin.id,
      reviewNote: parsed.data.note || null,
      publishedPath: synced ? path : null,
      publishedAt: synced ? now : null,
      updatedAt: now,
    })
    .where(eq(postDrafts.id, row.id));

  if (synced) await triggerPagesBuild(c.env);
  await writeAudit(c.env, {
    actor: admin,
    action: 'draft',
    target: row.id,
    detail: { event: 'approve', slug: row.slug, path, synced, syncError, commit },
    ip: clientIp(c),
  });
  // 结论已经落库，邮件只是补一句告知：发不出去也照样算通过
  const mail = await sendDraftReviewResult(c.env, { ...row, status: 'pending', publishedPath: synced ? path : null, reviewNote: parsed.data.note ?? row.reviewNote }, true, parsed.data.note);
  return ok({ id: row.id, status: 'approved', synced, syncError, path: synced ? path : null, ...mail });
});

/** 已通过但没进仓库的（当时没开回写或提交失败），补一次 */
draftsAdmin.post('/:id/publish', async (c) => {
  const admin = requireAdmin(c);
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '投稿不存在');
  if (row.status !== 'approved') fail(400, '只有已通过的投稿可以补发布');

  const path = await postPath(c.env, row);
  const authorRows = await db
    .select({ name: users.name, handle: users.handle, authorVerified: users.authorVerified })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  const now = Math.floor(Date.now() / 1000);
  const settings = await repoTarget(c.env);
  const result = await writeFile({
    ...settings,
    path,
    content: buildPostMarkdown({ ...row, publishedAt: row.publishedAt ?? now }, authorKeyFor(authorRows[0])),
    message: `zero-cms: 补发布投稿 ${row.title}`,
  });
  if (!result.success) fail(502, result.error ?? '提交失败');
  await db
    .update(postDrafts)
    .set({ publishedPath: path, publishedAt: row.publishedAt ?? now, updatedAt: now })
    .where(eq(postDrafts.id, row.id));
  await triggerPagesBuild(c.env);
  await writeAudit(c.env, { actor: admin, action: 'draft', target: row.id, detail: { event: 'republish', path, commit: result.sha }, ip: clientIp(c) });
  return ok({ id: row.id, synced: true, path, commit: result.sha ?? null });
});

draftsAdmin.post('/:id/reject', async (c) => {
  const admin = requireAdmin(c);
  const parsed = reviewSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) fail(400, '参数有误');
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '投稿不存在');
  await db
    .update(postDrafts)
    .set({ status: 'rejected', reviewerId: admin.id, reviewNote: parsed.data.note || null, updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(postDrafts.id, row.id));
  await writeAudit(c.env, { actor: admin, action: 'draft', target: row.id, detail: { event: 'reject', note: parsed.data.note }, ip: clientIp(c) });
  const mail = await sendDraftReviewResult(c.env, { ...row, status: 'pending', reviewNote: parsed.data.note ?? row.reviewNote }, false, parsed.data.note);
  return ok({ id: row.id, status: 'rejected', ...mail });
});

/**
 * PATCH /api/admin/drafts/:id —— 管理员代改稿件。
 * 只认六个字段，status / slug / lang 一律不动：改状态得走审核接口，
 * 改 slug 会让 published_path 与实际文件对不上。
 */
const draftEditSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().max(100).nullable().optional(),
  tags: z.array(z.string().trim().max(60)).max(30).optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  cover: z.string().trim().max(500).nullable().optional(),
  content: z.string().max(500_000).optional(),
});

draftsAdmin.patch('/:id', async (c) => {
  const admin = requireAdmin(c);
  const parsed = draftEditSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '参数有误：标题非空，标签最多 30 个');
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '投稿不存在');

  const b = parsed.data;
  const set: Record<string, unknown> = { updatedAt: Math.floor(Date.now() / 1000) };
  const changed: string[] = [];
  if (b.title !== undefined && b.title !== row.title) {
    set.title = b.title;
    changed.push('title');
  }
  if (b.category !== undefined && (b.category || null) !== row.category) {
    set.category = b.category || null;
    changed.push('category');
  }
  if (b.tags !== undefined) {
    const next = JSON.stringify(b.tags.map((t) => t.trim()).filter(Boolean));
    if (next !== row.tags) {
      set.tags = next;
      changed.push('tags');
    }
  }
  if (b.summary !== undefined && (b.summary || null) !== row.summary) {
    set.summary = b.summary || null;
    changed.push('summary');
  }
  if (b.cover !== undefined && (b.cover || null) !== row.cover) {
    set.cover = b.cover || null;
    changed.push('cover');
  }
  if (b.content !== undefined && b.content !== row.content) {
    set.content = b.content;
    changed.push('content');
  }

  if (changed.length) await db.update(postDrafts).set(set).where(eq(postDrafts.id, row.id));
  await writeAudit(c.env, {
    actor: admin,
    action: 'draft',
    target: row.id,
    detail: { event: 'edit', changed, status: row.status },
    ip: clientIp(c),
  });
  const after = changed.length ? (await db.select().from(postDrafts).where(eq(postDrafts.id, row.id)).limit(1))[0] ?? row : row;
  return ok({ id: row.id, changed, tags: parseTags(after.tags), updatedAt: after.updatedAt });
});

/**
 * POST /api/admin/drafts/:id/withdraw —— 同意作者撤回。
 * 已经落到仓库的那篇要先删掉，删失败就不动数据库：留着 approved 记录，
 * 后台能看见「还在仓库里」，管理员可以修好仓库配置再来一次。
 */
draftsAdmin.post('/:id/withdraw', async (c) => {
  const admin = requireAdmin(c);
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '投稿不存在');
  // 只有作者发起了撤回才动仓库：否则这个口子会变成误删已发布文章的按钮
  if (row.status !== 'withdraw_requested') fail(409, `投稿当前是 ${row.status}，作者没有发起撤回申请`);

  const path = (row.publishedPath ?? '').trim();
  if (path) {
    const backend = await repoBackend(c.env);
    if (backend === 'none') {
      await writeAudit(c.env, {
        actor: admin,
        action: 'draft',
        target: row.id,
        detail: { event: 'withdraw', blocked: 'no-repo', path },
        ip: clientIp(c),
      });
      return ok({ id: row.id, deleted: false, path, error: '未配置内容仓库（或 GIT_LOCAL_DIR），无法删除已发布文件' });
    }
    const removed = await deleteRepoFile(c.env, path, `zero-cms: 作者撤回投稿 ${row.title}`, { actor: admin, ip: clientIp(c), action: 'draft' });
    if (!removed.success) {
      return ok({ id: row.id, deleted: false, path, error: removed.error ?? '仓库文件删除失败' });
    }
    // 文章下线了，顺手请 Pages 重建一次，否则线上还挂着旧文章
    await triggerPagesBuild(c.env);
  }

  await db.delete(postDrafts).where(eq(postDrafts.id, row.id));
  await writeAudit(c.env, {
    actor: admin,
    action: 'draft',
    target: row.id,
    detail: { event: 'withdraw', deleted: true, path: path || null, slug: row.slug },
    ip: clientIp(c),
  });
  const mail = await sendDraftReviewResult(c.env, { ...row, publishedPath: null }, true, '你的撤回申请已同意，文章已从站点移除。');
  return ok({ id: row.id, deleted: true, path: path || null, error: null, ...mail });
});

/** POST /api/admin/drafts/:id/withdraw-reject —— 驳回撤回申请：稿件保持已发布，理由留档 */
draftsAdmin.post('/:id/withdraw-reject', async (c) => {
  const admin = requireAdmin(c);
  const parsed = z.object({ note: z.string().trim().max(500).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) fail(400, '参数有误');
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '投稿不存在');
  if (row.status !== 'withdraw_requested') fail(409, `投稿当前是 ${row.status}，没有待处理的撤回申请`);

  const now = Math.floor(Date.now() / 1000);
  // 撤回到什么状态看它原来落到哪一步：已经发出去的回 approved，没发的回 pending 继续等审
  const next = row.publishedPath ? 'approved' : 'pending';
  await db
    .update(postDrafts)
    .set({ status: next, reviewerId: admin.id, reviewNote: parsed.data.note || row.reviewNote, updatedAt: now })
    .where(eq(postDrafts.id, row.id));
  await writeAudit(c.env, {
    actor: admin,
    action: 'draft',
    target: row.id,
    detail: { event: 'withdraw-reject', from: row.status, to: next, note: parsed.data.note ?? null },
    ip: clientIp(c),
  });
  // row.status 这里必然是 withdraw_requested，邮件按「撤回被驳回」的措辞发
  const mail = await sendDraftReviewResult(c.env, row, false, parsed.data.note ?? '你的撤回申请未获同意，文章继续保留。');
  return ok({ id: row.id, status: next, ...mail });
});

/** 驳回时顺手把稿子退回作者草稿箱，或直接删除 */
draftsAdmin.delete('/:id', async (c) => {
  const admin = requireAdmin(c);
  const id = c.req.param('id');
  await createDb(c.env).delete(postDrafts).where(eq(postDrafts.id, id));
  await writeAudit(c.env, { actor: admin, action: 'draft', target: id, detail: { event: 'delete' }, ip: clientIp(c) });
  return ok({ id, deleted: true });
});

/* ================= 作者认证审核 ================= */

export const authorsAdmin = new Hono<AppEnv>();

authorsAdmin.get('/', async (c) => {
  requireAdmin(c);
  const status = c.req.query('status') ?? '';
  const where = status && status !== 'all' ? eq(authorRequests.status, status) : undefined;
  const db = createDb(c.env);
  const base = db
    .select({
      id: authorRequests.id,
      userId: authorRequests.userId,
      penName: authorRequests.penName,
      bio: authorRequests.bio,
      social: authorRequests.social,
      reason: authorRequests.reason,
      status: authorRequests.status,
      adminNote: authorRequests.adminNote,
      reviewedAt: authorRequests.reviewedAt,
      createdAt: authorRequests.createdAt,
      authorName: users.name,
      authorEmail: users.email,
      authorHandle: users.handle,
      authorVerified: users.authorVerified,
    })
    .from(authorRequests)
    .leftJoin(users, eq(users.id, authorRequests.userId));
  const rows = await (where ? base.where(where) : base).orderBy(desc(authorRequests.createdAt)).limit(200);
  return ok({ items: rows.map((r) => ({ ...r, social: parseSocial(r.social) })) });
});

function parseSocial(raw: string): unknown[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 赞赏图 JSON：脏数据当没填，张数上限由 services/authors.ts 兜底 */
function parseDonateImages(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const verifySchema = z.object({
  penName: z.string().trim().min(1).max(64).optional(),
  /** 作者标识：小写字母/数字/短横线，通过后写进 users.handle */
  handle: z.string().trim().max(60).optional(),
  bio: z.string().trim().max(300).optional(),
  note: z.string().trim().max(500).optional(),
});

/** POST /api/admin/author-requests/:id/approve —— 通过后同步权限位与笔名、简介，并把资料写进作者表 */
authorsAdmin.post('/:id/approve', async (c) => {
  const admin = requireAdmin(c);
  const db = createDb(c.env);
  const rows = await db.select().from(authorRequests).where(eq(authorRequests.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '申请不存在');
  const parsed = verifySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) fail(400, '参数有误');
  const b = parsed.data;
  const now = Math.floor(Date.now() / 1000);
  const penName = b.penName || row.penName;
  const accounts = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  const account = accounts[0];
  if (!account) fail(404, '这份申请对应的账号已经不在了');

  const set: Record<string, unknown> = {
    name: penName,
    bio: b.bio ?? row.bio ?? null,
    authorVerified: true,
    canAuthor: true,
    /** 共创组：前台评论徽章与作者权益按 user_group 判定（routes/users.ts 不代它写这一位） */
    userGroup: 'coauthor',
    updatedAt: now,
  };
  if (b.handle) {
    const handle = canonHandle(b.handle);
    if (!handle) fail(400, '作者标识只能用英文、数字和短横线');
    const clash = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.handle, handle), sql`${users.id} <> ${row.userId}`))
      .limit(1);
    if (clash[0]) fail(409, `作者标识 ${handle} 已被其它账号占用`);
    set.handle = handle;
  }
  // 作者表的键：这次指定的标识优先，其次账号上已有的，再退回用户中心地址用的账号标识
  const fileHandle = String(set.handle ?? account.handle ?? account.accountSlug ?? '');

  await db
    .update(authorRequests)
    .set({ status: 'approved', reviewerId: admin.id, adminNote: b.note || null, reviewedAt: now })
    .where(eq(authorRequests.id, row.id));
  await db.update(users).set(set).where(eq(users.id, row.userId));

  /**
   * 资料落到 data/authors.yaml（前台作者卡片与赞赏入口读这个文件）。
   * 写失败不打断审核：权限位和结论已经落库，错误原文回给后台，管理员补好料再点一次即可。
   */
  let authorFile: { ok: boolean; path?: string; created?: boolean; error?: string };
  try {
    const email = account.email ?? '';
    const written = await upsertAuthor(
      c.env,
      {
        handle: fileHandle,
        name: penName,
        // 申请里留空就用邮箱的 Cravatar / QQ 头像，跟评论头像走同一条退化链
        avatar: (row.avatar || '').trim() || avatarForEmail(email),
        email,
        bioZh: b.bio ?? row.bio ?? '',
        website: row.website || account.website || '',
        verified: true,
        social: parseSocial(row.social) as AuthorSocialRow[],
        donate: parseDonateImages(row.donateImages),
      },
      { actor: admin, ip: clientIp(c) },
    );
    authorFile = { ok: true, path: written.path, created: written.created };
  } catch (e) {
    authorFile = { ok: false, error: errorMessage(e) };
  }

  await writeAudit(c.env, {
    actor: admin,
    action: 'authorRequest',
    target: row.id,
    detail: { event: 'approve', userId: row.userId, penName, handle: set.handle ?? (fileHandle || null), authorFile },
    ip: clientIp(c),
  });
  return ok({ id: row.id, status: 'approved', penName, handle: set.handle ?? (fileHandle || null), authorFile });
});

authorsAdmin.post('/:id/reject', async (c) => {
  const admin = requireAdmin(c);
  const parsed = z.object({ note: z.string().trim().max(500).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) fail(400, '参数有误');
  const db = createDb(c.env);
  const rows = await db.select().from(authorRequests).where(eq(authorRequests.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '申请不存在');
  await db
    .update(authorRequests)
    .set({ status: 'rejected', reviewerId: admin.id, adminNote: parsed.data.note || null, reviewedAt: Math.floor(Date.now() / 1000) })
    .where(eq(authorRequests.id, row.id));
  await writeAudit(c.env, { actor: admin, action: 'authorRequest', target: row.id, detail: { event: 'reject' }, ip: clientIp(c) });
  return ok({ id: row.id, status: 'rejected' });
});

authorsAdmin.delete('/:id', async (c) => {
  const admin = requireAdmin(c);
  const id = c.req.param('id');
  await createDb(c.env).delete(authorRequests).where(eq(authorRequests.id, id));
  await writeAudit(c.env, { actor: admin, action: 'authorRequest', target: id, detail: { event: 'delete' }, ip: clientIp(c) });
  return ok({ id, deleted: true });
});

