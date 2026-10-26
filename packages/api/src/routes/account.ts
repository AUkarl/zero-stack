/**
 * account.ts — 登录后的用户个人管理页（/account/me/）的后端
 *
 * 挂在 /api/account 下，全部要求登录；账号靠 ?u=@<account_slug>（或用户 id）定位：
 * 只能指向自己，管理员可以代管别人的账号（代管时只读与撤回类操作仍受同样规则约束）。
 *
 *   GET    /api/account/overview                     一页面板要的汇总
 *   GET    /api/account/comments                     我的评论（含待审、被拦截）
 *   PATCH  /api/account/comments/:id                 编辑自己的评论（会重新过审核）
 *   DELETE /api/account/comments/:id                 删除自己的评论（连回复一起）
 *   GET    /api/account/reactions?kind=like|star     我的点赞与收藏
 *   POST   /api/account/reactions/:id/withdraw       撤回
 *   GET    /api/account/friend-application           我的友链申请与审核结果
 *   POST   /api/account/friend-application           提交（字段与公开申请表单一致）
 *   PATCH  /api/account/friend-application/:id       改完重新排队
 *   DELETE /api/account/friend-application/:id       撤回申请
 *   GET    /api/account/drafts                       我的投稿记录
 *   GET    /api/account/drafts/:id                   带正文
 *   POST   /api/account/drafts                       新建（submit:true 直接进审核）
 *   PATCH  /api/account/drafts/:id                   编辑草稿
 *   DELETE /api/account/drafts/:id                   删除草稿
 *   POST   /api/account/drafts/:id/submit            提交审核
 *   POST   /api/account/drafts/:id/withdraw-request  申请撤回（已发布的要站主同意才删文件）
 *   GET    /api/account/author-request               认证状态与历史
 *   POST   /api/account/author-request               提交认证（笔名/介绍/头像/个人站/8 平台/3 赞赏图）
 *   POST   /api/account/password                     改密码（要 current + 第二凭据）
 *   POST   /api/account/delete-request               申请注销（pending）
 *   GET    /api/account/delete-request               查进度与「会删掉什么」
 *
 * 后台侧另两个导出：
 *   deletionsAdmin   → /api/admin/deletions      GET / :id/approve / :id/reject
 *   withdrawalsAdmin → /api/admin/withdrawals     GET / :id/approve（删仓库文件）/ :id/reject
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import {
  accountDeletions,
  authorRequests,
  comments,
  friendApplications,
  friends,
  postDrafts,
  reactions,
  users,
  verifications,
} from '../db/schema';
import { requireAdmin, requireUser, sessionCookie } from '../middleware/auth';
import { destroyUserSessions, issueSession } from '../services/auth';
import { userGroupName, withAdminAuthorBits } from '../services/admin-author';
import { writeAudit } from '../services/audit';
import { getConfig, getConfigBool } from '../services/config';
import { deleteCommentSubtree } from '../services/comment-tree';
import { inspectComment, type Verdict } from '../services/moderation';
import { postTitle } from '../services/post-title';
import { PLACEHOLDER_PREFIX, fileNameProblem, normalizeFileName } from '../lib/postName';
import { emailHash, hashPassword, newId, verifyPassword } from '../lib/crypto';
import { clientIp, userAgent } from '../lib/http';
import { hashIp } from '../lib/ua';
import { rateLimit } from '../lib/rate-limit';
import { fail, ok } from '../lib/errors';
import { normalizeFriendUrl } from '../services/links-yaml';
import { purgeUser, previewPurge } from '../services/account-purge';
import {
  checkTotp,
  emailOtpAvailable,
  githubAccountOf,
  githubProofValid,
  loginPolicy,
  planFactors,
  resolveAccountTarget,
  secondFactorChoices,
  securityMethods,
  verifyEmailOtp,
  type UserRow,
} from '../services/account-shared';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();
const deletionsAdmin = new Hono<AppEnv>();

const MAX_CONTENT = 5000;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** errors.ts 的 fail() 只收录了常用状态码，这里要 4xx 的其它码时自己拼一个同形状响应 */
function failWith(status: number, message: string, extra: Record<string, unknown> = {}): never {
  throw new HTTPException(status as 400, { res: Response.json({ error: status, message, ...extra }, { status }) });
}

function isSecure(c: Context): boolean {
  return c.req.url.startsWith('https://');
}

/** 头像：本人传了 URL 就用它，留空按邮箱走后台配的头像服务（cravatar/Gravatar 模板） */
async function avatarOf(env: Env, row: UserRow): Promise<string> {
  if (row.image) return row.image;
  const template = await getConfig(env, 'avatarTemplate');
  if (!template) return '';
  const { algo, hash } = await emailHash(row.email);
  if (algo !== 'md5' || !hash) return '';
  return template.replaceAll('{hash}', hash).replaceAll('{email}', encodeURIComponent(row.email));
}

function shapeUser(source: UserRow, avatar: string) {
  // 管理员恒为认证作者 + 全权限（services/admin-author.ts），界面与门栏都读这份口径
  const row = withAdminAuthorBits(source);
  return {
    id: row.id,
    name: row.name,
    handle: row.handle,
    email: row.email,
    emailVerified: row.emailVerified,
    image: row.image,
    avatar,
    bio: row.bio,
    website: row.website,
    role: row.role,
    status: row.status,
    isAdmin: row.role === 'admin',
    accountSlug: row.accountSlug,
    account_slug: row.accountSlug,
    userGroup: row.userGroup,
    user_group: row.userGroup,
    userGroupName: userGroupName(row),
    authorVerified: row.authorVerified,
    author_verified: row.authorVerified,
    canPublish: row.canPublish,
    can_publish: row.canPublish,
    canAuthor: row.canAuthor,
    can_author: row.canAuthor,
    createdAt: row.createdAt,
    centerUrl: row.accountSlug ? `/account/me/?u=@${row.accountSlug}` : '/account/me/',
  };
}

async function countOf(env: Env, userId: string): Promise<Record<string, number>> {
  const db = createDb(env);
  const one = async (table: any, where: any): Promise<number> => {
    const rows = await db.select({ n: sql<number>`count(*)` }).from(table).where(where);
    return Number(rows[0]?.n ?? 0);
  };
  return {
    comments: await one(comments, and(eq(comments.authorType, 'user'), eq(comments.authorId, userId))),
    likes: await one(reactions, and(eq(reactions.userId, userId), eq(reactions.kind, 'like'))),
    stars: await one(reactions, and(eq(reactions.userId, userId), eq(reactions.kind, 'star'))),
    drafts: await one(postDrafts, eq(postDrafts.userId, userId)),
    friendApplications: await one(friendApplications, eq(friendApplications.userId, userId)),
    authorRequests: await one(authorRequests, eq(authorRequests.userId, userId)),
  };
}

/* ------------------------------------------------------------------ 汇总 */

/** GET /api/account/overview —— 用户中心一进来只要一次这个请求就能把面板填满 */
app.get('/overview', async (c) => {
  const { target, self, isAdmin } = await resolveAccountTarget(c);
  const env = c.env;
  const avatar = await avatarOf(env, target);
  const plan = await planFactors(env, target);
  const pendingDeletion = await createDb(env)
    .select()
    .from(accountDeletions)
    .where(eq(accountDeletions.userId, target.id))
    .orderBy(desc(accountDeletions.createdAt))
    .limit(1);

  return ok({
    account: shapeUser(target, avatar),
    counts: await countOf(env, target.id),
    viewing: { self, isAdmin, mode: self ? 'self' : 'admin' },
    security: {
      totpEnabled: target.totpEnabled,
      githubLinked: Boolean(await githubAccountOf(env, target.id)),
      policy: await loginPolicy(env),
      required: { password: plan.password, emailCode: plan.emailCode, totp: plan.totp, githubOnly: plan.githubOnly },
      notice: plan.notice,
      methods: await securityMethods(env, target),
      secondFactors: await secondFactorChoices(env, target),
    },
    gates: {
      draftsEnabled: await getConfigBool(env, 'draftsEnabled', true),
      authorVerifyEnabled: await getConfigBool(env, 'authorVerifyEnabled', true),
      friendApplyEnabled: await getConfigBool(env, 'friendApplyEnabled', true),
      commentsEnabled: await getConfigBool(env, 'commentEnabled', true),
      likeEnabled: await getConfigBool(env, 'likeEnabled', true),
      starEnabled: await getConfigBool(env, 'starEnabled', true),
      canPublish: target.canPublish || target.role === 'admin',
      canAuthor: target.canAuthor || target.role === 'admin',
    },
    deleteRequest: pendingDeletion[0]
      ? {
          id: pendingDeletion[0].id,
          status: pendingDeletion[0].status,
          reason: pendingDeletion[0].reason,
          reviewNote: pendingDeletion[0].reviewNote,
          createdAt: pendingDeletion[0].createdAt,
          reviewedAt: pendingDeletion[0].reviewedAt,
        }
      : null,
    selfDeletionAllowed: target.role !== 'admin',
  });
});

/* ------------------------------------------------------------------ 我的评论 */

const commentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['all', 'approved', 'pending', 'spam', 'rejected']).default('all'),
});

app.get('/comments', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const parsed = commentQuery.safeParse(c.req.query());
  if (!parsed.success) fail(400, '参数有误');
  const { limit, offset, status } = parsed.data;

  const conds = [eq(comments.authorType, 'user'), eq(comments.authorId, target.id)];
  if (status !== 'all') conds.push(eq(comments.status, status));
  const rows = await createDb(c.env)
    .select({
      id: comments.id,
      postSlug: comments.postSlug,
      parentId: comments.parentId,
      rootId: comments.rootId,
      depth: comments.depth,
      content: comments.content,
      status: comments.status,
      spamReason: comments.spamReason,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      editedAt: comments.editedAt,
    })
    .from(comments)
    .where(and(...conds))
    .orderBy(desc(comments.createdAt))
    .limit(limit)
    .offset(offset);

  /*
   * 被拦截的评论只告诉本人「没过审」这一件事：spamReason 里是命中了哪条规则、
   * 哪条关键词、几分 —— 那是站主的审核依据，写给用户看等于把过滤器的说明书公开了，
   * 人家照着改两个字就能绕过。规则细节仍然原样存在库里，后台「评论审核」看得见。
   */
  return ok({
    total: rows.length,
    status,
    items: rows.map((r) => ({
      ...r,
      spamReason: r.status === 'approved' || r.status === 'pending' ? null : '内容不符合本站社区规范，未通过审核',
    })),
  });
});

const commentEditSchema = z.object({ content: z.string().trim().min(1).max(MAX_CONTENT) });

/** PATCH /api/account/comments/:id —— 与 /api/comments/:id 同规则：本人改完必须重新过审核 */
app.patch('/comments/:id', async (c) => {
  const user = requireUser(c);
  await resolveAccountTarget(c); // 归属校验：本接口只动自己的评论
  const parsed = commentEditSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, `评论内容不能为空且不超过 ${MAX_CONTENT} 字`);
  const content = parsed.data.content.trim();

  const db = createDb(c.env);
  const rows = await db.select().from(comments).where(eq(comments.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '评论不存在');
  const isSelf = row.authorType === 'user' && row.authorId === user.id;
  if (!isSelf && user.role !== 'admin') fail(403, '只能编辑自己的评论');

  const now = nowSec();
  const set: Record<string, unknown> = { content, updatedAt: now };
  let status = row.status;
  if (isSelf) {
    set.editedAt = now;
    // 站长/管理员改自己的评论不再扫描；其余人重新过一次审核，审核报错时转人工而不是直接放行
    if (user.role !== 'admin' && (await getConfigBool(c.env, 'spamEnabled', true))) {
      let verdict: Verdict;
      try {
        verdict = await inspectComment(c.env, {
          content,
          authorName: row.authorName,
          authorEmail: row.authorEmail,
          authorLink: row.authorLink,
          ipHash: row.ipHash || (await hashIp(clientIp(c), c.env)),
          authenticated: true,
          createdAt: user.createdAt,
        });
      } catch (err) {
        console.warn('[account] 编辑评论审核异常，这条转人工待审', err);
        verdict = { spam: true, score: 0, reason: '审核流程异常，已转人工', hold: true };
      }
      set.spamScore = verdict.score;
      set.spamReason = verdict.reason || null;
      if (verdict.spam) status = verdict.hold ? 'pending' : 'spam';
      set.status = status;
    }
  }
  await db.update(comments).set(set).where(eq(comments.id, row.id));
  await writeAudit(c.env, { actor: user, action: 'comment', target: row.id, detail: { event: 'self-edit', status }, ip: clientIp(c) });
  return ok({ id: row.id, content, status, editedAt: set.editedAt ?? row.editedAt });
});

/** DELETE /api/account/comments/:id —— 自己的评论连同下面的回复一起删 */
app.delete('/comments/:id', async (c) => {
  const user = requireUser(c);
  const id = c.req.param('id');
  const db = createDb(c.env);
  const rows = await db.select({ authorType: comments.authorType, authorId: comments.authorId }).from(comments).where(eq(comments.id, id)).limit(1);
  const row = rows[0];
  if (!row) fail(404, '评论不存在');
  const isSelf = row.authorType === 'user' && row.authorId === user.id;
  if (!isSelf && user.role !== 'admin') fail(403, '只能删除自己的评论');

  const deletedCount = await deleteCommentSubtree(c.env, id);
  await writeAudit(c.env, { actor: user, action: 'comment', target: id, detail: { event: 'self-delete', deletedCount }, ip: clientIp(c) });
  return ok({ id, deleted: true, deletedCount });
});

/* ------------------------------------------------------------------ 点赞与收藏 */

const reactionQuery = z.object({
  kind: z.enum(['like', 'star']).default('like'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** GET /api/account/reactions?kind=like|star —— 标题拿得到就带上，拿不到只回 slug */
app.get('/reactions', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const parsed = reactionQuery.safeParse(c.req.query());
  if (!parsed.success) fail(400, 'kind 只能是 like 或 star');
  const { kind, limit, offset } = parsed.data;

  const db = createDb(c.env);
  const rows = await db
    .select({ id: reactions.id, slug: reactions.targetSlug, kind: reactions.kind, createdAt: reactions.createdAt })
    .from(reactions)
    .where(and(eq(reactions.userId, target.id), eq(reactions.kind, kind)))
    .orderBy(desc(reactions.createdAt))
    .limit(limit)
    .offset(offset);

  const titles = await reactionTitles(c.env, db, target.id, rows.map((r) => r.slug));

  return ok({
    kind,
    total: rows.length,
    items: rows.map((r) => ({
      ...r,
      /** post = 站内文章（该有标题）；moment = 时刻卡片（按设计就没有标题）；other = 认不出来的地址 */
      target: /^\/moments\/|^moments\//.test(r.slug) ? 'moment' : /^\/posts\/|^posts\//.test(r.slug) ? 'post' : 'other',
      title: titles.get(normSlug(r.slug)) ?? null,
    })),
  });
});

/** 去掉首尾斜杠，仓库文件名与站内地址都用这一份口径比对 */
function normSlug(s: string): string {
  return String(s ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * 点赞 / 收藏的目标标题。
 *
 * reactions 表只存了 targetSlug，标题在两个地方：自己投稿那张表里（含还没发布的），
 * 以及内容仓库的 posts 目录（管理员直接在后台写的文章不进 post_drafts，
 * 所以以前只查投稿表的结果就是：别人写的文章、甚至站长自己发的文章，前台一律显示
 * 「未同步标题」）。时刻卡片按设计没有标题，不查，也不该让人以为同步坏了。
 *
 * 成本控住：目录只列一次，然后只读这次真正用到的那几个文件（最多 40 个）。
 */
async function reactionTitles(env: Env, db: ReturnType<typeof createDb>, userId: string, slugs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const posts = [...new Set(slugs.map(normSlug).filter((s) => s.startsWith('posts/')))];
  if (!posts.length) return out;

  const want = new Set(posts);

  try {
    const known = await db
      .select({ slug: sql<string>`concat('/', ${postDrafts.slug})`, title: postDrafts.title })
      .from(postDrafts)
      .where(and(eq(postDrafts.userId, userId), inArray(sql`concat('/', post_drafts.slug)`, posts.map((p) => `/${p}`))));
    for (const r of known) {
      const k = normSlug(r.slug);
      if (r.title && !out.has(k)) out.set(k, String(r.title));
      want.delete(k);
    }
  } catch {
    /* 投稿表读失败不影响去仓库找 */
  }
  if (!want.size) return out;

  /* 剩下的去仓库认。口径全在 services/post-title（扁平与页面包都认、认 linkTitle、按文章号缓存 24 小时），
     这里不再自己 parse 一份 —— 以前那一份只认扁平 `<名>.md`，页面包的文章在「我的主页」上就显示成日期串 slug。 */
  for (const slug of [...want].slice(0, 40)) {
    const title = await postTitle(env, slug);
    if (title) out.set(slug, title);
  }
  return out;
}

/** POST /api/account/reactions/:id/withdraw —— 撤回自己点出去的赞或收藏 */
app.post('/reactions/:id/withdraw', async (c) => {
  const user = requireUser(c);
  const id = c.req.param('id');
  const db = createDb(c.env);
  const rows = await db.select({ userId: reactions.userId, targetSlug: reactions.targetSlug, kind: reactions.kind }).from(reactions).where(eq(reactions.id, id)).limit(1);
  const row = rows[0];
  if (!row) fail(404, '记录不存在');
  if (row.userId !== user.id && user.role !== 'admin') fail(403, '只能撤回自己的点赞或收藏');
  await db.delete(reactions).where(eq(reactions.id, id));
  return ok({ id, withdrawn: true, slug: row.targetSlug, kind: row.kind });
});

/* ------------------------------------------------------------------ 友链设置 */

const httpUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => /^https?:\/\/[^\s]+\.[^\s]+/i.test(v), { message: '站点地址需为 http(s) 开头的完整网址' });

const optionalUrl = z
  .string()
  .trim()
  .max(300)
  .optional()
  .or(z.literal(''))
  .refine((v) => !v || /^https?:\/\/[^\s]+\.[^\s]+/i.test(v), { message: '需为 http(s) 开头的完整网址' });

/** 字段与公开申请表单一致：站点名称 / 站点地址 / 站长邮箱 / rss / 头像 / friendLink（url 的别名）/ 简介 */
const friendSchema = z.object({
  name: z.string().trim().min(1).max(60),
  url: httpUrl.optional(),
  friendLink: httpUrl.optional(),
  description: z.string().trim().max(200).optional().or(z.literal('')),
  avatar: optionalUrl,
  rssUrl: optionalUrl,
  email: z.string().trim().email().max(120).optional().or(z.literal('')),
  reason: z.string().trim().max(500).optional().or(z.literal('')),
});

const friendShape = (row: typeof friendApplications.$inferSelect) => ({
  id: row.id,
  name: row.name,
  url: row.url,
  description: row.description,
  avatar: row.avatar,
  rssUrl: row.rssUrl,
  email: row.email,
  reason: row.reason,
  status: row.status,
  reviewNote: row.reviewNote,
  createdAt: row.createdAt,
  reviewedAt: row.reviewedAt,
  publishedFriendId: row.publishedFriendId,
});

app.get('/friend-application', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const rows = await createDb(c.env)
    .select()
    .from(friendApplications)
    .where(eq(friendApplications.userId, target.id))
    .orderBy(desc(friendApplications.createdAt))
    .limit(50);
  return ok({ total: rows.length, items: rows.map(friendShape), latest: rows[0] ? friendShape(rows[0]) : null });
});

/** 与公开口子同一套查重规则，只是提交人固定是当前登录账号 */
async function upsertFriendApplication(c: Context, target: UserRow, input: z.infer<typeof friendSchema>) {
  const url = (input.url || input.friendLink || '').trim();
  if (!url) fail(400, '请填写站点地址');
  const normalized = normalizeFriendUrl(url);
  const db = createDb(c.env);

  const listed = await db.select({ url: friends.url }).from(friends).limit(500);
  if (listed.some((f) => normalizeFriendUrl(f.url) === normalized)) fail(409, '该站点已在友链列表中');
  const own = await getConfig(c.env, 'siteUrl');
  if (own && normalizeFriendUrl(own) === normalized) fail(400, '这是本站自己的地址');

  const mine = await db
    .select()
    .from(friendApplications)
    .where(and(eq(friendApplications.userId, target.id), eq(friendApplications.url, url)))
    .limit(1);
  const existing = mine[0];
  const now = nowSec();
  const values = {
    description: input.description || null,
    avatar: input.avatar || null,
    rssUrl: input.rssUrl || null,
    email: input.email || null,
    reason: input.reason || null,
  };

  if (existing) {
    if (existing.status === 'pending') failWith(409, '该站点已提交过申请，正在审核中');
    await db
      .update(friendApplications)
      .set({
        ...values,
        name: input.name,
        status: 'pending',
        reviewerId: null,
        reviewNote: null,
        reviewedAt: null,
      })
      .where(eq(friendApplications.id, existing.id));
    await writeAudit(c.env, { actor: target, action: 'friendApp', target: url, detail: { event: 'account-resubmitted', id: existing.id }, ip: clientIp(c) });
    return ok({ id: existing.id, status: 'pending', message: '已重新提交，站主会再审核一次' });
  }

  const id = newId();
  await db.insert(friendApplications).values({ id, userId: target.id, name: input.name, url, ...values, status: 'pending', ip: clientIp(c), createdAt: now });
  await writeAudit(c.env, { actor: target, action: 'friendApp', target: url, detail: { event: 'account-submitted', id }, ip: clientIp(c) });
  return ok({ id, status: 'pending', message: '已提交，站主审核通过后会出现在友链页' });
}

app.post('/friend-application', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const parsed = friendSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '站点名称与站点地址为必填');
  // upsertFriendApplication 自己就返回 ok(...)，这里不能再包一层 data
  return await upsertFriendApplication(c, target, { ...parsed.data, friendLink: parsed.data.friendLink || parsed.data.url });
});

/* ------------------------------------------------------------------ 改密码 */

const passwordSchema = z.object({
  current: z.string().max(200).optional(),
  next: z.string().trim().min(8).max(200),
  /** 第二凭据：邮箱验证码 / 身份验证器 / 已绑定的 GitHub，任一即可 */
  second: z.enum(['email', 'totp', 'github']),
  code: z.string().trim().max(16).optional(),
});

/**
 * 邮箱验证码这一路：码必须是发给本账号邮箱、且领取时就锁定在本账号上的那一条
 * （POST /api/auth/send-code 的 scene 为 password / reset，落库标识都是 otp:<邮箱>，
 * 记录里的 userId 就是「这码发给谁」的凭证，别人的登录码在这里用不上）。
 */
async function emailCodeForPassword(c: Context, target: UserRow, code: string | undefined): Promise<void> {
  if (!await emailOtpAvailable(c.env)) {
    failWith(500, '本站还没配好邮件通道，邮箱验证码这条路暂时不可用，请改选身份验证器或 GitHub');
  }
  if (!code) failWith(400, '请输入邮箱收到的 6 位验证码', { next: 'email-code' });

  const rows = await createDb(c.env)
    .select({ value: verifications.value })
    .from(verifications)
    .where(eq(verifications.identifier, `otp:${target.email}`))
    .limit(1);
  if (!rows[0]) failWith(400, '还没有收到验证码，或验证码已过期，请重新获取', { next: 'email-code' });
  let owner: string | null = null;
  try {
    owner = (JSON.parse(rows[0].value ?? '{}') as { userId?: string | null }).userId ?? null;
  } catch {
    owner = null;
  }
  if (owner && owner !== target.id) failWith(403, '这份验证码不是为本账号申请的，请重新获取', { next: 'email-code' });

  const check = await verifyEmailOtp(c.env, target.email, code);
  if (!check.ok) failWith(400, check.message ?? '验证码不正确', { next: 'email-code' });
}

/** POST /api/account/password —— 当前密码 + 第二凭据，缺一不可 */
app.post('/password', async (c) => {
  const user = requireUser(c);
  const { target, self } = await resolveAccountTarget(c);
  if (!self) fail(403, '只能修改自己的密码');

  const parsed = passwordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '新密码至少 8 位，第二凭据只能是 email / totp / github');
  const { current, next, second, code } = parsed.data;

  await rateLimit(c, 'account-password', 10, 3600, target.id);

  const stored = target.passwordHash;
  if (!stored) failWith(400, '本账号没有设置过密码，无需修改；请用 GitHub 登录或联系站主');
  if (!current) failWith(400, '请输入当前密码');
  if (!(await verifyPassword(current, stored))) failWith(401, '当前密码不正确');
  if (current === next) failWith(400, '新密码不能与当前密码相同');

  if (second === 'email') {
    await emailCodeForPassword(c, target, code);
  } else if (second === 'totp') {
    if (!target.totpEnabled) failWith(400, '本账号还没绑定身份验证器，请改选邮箱验证码或 GitHub');
    if (!code) failWith(400, '请输入验证器上的 6 位动态码', { next: 'totp' });
    // checkTotp 内部解密密钥并带 KV 防重放：同一个时间步长的码交第二次就失效
    if (!(await checkTotp(c.env, target, code))) failWith(401, '动态码不正确或已经用过', { next: 'totp' });
  } else {
    const linked = await githubAccountOf(c.env, target.id);
    if (!linked) failWith(400, '本账号没有绑定 GitHub，请改选邮箱验证码或身份验证器');
    if (!(await githubProofValid(c.env, linked))) failWith(403, 'GitHub 授权已失效，请重新绑定后再改密码');
  }

  const now = nowSec();
  await createDb(c.env).update(users).set({ passwordHash: await hashPassword(next), updatedAt: now }).where(eq(users.id, target.id));

  // 改密即作废全部旧会话，再给当前浏览器换一枚新 token：其它设备下次要重新登录
  await destroyUserSessions(c.env, target.id);
  const { token, expiresAt } = await issueSession(c.env, target.id, { ip: clientIp(c), userAgent: userAgent(c) });
  c.header('Set-Cookie', sessionCookie(token, Math.max(0, expiresAt - now), isSecure(c)));

  await writeAudit(c.env, { actor: user, action: 'user', target: target.id, detail: { event: 'password.change', second }, ip: clientIp(c) });
  return ok({ changed: true, updatedAt: now, message: '密码已更新，其它设备需要重新登录' });
});

/* ------------------------------------------------------------------ 账号注销申请 */

const deletionSchema = z.object({
  reason: z.string().trim().max(500).optional().or(z.literal('')),
  /** 双重确认：要原样输入账号标识或注册邮箱，勾个框不算确认 */
  confirm: z.union([z.string(), z.boolean()]),
});

function confirmMatches(target: UserRow, confirm: string | boolean): boolean {
  if (typeof confirm !== 'string') return false;
  const typed = confirm.trim().toLowerCase().replace(/^@/, '');
  const slug = String(target.accountSlug ?? '').toLowerCase();
  return Boolean((slug && typed === slug) || (typed && typed === String(target.email ?? '').toLowerCase()));
}

/** POST /api/account/delete-request —— 只登记申请，真正删除由站主在后台 approve */
app.post('/delete-request', async (c) => {
  const { target, self } = await resolveAccountTarget(c);
  if (!self) fail(403, '只能为自己的账号提交注销申请');
  if (target.role === 'admin') fail(403, '管理员账号不能自助注销，请先在后台把管理员权限交给别的账号');

  const parsed = deletionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '请填写注销原因与确认信息');
  const keyword = `@${target.accountSlug ?? target.id}`;
  if (!confirmMatches(target, parsed.data.confirm)) {
    failWith(400, `注销是不可撤销的：请在确认框内输入你的账号标识 ${keyword}（或注册邮箱）`, { need: keyword, email: target.email });
  }

  const db = createDb(c.env);
  const pending = await db
    .select({ id: accountDeletions.id })
    .from(accountDeletions)
    .where(and(eq(accountDeletions.userId, target.id), eq(accountDeletions.status, 'pending')))
    .limit(1);
  if (pending[0]) failWith(409, '已有正在审核中的注销申请，请勿重复提交', { id: pending[0].id });

  const id = newId();
  await db
    .insert(accountDeletions)
    .values({ id, userId: target.id, reason: parsed.data.reason || null, status: 'pending', createdAt: nowSec() });
  await writeAudit(c.env, {
    actor: target,
    action: 'user',
    target: target.id,
    detail: { event: 'deletion.request', id, willDelete: await previewPurge(c.env, target.id) },
    ip: clientIp(c),
  });
  return ok({ id, status: 'pending', message: '注销申请已提交，站主通过后本账号的全部数据会被删除' });
});

/** GET /api/account/delete-request —— 查进度，并给出「通过后到底会删掉什么」 */
app.get('/delete-request', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const rows = await createDb(c.env)
    .select()
    .from(accountDeletions)
    .where(eq(accountDeletions.userId, target.id))
    .orderBy(desc(accountDeletions.createdAt))
    .limit(1);
  const row = rows[0] ?? null;
  const willDelete = await previewPurge(c.env, target.id);
  const request = row
    ? { id: row.id, status: row.status, reason: row.reason, createdAt: row.createdAt, reviewedAt: row.reviewedAt, reviewNote: row.reviewNote }
    : null;
  return ok({
    status: row?.status ?? 'none',
    createdAt: row?.createdAt ?? null,
    reviewedAt: row?.reviewedAt ?? null,
    reviewNote: row?.reviewNote ?? null,
    reason: row?.reason ?? null,
    request,
    willDelete,
    totalToDelete: Object.values(willDelete).reduce((a, b) => a + b, 0),
    canSelfDelete: target.role !== 'admin',
    confirmWith: `@${target.accountSlug ?? target.id}`,
    email: target.email,
  });
});

/* ------------------------------------------------------------------ 后台：注销申请 */

/** GET /api/admin/deletions —— 默认只看待处理的，?status=all 看全部 */
deletionsAdmin.get('/', async (c) => {
  requireAdmin(c);
  const status = (c.req.query('status') ?? 'pending').trim();
  const db = createDb(c.env);
  const where = status === 'all' ? undefined : eq(accountDeletions.status, status);
  const rows = await db
    .select({
      id: accountDeletions.id,
      userId: accountDeletions.userId,
      reason: accountDeletions.reason,
      status: accountDeletions.status,
      reviewNote: accountDeletions.reviewNote,
      reviewerId: accountDeletions.reviewerId,
      createdAt: accountDeletions.createdAt,
      reviewedAt: accountDeletions.reviewedAt,
      accountName: users.name,
      accountEmail: users.email,
      accountSlug: users.accountSlug,
      accountHandle: users.handle,
      accountRole: users.role,
      accountStatus: users.status,
    })
    .from(accountDeletions)
    .leftJoin(users, eq(users.id, accountDeletions.userId))
    .where(where)
    .orderBy(desc(accountDeletions.createdAt))
    .limit(300);
  const grouped = await db.select({ status: accountDeletions.status, n: sql<number>`count(*)` }).from(accountDeletions).groupBy(accountDeletions.status);
  const byStatus: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const g of grouped) byStatus[g.status] = Number(g.n);

  return ok({
    status,
    total: rows.length,
    byStatus,
    items: rows.map((r) => ({
      ...r,
      account_slug: r.accountSlug,
      centerUrl: r.accountSlug ? `/account/me/?u=@${r.accountSlug}` : '/account/me/',
      // 账号已经不在了（申请行随 users 级联删除，理论上见不到），前端据此禁用按钮
      missing: !r.accountEmail,
    })),
  });
});

/** POST /api/admin/deletions/:id/approve —— 通过后把这个账号的数据删干净 */
deletionsAdmin.post('/:id/approve', async (c) => {
  const admin = requireAdmin(c);
  const db = createDb(c.env);
  const rows = await db.select().from(accountDeletions).where(eq(accountDeletions.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '注销申请不存在');
  if (row.status !== 'pending') failWith(409, `该申请已是 ${row.status} 状态，不能重复处理`);
  if (row.userId === admin.id) failWith(400, '不能通过自己账号的注销申请');

  const found = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  const account = found[0];
  if (!account) {
    await db.delete(accountDeletions).where(eq(accountDeletions.id, row.id));
    fail(404, '该账号已不存在，申请已一并清除');
  }
  if (account.role === 'admin') {
    const still = await db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.role, 'admin'));
    if (Number(still[0]?.n ?? 0) <= 1) failWith(400, '这是站内唯一的管理员账号，注销前请先指定接班人');
  }

  const { deleted } = await purgeUser(c.env, row.userId);
  // 删 users 行时 D1 会把这条申请一起级联带走，这里再删一次只是保险
  await db.delete(accountDeletions).where(eq(accountDeletions.id, row.id));
  // 注销这件事本身的永久留痕：这条审计必须在 purgeUser 之后写，否则会被一起匿名化
  await writeAudit(c.env, {
    actor: admin,
    action: 'user',
    target: row.userId,
    detail: { event: 'user.purge', reason: '注销申请通过', deletionId: row.id, email: account.email, accountSlug: account.accountSlug, deleted },
    ip: clientIp(c),
  });
  return ok({ id: row.id, userId: row.userId, status: 'approved', deleted, message: '账号与其全部数据已删除' });
});

/** POST /api/admin/deletions/:id/reject —— 驳回：账号原样保留 */
deletionsAdmin.post('/:id/reject', async (c) => {
  const admin = requireAdmin(c);
  const parsed = z.object({ note: z.string().trim().max(500).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) fail(400, '参数有误');
  const db = createDb(c.env);
  const rows = await db.select().from(accountDeletions).where(eq(accountDeletions.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row) fail(404, '注销申请不存在');
  if (row.status !== 'pending') failWith(409, `该申请已是 ${row.status} 状态，不能重复处理`);
  const now = nowSec();
  await db
    .update(accountDeletions)
    .set({ status: 'rejected', reviewerId: admin.id, reviewNote: parsed.data.note || null, reviewedAt: now })
    .where(eq(accountDeletions.id, row.id));
  await writeAudit(c.env, {
    actor: admin,
    action: 'user',
    target: row.userId,
    detail: { event: 'deletion.reject', id: row.id, note: parsed.data.note || null },
    ip: clientIp(c),
  });
  return ok({ id: row.id, userId: row.userId, status: 'rejected', reviewNote: parsed.data.note || null, message: '已驳回，账号保持不变' });
});

/* ------------------------------------------------------------------ 我的投稿 */

const draftSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(200000),
  /** 选填：文章文件名（不带 .md）。填了发布时就用它，不填发布时自动用「发布那天 + 当天序号」。
      这个字段就是个人中心投稿表单里那个「文件名」框送的东西。 */
  slug: z.string().trim().max(120).nullable().optional(),
  category: z.string().trim().max(60).nullable().optional(),
  tags: z.array(z.string().trim().max(40)).max(12).optional(),
  summary: z.string().trim().max(500).nullable().optional(),
  cover: z.string().trim().max(500).nullable().optional(),
});

function draftShape(r: typeof postDrafts.$inferSelect) {
  let tags: string[] = [];
  try {
    tags = JSON.parse(r.tags || '[]');
  } catch {
    tags = [];
  }
  return {
    id: r.id,
    title: r.title,
    slug: r.slug,
    category: r.category,
    tags,
    summary: r.summary,
    cover: r.cover,
    content: r.content,
    status: r.status,
    reviewNote: r.reviewNote,
    publishedPath: r.publishedPath,
    publishedAt: r.publishedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

app.get('/drafts', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const db = createDb(c.env);
  const rows = await db
    .select()
    .from(postDrafts)
    .where(eq(postDrafts.userId, target.id))
    .orderBy(desc(postDrafts.createdAt))
    .limit(100);
  return ok({ items: rows.map(draftShape), total: rows.length });
});

app.post('/drafts', async (c) => {
  const { target } = await resolveAccountTarget(c);
  if (!target.canPublish && target.role !== 'admin') fail(403, '站主尚未开放你的投稿权限');
  const parsed = draftSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, parsed.error.issues[0]?.message ?? '投稿内容有误');
  const d = parsed.data;
  const db = createDb(c.env);
  const id = newId();
  /**
   * 文件名口径与后台「新建文章」同一条（`lib/postName.ts`）：**填了就按填的**
   * （中文与全角标点放行，只拒目录穿越与控制/保留字符），**没填先挂 `draft-xxxxxx` 占位**，
   * 审核通过那一刻换成「发布那天 + 当天序号」。
   * 以前这里是把标题剔成 ASCII 当基名：中文标题整个被剔光、标题尾巴的数字串活下来，
   * 提交时看不出任何问题，发布后地址却是一串 `1792596228706`。
   */
  const wanted = normalizeFileName(d.slug ?? '');
  if (wanted) {
    const bad = fileNameProblem(wanted);
    if (bad) fail(400, bad);
  }
  const slug = wanted || `${PLACEHOLDER_PREFIX}${id.slice(-6)}`;
  await db.insert(postDrafts).values({
    id,
    userId: target.id,
    title: d.title,
    slug,
    content: d.content,
    category: d.category ?? null,
    tags: JSON.stringify(d.tags ?? []),
    summary: d.summary ?? null,
    cover: d.cover ?? null,
    status: 'draft',
  });
  await writeAudit(c.env, { actor: target, action: 'draft', target: id, detail: { event: 'create', slug }, ip: clientIp(c) });
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, id)).limit(1);
  return ok({ ...draftShape(rows[0]), message: '草稿已保存，点「提交审核」后站主才会看到' });
});

app.get('/drafts/:id', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const rows = await createDb(c.env).select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row || row.userId !== target.id) fail(404, '投稿不存在');
  return ok(draftShape(row));
});

app.patch('/drafts/:id', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row || row.userId !== target.id) fail(404, '投稿不存在');
  if (row.status === 'pending') fail(409, '审核中，暂不能修改');
  if (row.status === 'approved') fail(409, '已发布的投稿不能在这里修改');
  const parsed = draftSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, parsed.error.issues[0]?.message ?? '投稿内容有误');
  const d = parsed.data;
  /* 文件名与新建同一条口径（lib/postName.ts）：填了按填的、清空退回自动名。
     这里只改还没发布的稿子，所以换 slug 不会牵动评论/统计/收藏的键（那些只在发布后才有）。 */
  const wantedEdit = d.slug === undefined ? null : normalizeFileName(d.slug ?? '');
  if (wantedEdit) {
    const bad = fileNameProblem(wantedEdit);
    if (bad) fail(400, bad);
  }
  const nextSlug = wantedEdit === null ? row.slug : wantedEdit || `${PLACEHOLDER_PREFIX}${row.id.slice(-6)}`;
  const backToPending = row.status === 'rejected' && (d.content || d.title);
  await db
    .update(postDrafts)
    .set({
      title: d.title ?? row.title,
      slug: nextSlug,
      content: d.content ?? row.content,
      category: d.category === undefined ? row.category : d.category || null,
      tags: d.tags === undefined ? row.tags : JSON.stringify(d.tags),
      summary: d.summary === undefined ? row.summary : d.summary || null,
      cover: d.cover === undefined ? row.cover : d.cover || null,
      status: backToPending ? 'pending' : row.status,
      reviewNote: backToPending ? null : row.reviewNote,
      updatedAt: nowSec(),
    })
    .where(eq(postDrafts.id, row.id));
  return ok({ id: row.id, status: backToPending ? 'pending' : row.status, message: backToPending ? '已修改并重新提交审核' : '已保存' });
});

app.post('/drafts/:id/submit', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row || row.userId !== target.id) fail(404, '投稿不存在');
  if (row.status === 'approved') fail(409, '该投稿已发布');
  if (row.status === 'pending') fail(409, '该投稿已在审核中');
  await db
    .update(postDrafts)
    .set({ status: 'pending', reviewNote: null, reviewerId: null, updatedAt: nowSec() })
    .where(eq(postDrafts.id, row.id));
  await writeAudit(c.env, { actor: target, action: 'draft', target: row.id, detail: { event: 'submit', slug: row.slug }, ip: clientIp(c) });
  return ok({ id: row.id, status: 'pending', message: '已提交，等待站主审核' });
});

app.post('/drafts/:id/withdraw-request', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row || row.userId !== target.id) fail(404, '投稿不存在');
  if (row.status === 'withdraw_requested') fail(409, '撤回申请已在审核中');
  if (row.status !== 'approved' && !row.publishedPath) fail(409, '未发布的投稿可直接删除，无需申请撤回');
  await db.update(postDrafts).set({ status: 'withdraw_requested', updatedAt: nowSec() }).where(eq(postDrafts.id, row.id));
  await writeAudit(c.env, { actor: target, action: 'draft', target: row.id, detail: { event: 'withdraw-request', path: row.publishedPath }, ip: clientIp(c) });
  return ok({ id: row.id, status: 'withdraw_requested', message: '撤回申请已提交，站主同意后会删除文件并告知结果' });
});

app.delete('/drafts/:id', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const db = createDb(c.env);
  const rows = await db.select().from(postDrafts).where(eq(postDrafts.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row || row.userId !== target.id) fail(404, '投稿不存在');
  if (row.publishedPath) fail(409, '已发布的投稿请先申请撤回');
  await db.delete(postDrafts).where(eq(postDrafts.id, row.id));
  await writeAudit(c.env, { actor: target, action: 'draft', target: row.id, detail: { event: 'delete', slug: row.slug }, ip: clientIp(c) });
  return ok({ id: row.id, deleted: true });
});

/* ------------------------------------------------------------------ 作者认证 */

const authorSchema = z.object({
  penName: z.string().trim().min(1).max(60),
  bio: z.string().trim().max(1000).optional().nullable(),
  avatar: z.string().trim().max(500).optional().nullable(),
  website: z.string().trim().max(300).optional().nullable(),
  donateImages: z.array(z.string().trim().max(500)).max(3).optional(),
  social: z
    .array(z.object({ platform: z.string().trim().max(30), handle: z.string().trim().max(120), proof: z.string().trim().max(300).optional() }))
    .max(12)
    .optional(),
  reason: z.string().trim().max(1000).optional().nullable(),
  handle: z.string().trim().max(40).optional().nullable(),
});

app.get('/author-request', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const db = createDb(c.env);
  const rows = await db.select().from(authorRequests).where(eq(authorRequests.userId, target.id)).orderBy(desc(authorRequests.createdAt)).limit(10);
  let social: unknown[] = [];
  let donate: string[] = [];
  if (rows[0]) {
    try {
      social = JSON.parse(rows[0].social || '[]');
    } catch {
      social = [];
    }
    try {
      const v: unknown = JSON.parse(rows[0].donateImages || '[]');
      donate = Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
    } catch {
      donate = [];
    }
  }
  // 入口是否开放由后台的三个状态共同决定，前端只读这里算好的结果，避免「明明开了却显示未开放」
  const me = withAdminAuthorBits(target);
  const enabled = await getConfigBool(c.env, 'authorVerifyEnabled', true);
  const allowed = me.canAuthor;
  const pending = rows[0]?.status === 'pending';
  /*
   * 站长点「退回改资料」后，最新那份是 'returned'：认证保留，但表单要重新开放 ——
   * 他要改的就是笔名 / 简介 / 头像 / 联系方式那几样，堵住入口只能靠站内私信沟通。
   */
  const returned = rows[0]?.status === 'returned';
  const blocked = !enabled
    ? '站点当前关闭了作者认证入口，站主在「设置 → 用户中心」打开后即可申请。'
    : !allowed
      ? '你还没有共创权限，请站主在后台「用户」页把你的用户组设为「共创」。'
      : returned
        ? ''
        : me.authorVerified
          ? target.role === 'admin'
            ? '管理员默认就是本站的认证作者，不需要申请；署名与作者资料在「我的信息 → 站长作者资料」里改。'
            : '你已通过作者认证，资料如需修改请直接联系站主。'
          : pending
            ? '已有一份认证申请正在审核中。'
            : '';
  const canApply = enabled && allowed && !pending && (!me.authorVerified || returned);
  return ok({
    verified: me.authorVerified,
    handle: me.handle,
    enabled,
    allowed,
    pending,
    canApply,
    blocked,
    // 表单要按最新那份预填，退回改资料时才有意义 —— 笔名 / 简介之外，头像、个人站、
    // 说明和赞赏图也要带回来，否则用户得把八条社交平台重打一遍。
    latest: rows[0]
      ? {
          id: rows[0].id,
          penName: rows[0].penName,
          bio: rows[0].bio,
          avatar: rows[0].avatar,
          website: rows[0].website,
          reason: rows[0].reason,
          donateImages: donate,
          status: rows[0].status,
          adminNote: rows[0].adminNote,
          createdAt: rows[0].createdAt,
          reviewedAt: rows[0].reviewedAt,
          social,
        }
      : null,
    history: rows.map((r) => ({ id: r.id, penName: r.penName, status: r.status, createdAt: r.createdAt, reviewedAt: r.reviewedAt })),
  });
});

app.post('/author-request', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const me = withAdminAuthorBits(target);
  if (!me.canAuthor) fail(403, '站主尚未开放你的作者认证入口');
  /* 站长「退回改资料」之后（最新那份是 returned）允许再交一次：认证位保留，改的是笔名与资料本身 */
  const latest = await createDb(c.env)
    .select({ status: authorRequests.status })
    .from(authorRequests)
    .where(eq(authorRequests.userId, target.id))
    .orderBy(sql`created_at desc`)
    .limit(1);
  const returned = latest[0]?.status === 'returned';
  if (me.authorVerified && !returned) {
    fail(409, target.role === 'admin' ? '管理员本来就是认证作者，作者资料请在「我的信息 → 站长作者资料」里改' : '你已通过作者认证，如需修改资料请直接联系站主');
  }
  const parsed = authorSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, parsed.error.issues[0]?.message ?? '认证资料有误（赞赏图最多三张）');
  const db = createDb(c.env);
  const pending = await db
    .select({ id: authorRequests.id })
    .from(authorRequests)
    .where(and(eq(authorRequests.userId, target.id), eq(authorRequests.status, 'pending')))
    .limit(1);
  if (pending[0]) fail(409, '已有一份认证申请正在审核中');
  const d = parsed.data;
  const id = newId();
  await db.insert(authorRequests).values({
    id,
    userId: target.id,
    penName: d.penName,
    bio: d.bio ?? null,
    avatar: d.avatar ?? null,
    website: d.website ?? null,
    donateImages: JSON.stringify(d.donateImages ?? []),
    social: JSON.stringify(d.social ?? []),
    reason: d.reason ?? null,
    status: 'pending',
  });
  await writeAudit(c.env, { actor: target, action: 'authorRequest', target: id, detail: { event: 'submit', penName: d.penName }, ip: clientIp(c) });
  return ok({ id, status: 'pending', message: '认证申请已提交，站主审核通过后会写入作者资料并通知你' });
});

/* ------------------------------------------------------------------ 友链申请改与撤 */

app.patch('/friend-application/:id', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const db = createDb(c.env);
  const rows = await db.select().from(friendApplications).where(eq(friendApplications.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row || row.userId !== target.id) fail(404, '申请不存在');
  if (row.status === 'approved') fail(409, '已通过的申请请在正文里直接留言给站主');
  const parsed = friendSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, parsed.error.issues[0]?.message ?? '参数有误');
  const d = parsed.data;
  const url = normalizeFriendUrl(String(d.url || d.friendLink || '').trim());
  if (!url) fail(400, '请填写站点地址');
  await db
    .update(friendApplications)
    .set({
      name: d.name,
      url,
      description: d.description ?? null,
      avatar: d.avatar ?? null,
      rssUrl: d.rssUrl ?? null,
      email: d.email ?? null,
      reason: d.reason ?? null,
      status: 'pending',
      reviewNote: null,
      reviewedAt: null,
    })
    .where(eq(friendApplications.id, row.id));
  await writeAudit(c.env, { actor: target, action: 'friendApp', target: url, detail: { event: 'account-updated', id: row.id }, ip: clientIp(c) });
  return ok({ id: row.id, status: 'pending', message: '已更新并重新提交审核' });
});

app.delete('/friend-application/:id', async (c) => {
  const { target } = await resolveAccountTarget(c);
  const db = createDb(c.env);
  const rows = await db.select().from(friendApplications).where(eq(friendApplications.id, c.req.param('id'))).limit(1);
  const row = rows[0];
  if (!row || row.userId !== target.id) fail(404, '申请不存在');
  if (row.status === 'approved') fail(409, '已通过的友链请通知站主下线');
  await db.delete(friendApplications).where(eq(friendApplications.id, row.id));
  await writeAudit(c.env, { actor: target, action: 'friendApp', target: row.url, detail: { event: 'account-withdrawn', id: row.id }, ip: clientIp(c) });
  return ok({ id: row.id, deleted: true, message: '申请已撤回' });
});

export { deletionsAdmin };
export default app;
