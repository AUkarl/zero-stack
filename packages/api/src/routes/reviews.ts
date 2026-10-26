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
import { withAdminAuthorBits } from '../services/admin-author';
import { purgePageUrls, type PurgeResult } from '../services/cf-purge';
import { purgePostTitleCache } from '../services/comment-notify';
import { postWebPath, postsDir } from '../services/frontmatter';
import { writeFile } from '../services/git';
import { finishRepoWrites, repoTarget } from '../services/git';
import { deleteRepoFile, repoBackend, type BuildHealth } from '../services/repo';
import { PLACEHOLDER_PREFIX, datedSlug } from '../lib/postName';
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
 * 文章 front matter 的 author 值 = data/authors.yaml 的键 = /author/<键>/ 的地址片段。
 * 三处必须是同一个串，否则署名点不进作者页、作者页也查不到那份资料：
 *   · 有作者标识（handle）就用它，认证流程与后台都会把它收成小写字母 / 数字 / 短横线；
 *   · 没有标识的老账号退回邮箱前缀（同样过 canonHandle）；
 *   · 连邮箱都没有才用昵称，最后兜「读者」。
 *
 * 以前第二档直接上昵称：中文 / 空格 / 大写写进 front matter 后，Hugo 生成的 term 是
 * urlize 之后的样子（"Zero Author" → zero-author），而 authors.yaml 里存的是原始那个键，
 * 于是署名看着正常、点进作者页却是一片空，文章数也和她真正写过的对不上。
 */
export function authorKeyFor(
  row: {
    role?: string | null;
    name: string | null;
    handle: string | null;
    email?: string | null;
    authorVerified: boolean | null;
  } | undefined,
): string {
  // 管理员恒为认证作者：handle 由 withAdminAuthorBits 补齐（库里没有时按注册信息推一个）
  const me = row ? withAdminAuthorBits(row) : row;
  const handle = (me?.handle ?? '').trim();
  if (handle) return handle;
  const fromMail = canonHandle(String(me?.email ?? '').split('@')[0] ?? '');
  if (fromMail) return fromMail;
  return (me?.name ?? '').trim() || '读者';
}

/**
 * 投稿人的作者条目：文章底部的作者框读 data/authors.yaml，缺这一条就只剩昵称，
 * 简介、网站、联系方式那一排全是空的。认证申请里填过的 social 一并带过来。
 * 内容没变时后端不会产生提交（写文件那层有 unchanged 判断），每篇通过都调一次也不吵。
 */
async function rememberSubmitterAuthor(env: Env, userId: string, actor: { id?: string | null; name?: string | null }): Promise<void> {
  const db = createDb(env);
  const rows = await db
    .select({
      role: users.role,
      name: users.name,
      handle: users.handle,
      email: users.email,
      bio: users.bio,
      website: users.website,
      // 作者表头像必填：先取账号自己填的那张（个人中心「我的资料」里那张），没有才按邮箱推
      image: users.image,
      authorVerified: users.authorVerified,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const me = rows[0];
  if (!me) return;
  const key = authorKeyFor(me);
  const reqs = await db
    .select({ social: authorRequests.social })
    .from(authorRequests)
    .where(and(eq(authorRequests.userId, userId), eq(authorRequests.status, 'approved')))
    .orderBy(desc(authorRequests.id))
    .limit(1);
  await upsertAuthor(
    env,
    {
      handle: key,
      name: me.name || key,
      avatar: (me.image ?? '').trim() || avatarForEmail(me.email || ''),
      email: me.email || '',
      bioZh: me.bio,
      website: me.website,
      verified: Boolean(withAdminAuthorBits(me).authorVerified),
      social: parseSocial(reqs[0]?.social ?? '[]') as AuthorSocialRow[],
    },
    { actor, ip: undefined },
  ).catch(() => undefined);
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

/**
 * 文章落盘目录与文件名：以后台「设置 → 内容仓库 → 文章目录」为准；没配就退回 <内容目录>/<语言>/posts。
 *
 * 文件名口径见 `lib/postName.ts`，与后台「新建文章」共用同一套：**填了文件名就按填的**
 * （中文与全角标点放行，只拒目录穿越与保留字符），**没填就用「发布那天 + 当天顺序号」**（20261020001.md）。
 * 没填时不拿标题当名字：中文标题直接当文件名时，Hugo 会把全角标点整段丢掉，生成出来的是
 * `/posts/命名测试标题含冒号/` 这种既长又要 percent-encode 的地址。
 * 序号是从仓库里那一天已有的文件名数出来的（`listRepoDir`），不新增表、不新增写入，
 * 也不会两篇拿到同一个号（同一天并发通过两篇才会撞，而后台的通过按钮是一篇一篇点的）；
 * 当天超过 999 篇自动进四位（202610201000.md）。
 *
 * 两条边界：
 *  - 只在「这篇还没写过文件」时分配 —— 已发布的沿用 `published_path` 里那个名字，
 *    改地址会让评论、统计、收藏的 key 与仓库里的文件对不上（见 PATCH /:id 那段注释）。
 *  - 写仓库失败时不把新名字落库（下一次「补发布」重新数一个号），
 *    否则这个号既没被占用、又会被别的文章拿走。
 */
async function postPath(env: Env, row: typeof postDrafts.$inferSelect): Promise<{ path: string; slug: string }> {
  const dir = await postsDir(env);
  let slug = row.slug;
  /* 没填文件名的投稿挂着 `draft-xxxxxx` 占位（account.ts 的 /drafts 就是这么写的）；
     这次改动之前建的旧草稿带着按标题剔出来的名字，那些按「作者填过」保留原样，不给已排队的稿子改名。 */
  const notFilled = !slug || slug.startsWith(PLACEHOLDER_PREFIX);
  if (notFilled && !String(row.publishedPath ?? '').trim()) slug = (await datedSlug(env, dir)) ?? slug;
  const path = `${dir}/${slug}.md`;
  // 与后台文章保存同一套判法：目录穿越与控制/保留字符才拒，中文与全角标点放行
  const segs = path.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..') || segs[0] !== 'content') {
    fail(400, '投稿的文件名不合法，无法写入仓库');
  }
  if (/[\u0000-\u001f<>:"|?*]/.test(path)) fail(400, '投稿的文件名含有系统保留字符，无法写入仓库');
  return { path, slug };
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
  const { path, slug } = await postPath(c.env, row);
  const authorRows = await db
    .select({
      role: users.role,
      name: users.name,
      handle: users.handle,
      // 没有标识的账号要按邮箱前缀推一个 author 键（昵称拼不出合法地址），所以邮箱得一起取
      email: users.email,
      authorVerified: users.authorVerified,
      accountSlug: users.accountSlug,
    })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  const markdown = buildPostMarkdown({ ...row, publishedAt: now }, authorKeyFor(authorRows[0]));

  let synced = false;
  let syncError: string | null = null;
  let contentSha: string | null = null;
  /*
   * 点「通过」就把文章写进仓库并触发构建 —— 以前这里还要先看设置里的「投稿通过后自动写入仓库」
   * （默认关着），于是站长点了通过、文章却还在库里没上线，得再点一次「补发」才对，
   * 而那一步在界面上看起来像失败了。开关已删：审核通过 = 发布，「补发」按钮留着当重试入口
   * （写仓库失败时状态仍是 approved + publishedPath 为空，补发就是补这一步）。
   */
  if (parsed.data.publish !== false) {
    try {
      if ((await repoBackend(c.env)) === 'none') {
        syncError = '未配置内容仓库（githubOwner/githubRepo + GITHUB_TOKEN，或本地 GIT_LOCAL_DIR），文章只标记通过、没写进站点';
      } else {
        const settings = await repoTarget(c.env);
        const result = await writeFile({ ...settings, path, content: markdown, message: `zero-cms: 投稿发布 ${row.title}` });
        synced = result.success;
        syncError = result.success ? null : result.error ?? '提交失败';
        contentSha = result.success ? result.sha ?? null : null;
      }
    } catch (e) {
      syncError = e instanceof Error ? e.message : String(e);
    }
  } else {
    syncError = '按提交时选的「只标记通过」处理，没写进仓库';
  }

  await db
    .update(postDrafts)
    .set({
      status: 'approved',
      reviewerId: admin.id,
      reviewNote: parsed.data.note || null,
      // 新名字只在真写进仓库那一刻落库：写失败时留着原标题名，补发会重新数一个号
      slug: synced ? slug : row.slug,
      publishedPath: synced ? path : null,
      publishedAt: synced ? now : null,
      updatedAt: now,
    })
    .where(eq(postDrafts.id, row.id));

  /* 通过就落仓库，等价于站长自己发了一篇新文章：front matter 是投稿人填的，
     日期写成 Hugo 认不了的样子会让整站构建失败，所以这里也要体检（以前只触发重建）。 */
  let buildHealth: BuildHealth | null = null;
  if (synced) {
    await rememberSubmitterAuthor(c.env, row.userId, admin);
    await purgePostTitleCache(c.env, [path]);
    buildHealth = (await finishRepoWrites(c.env, 1)).buildHealth;
  }
  await writeAudit(c.env, {
    actor: admin,
    action: 'draft',
    target: row.id,
    detail: { event: 'approve', slug: synced ? slug : row.slug, path, synced, syncError, contentSha, buildHealth },
    ip: clientIp(c),
  });
  // 结论已经落库，邮件只是补一句告知：发不出去也照样算通过
  const mail = await sendDraftReviewResult(c.env, { ...row, status: 'pending', publishedPath: synced ? path : null, reviewNote: parsed.data.note ?? row.reviewNote }, true, parsed.data.note);
  return ok({ id: row.id, status: 'approved', synced, syncError, path: synced ? path : null, buildHealth, ...mail });
});

/** 已通过但没进仓库的（当时没开回写或提交失败），补一次 */
draftsAdmin.post('/:id/publish', async (c) => {
  const admin = requireAdmin(c);
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '投稿不存在');
  if (row.status !== 'approved') fail(400, '只有已通过的投稿可以补发布');

  const { path, slug } = await postPath(c.env, row);
  const authorRows = await db
    .select({
      role: users.role,
      name: users.name,
      handle: users.handle,
      // 没有标识的账号要按邮箱前缀推一个 author 键（昵称拼不出合法地址），所以邮箱得一起取
      email: users.email,
      authorVerified: users.authorVerified,
      accountSlug: users.accountSlug,
    })
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
    .set({ slug, publishedPath: path, publishedAt: row.publishedAt ?? now, updatedAt: now })
    .where(eq(postDrafts.id, row.id));
  await rememberSubmitterAuthor(c.env, row.userId, admin);
  await purgePostTitleCache(c.env, [path]);
  const republishHealth = (await finishRepoWrites(c.env, 1)).buildHealth;
  await writeAudit(c.env, { actor: admin, action: 'draft', target: row.id, detail: { event: 'republish', slug, path, contentSha: result.sha, buildHealth: republishHealth }, ip: clientIp(c) });
  return ok({ id: row.id, synced: true, path, contentSha: result.sha ?? null, buildHealth: republishHealth });
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
  let purge: PurgeResult | null = null;
  let health: BuildHealth | null = null;
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
    const withdrawn = await finishRepoWrites(c.env, 1);
    health = withdrawn.buildHealth;
    // 重建只换掉源站那一份，边缘缓存里那条地址还能撑 7 天 —— 一并清掉
    purge = await purgePageUrls(c.env, [postWebPath(path)]);
  }

  await db.delete(postDrafts).where(eq(postDrafts.id, row.id));
  await writeAudit(c.env, {
    actor: admin,
    action: 'draft',
    target: row.id,
    detail: { event: 'withdraw', deleted: true, path: path || null, slug: row.slug, purge, buildHealth: health },
    ip: clientIp(c),
  });
  const mail = await sendDraftReviewResult(c.env, { ...row, publishedPath: null }, true, '你的撤回申请已同意，文章已从站点移除。');
  return ok({ id: row.id, deleted: true, path: path || null, purge, buildHealth: health, error: null, ...mail });
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
  let authorFile: {
    ok: boolean;
    path?: string;
    created?: boolean;
    error?: string;
    build?: Awaited<ReturnType<typeof finishRepoWrites>>['build'];
    buildHealth?: Awaited<ReturnType<typeof finishRepoWrites>>['buildHealth'];
  };
  try {
    const email = account.email ?? '';
    const written = await upsertAuthor(
      c.env,
      {
        handle: fileHandle,
        name: penName,
        // 头像以账号上「用户自己设置过的那张」为准，其次才是申请里填的；都没有才退回邮箱的
        // Cravatar / QQ 头像，跟评论头像走同一条退化链
        avatar:
          (account.image ?? '').trim() || (row.avatar ?? '').trim() || avatarForEmail(email),
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
    /* 认证通过 = 整份重写 data/authors.yaml —— 那是 Hugo 构建期读的数据文件，写坏了是
       「前台作者卡片与全站署名一起空白」，而这条路以前既没请重建也没体检：接口只回「已通过」。
       （草稿通过那条里的 rememberSubmitterAuthor 也写这份文件，但那条已经统一收过一次尾，
       所以只有这一条自己收尾，别一次点击跑两遍 hugo。） */
    const done = await finishRepoWrites(c.env, 1);
    authorFile.build = done.build;
    authorFile.buildHealth = done.buildHealth;
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

/**
 * POST /api/admin/author-requests/:id/send-back —— 把「已通过」的那份退回给申请人改资料。
 *
 * 只动申请单本身：状态回 'returned'、写下站长的意见、清掉审核时间。
 * 账号的认证位、作者标识、用户组、已发文章的署名一概不碰 —— 退回是为了让他把笔名、
 * 简介、头像、联系方式改对，不是撤销他的作者身份。
 * 他重新提交后这份会回到 'pending'，再核验一次即可。
 */
authorsAdmin.post('/:id/send-back', async (c) => {
  const admin = requireAdmin(c);
  const parsed = z.object({ note: z.string().trim().max(500).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) fail(400, '参数有误');
  const db = createDb(c.env);
  const rows = await db.select().from(authorRequests).where(eq(authorRequests.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '申请不存在');
  if (row.status !== 'approved') fail(409, '只有已通过的申请才需要退回；待核验的那份直接驳回就行');
  await db
    .update(authorRequests)
    .set({ status: 'returned', reviewerId: admin.id, adminNote: parsed.data.note || null, reviewedAt: null })
    .where(eq(authorRequests.id, row.id));
  await writeAudit(c.env, {
    actor: admin,
    action: 'authorRequest',
    target: row.id,
    detail: { event: 'send-back', userId: row.userId, note: parsed.data.note || '' },
    ip: clientIp(c),
  });
  return ok({ id: row.id, status: 'returned', note: parsed.data.note || '' });
});

authorsAdmin.delete('/:id', async (c) => {
  const admin = requireAdmin(c);
  const id = c.req.param('id');
  await createDb(c.env).delete(authorRequests).where(eq(authorRequests.id, id));
  await writeAudit(c.env, { actor: admin, action: 'authorRequest', target: id, detail: { event: 'delete' }, ip: clientIp(c) });
  return ok({ id, deleted: true });
});

