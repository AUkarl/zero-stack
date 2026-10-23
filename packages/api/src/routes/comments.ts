import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { comments, commenters, users } from '../db/schema';
import { createDb } from '../db/client';
import { getConfig, getConfigBool, getConfigInt } from '../services/config';
import { newId, randomToken } from '../lib/crypto';
import { avatarChainForEmail, emailMd5, isEmail, nicknameFromEmail } from '../lib/avatar';
import { fail, ok } from '../lib/errors';
import { canonSlug } from '../lib/slug';
import { clientIp, userAgent } from '../lib/http';
import { hashIp, visitorMeta } from '../lib/ua';
import { rateLimit } from '../lib/rate-limit';
import { requireAdmin, tokenFromRequest } from '../middleware/auth';
import { bannedByToken } from '../services/auth';
import { inspectComment, type Verdict } from '../services/moderation';
import { deleteCommentSubtree } from '../services/comment-tree';
import { notifyNewComment } from '../services/comment-notify';
import { commentLikeStatsForSlug, toggleCommentLike } from './likes';
/**
 * 首字母色块的算法**只在 comment 包里存一份**（前端也要用同一个口径才能保住既有颜色），
 * 所以这里是跨包引用源文件 —— 与 services/email-content.ts 引 markdown 渲染器是同一条路子。
 * 该模块零依赖、不碰 DOM，Worker 侧可以直接用。
 */
import { avatarStyleFor } from '../../../comment/src/lib/avatar-style';
import type { AuthUser } from '../services/auth';
import type { AppEnv } from '../lib/app';

const MAX_CONTENT = 5000;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;
/** 单篇文章一次最多读多少条进内存建树；配合 offset/limit 分页，正常站点够用 */
const SCAN_LIMIT = 2000;

const createSchema = z.object({
  postSlug: z.string().min(1).max(500),
  content: z.string().min(1).max(MAX_CONTENT),
  parentId: z.string().max(64).optional(),
  /** 昵称可留空：留空按邮箱派生 z***@qq.com */
  name: z.string().max(64).optional(),
  /** 匿名评论必填（登录用户忽略，一律用账号邮箱） */
  email: z.string().max(200).optional(),
  /** 游客的网址选填，normalizeLink 之后落到 author_link，前台点头像/昵称跳它 */
  link: z.string().max(300).optional(),
});

const editSchema = z.object({
  content: z.string().min(1).max(MAX_CONTENT),
  /** 匿名改自己评论时带回的凭证 */
  ownerKey: z.string().max(64).optional(),
});

type CommentRow = typeof comments.$inferSelect;
type SortKey = 'latest' | 'oldest' | 'hot';

/* ------------------------------------------------------------------
 * 头像：本人填的 URL 最优先；没填就按邮箱依次试 Gravatar → Cravatar →（QQ 号）q1.qlogo.cn，
 * 后台「头像与媒体」的 avatarTemplate 填了就顶到最前面（等于整条链换图床）。
 * 一级都没命中时前端退到首字母色块（CommentNode 的 onerror 一路往下换，换完才落首字母）。
 * ----------------------------------------------------------------*/

interface AvatarSet {
  avatar: string;
  /** 第二级：老版组件只认 avatar + gravatar 两档，留着它保证旧包还能逐级退化 */
  gravatar: string;
  /** 第三级起继续往下试的地址，前端按顺序 onerror 降级 */
  fallbacks: string[];
}

function avatars(email: string | null | undefined, template: string, image?: string | null): AvatarSet {
  const override = (image ?? '').trim();
  if (override) return { avatar: override, gravatar: '', fallbacks: [] };

  const mail = (email ?? '').trim().toLowerCase();
  if (!mail.includes('@')) return { avatar: '', gravatar: '', fallbacks: [] };
  const t = (template ?? '').trim();
  const head = t ? t.replaceAll('{hash}', emailMd5(mail)).replaceAll('{email}', encodeURIComponent(mail)) : '';
  // 模板本身常就写成 cravatar 那条地址，去重免得同一个图白试两回
  const list = [head, ...avatarChainForEmail(mail)].filter(Boolean).filter((u, i, arr) => arr.indexOf(u) === i);
  const [first = '', second = '', ...rest] = list;
  return { avatar: first, gravatar: second, fallbacks: rest };
}

/* ------------------------------------------------------------------
 * 账号身份：昵称/头像/用户组都取账号，不用评论里那份历史值。
 * 认证徽章（authorVerified）前台已经不再渲染，这里就不再为它查库。
 * ----------------------------------------------------------------*/

interface Profile {
  name: string | null;
  image: string | null;
  website: string | null;
  userGroup: string | null;
  role: string | null;
  /** 只用来推头像（本人没填头像时按邮箱走 gravatar→cravatar→QQ），不会随评论发出去 */
  email: string | null;
}

const PROFILE_COLS = {
  id: users.id,
  name: users.name,
  image: users.image,
  website: users.website,
  userGroup: users.userGroup,
  role: users.role,
  email: users.email,
};

async function profilesOf(env: Env, ids: string[]): Promise<Map<string, Profile>> {
  const map = new Map<string, Profile>();
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return map;
  const rows = await createDb(env)
    .select(PROFILE_COLS)
    .from(users)
    .where(inArray(users.id, list));
  for (const r of rows)
    map.set(r.id, { name: r.name, image: r.image, website: r.website, userGroup: r.userGroup, role: r.role, email: r.email });
  return map;
}

async function profileOf(env: Env, id: string): Promise<Profile | null> {
  const rows = await createDb(env).select(PROFILE_COLS).from(users).where(eq(users.id, id)).limit(1);
  const r = rows[0];
  return r ? { name: r.name, image: r.image, website: r.website, userGroup: r.userGroup, role: r.role, email: r.email } : null;
}

/** 登录用户以账号昵称为准（改名后旧评论跟着变），游客用评论里存的那份 */
function authorDisplayName(row: CommentRow, profiles: Map<string, Profile>): string {
  const profile = row.authorId ? profiles.get(row.authorId) : undefined;
  const isUser = row.authorType === 'user';
  return (isUser ? profile?.name : row.authorName) || row.authorName || nicknameFromEmail(row.authorEmail ?? '');
}

/** 前台只用文字标签表达身份：管理员 = 站长，其余按 userGroup；游客 null */
function authorGroup(isUser: boolean, profile?: Profile): string | null {
  if (!isUser) return null;
  if (profile?.role === 'admin') return 'admin';
  return profile?.userGroup ?? null;
}

/* ------------------------------------------------------------------
 * ownerKey：匿名评论的自删/自改凭证，也是「看得到自己待审评论」的通行证。
 * 前端在 localStorage 存 { [slug]: { [commentId]: ownerKey } }，取列表时带上。
 *
 * R43 起前端优先走请求头（X-Comment-Owners / X-Comment-Owner），凭证不再留在 URL 里；
 * index.ts 的 CORS allowHeaders 已加上这两个头 —— **部署顺序要先 Worker 后主题产物**，
 * 反过来的话新产物对老 Worker 发自定义头会被预检拦住。
 * 查询串与 body 两档继续收：老包、同域调用，以及「整篇凭证超过一个头装得下的长度」时的退回。
 * ----------------------------------------------------------------*/

const OWNER_HEADER = 'x-comment-owners';
const SINGLE_OWNER_HEADER = 'x-comment-owner';

function parseOwners(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const value = raw.trim();
  if (!value) return map;
  const pairs: [string, string][] = [];
  if (value.startsWith('{')) {
    try {
      const obj = JSON.parse(value) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') pairs.push([k, v]);
    } catch {
      return map;
    }
  } else {
    for (const kv of value.split(',')) {
      const i = kv.indexOf(':');
      if (i > 0) pairs.push([kv.slice(0, i).trim(), kv.slice(i + 1).trim()]);
    }
  }
  // 恶意塞超大串也别让一次请求吃掉太多内存
  for (const [id, key] of pairs.slice(0, 500)) if (id && key) map.set(id, key);
  return map;
}

function ownersFromRequest(c: Context): Map<string, string> {
  return parseOwners(c.req.query('owners') ?? c.req.header(OWNER_HEADER) ?? '');
}

function ownerKeyFromRequest(c: Context, body?: { ownerKey?: string } | null): string {
  return (c.req.query('owner') ?? c.req.header(SINGLE_OWNER_HEADER) ?? body?.ownerKey ?? '').trim();
}

function proveKey(row: CommentRow, owners: Map<string, string>): string | null {
  const key = owners.get(row.id);
  return key && row.ownerKey && key === row.ownerKey ? key : null;
}

/* ------------------------------------------------------------------
 * 输出塑形：绝不回传 authorEmail 明文与 ipHash
 * ----------------------------------------------------------------*/

interface ShapeOpts {
  /** 这条的直接子评论数（嵌套字段用）；顶层会被 threadTotal 级的平铺数覆盖 */
  replyCount?: number;
  likeCount?: number;
  liked?: boolean;
  /** 只有请求方出示了这个 id 的 ownerKey 才回传 */
  ownerKey?: string | null;
  /** 被回复者的昵称，平铺显示「回复 @某人」用 */
  replyToName?: string;
}

function makeShaper(avatarTemplate: string, profiles: Map<string, Profile>) {
  return (row: CommentRow, opts: ShapeOpts = {}) => {
    const profile = row.authorId ? profiles.get(row.authorId) : undefined;
    const isUser = row.authorType === 'user';
    return {
      id: row.id,
      postSlug: row.postSlug,
      parentId: row.parentId,
      rootId: row.rootId,
      depth: row.depth,
      content: row.content,
      // 登录用户一律以账号身份展示（改名后旧评论也跟着变）
      authorName: authorDisplayName(row, profiles),
      authorId: row.authorId,
      // 登录用户没单独填链接时，点昵称/头像跳账号里配的個人站点
      authorLink: row.authorLink ?? (profile?.website || null),
      /* 登录用户：账号里填了头像就用那张；没填就用他的邮箱走 Gravatar→Cravatar→QQ。
         以前这里把邮箱硬写成 null，于是「没单独设头像的注册用户」一律掉到首字母色块，
         邮箱明明注册了 Gravatar 也拿不到图。评论行自己存过一份 authorEmail，先拿它，
         再兜账号那一份（改过邮箱的旧评论存的还是老地址，所以账号那份只作补充）。 */
      ...avatars(isUser ? row.authorEmail || profile?.email : row.authorEmail, avatarTemplate, isUser ? profile?.image : null),
      /* 一张头像都取不到时那个「首字母色块」的色相与字母。
         以前这里公开的是 emailDomain（每个人的邮箱域名），前端自己拿 `昵称|域名` 去散列颜色 ——
         域名本不该出现在公开响应里，可要直接删掉字段，所有人的底色会集体换一遍（颜色由那串种子决定）。
         所以改成服务端按**同一串种子、同一段算法**算好色相再发出去（算法只有一份，在 comment 包里），
         既不再泄露域名，颜色也一格都没变。 */
      ...avatarStyleFor(authorDisplayName(row, profiles), isUser ? row.authorEmail || profile?.email : row.authorEmail),
      isAuthor: isUser,
      /** 'admin'（站长）| 'coauthor'（共创）| 'friend'（朋友）| null（游客） */
      group: authorGroup(isUser, profile),
      /** 「回复 @某人」的那个小字；顶层评论是空串 */
      replyToName: opts.replyToName ?? '',
      status: row.status,
      createdAt: row.createdAt,
      editedAt: row.editedAt,
      /** 这条的子回复数 */
      replyCount: opts.replyCount ?? 0,
      city: row.city,
      country: row.country,
      browser: row.browser,
      os: row.os,
      device: row.device,
      pinned: Boolean(row.pinned),
      featured: Boolean(row.featured),
      likeCount: opts.likeCount ?? 0,
      liked: Boolean(opts.liked),
      ownerKey: opts.ownerKey ?? null,
      // 下面三个由调用方按需覆盖：replies 是平铺后的同 thread 回复数组
      replies: [] as unknown[],
      children: [] as unknown[],
      collapsed: false,
    };
  };
}


/* ------------------------------------------------------------------
 * 可见性：管理员看全部；本人看自己的（含被判垃圾的那几条，否则改完像凭空消失）；匿名靠 ownerKey
 * ----------------------------------------------------------------*/

/** 这条就是「我」发的：登录账号对上 authorId，或访客带对了 ownerKey */
function mine(row: CommentRow, user: AuthUser | null, owners: Map<string, string>): boolean {
  if (user?.id && row.authorId === user.id) return true;
  return Boolean(proveKey(row, owners));
}

function visibleTo(row: CommentRow, user: AuthUser | null, isAdmin: boolean, owners: Map<string, string>): boolean {
  if (isAdmin) return true;
  if (row.status === 'approved') return true;
  return row.status === 'pending' || row.status === 'spam' ? mine(row, user, owners) : false;
}

/** 列表窗口之外也要发给本人的那几条：待审与被判垃圾的都算，只发自己的那份 */
function isMinePending(row: CommentRow, user: AuthUser | null, owners: Map<string, string>): boolean {
  if (row.status !== 'pending' && row.status !== 'spam') return false;
  return mine(row, user, owners);
}

function parseSort(value: string | undefined): SortKey {
  return value === 'latest' || value === 'hot' ? value : 'oldest';
}

function parsePaging(c: Context): { offset: number; limit: number } {
  const rawLimit = Number.parseInt(c.req.query('limit') ?? '', 10);
  const rawOffset = Number.parseInt(c.req.query('offset') ?? '', 10);
  const limit = Number.isNaN(rawLimit) ? DEFAULT_PAGE : Math.min(Math.max(rawLimit, 1), MAX_PAGE);
  return { offset: Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset, limit };
}

/** Hono 的 c.req.path 在多数运行时已解码，再解一次要防坏转义把请求打挂 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const app = new Hono<AppEnv>();

/* 以 /-/ 开头的聚合路由必须先注册，否则会被 /:slug 抢匹配 */

/** GET /api/comments/count?slugs=/a/,/b/ —— 列表页批量取评论数 */
app.get('/count', async (c) => {
  const env = c.env;
  const db = createDb(env);
  const raw = (c.req.query('slugs') ?? '').split(',').filter(Boolean);
  if (raw.length === 0) return ok({});
  const slugs = [...new Set(raw.map(canonSlug))];
  const rows = await db
    .select({ postSlug: comments.postSlug, count: sql<number>`count(*)` })
    .from(comments)
    .where(and(inArray(comments.postSlug, slugs), eq(comments.status, 'approved')))
    .groupBy(comments.postSlug);
  const out: Record<string, number> = {};
  for (const s of raw) out[s] = 0;
  for (const r of rows) out[r.postSlug] = Number(r.count);
  for (const s of raw) out[s] = out[canonSlug(s)] ?? 0;
  return ok(out);
});

/**
 * GET /api/comments/pending-count —— 后台侧栏的待审角标。
 * 全站待审数量是站长的管理信息，普通读者不需要知道（后台只在 isAdmin 时才请求这一条）。
 */
app.get('/pending-count', async (c) => {
  requireAdmin(c);
  const rows = await createDb(c.env)
    .select({ count: sql<number>`count(*)` })
    .from(comments)
    .where(eq(comments.status, 'pending'));
  return ok({ count: Number(rows[0]?.count ?? 0) });
});

/** GET /api/comments/recent?limit=10 —— 侧栏最近评论 */

/**
 * GET /api/comments/{slug}
 *  ?depth=1          只控制遗留字段 children 的嵌套层数；平铺的 replies 不受它限制
 *  ?sort=latest|oldest|hot   hot 先按点赞数再按时间；置顶永远在最前
 *  ?offset=&limit=   按「顶层评论」分页，默认 20 条顶层 + 其全部回复
 *  ?owners=id:key,…  匿名访客的待审凭证（也可用 X-Comment-Owners 头）
 * 已登录用户额外返回本人待审；窗口外的待审条目一律放进 mine 数组，前端不会「发完就消失」。
 *
 * 顶层评论（comments[] 的每一项）新增/变更：
 *   · replies    —— 同一 root 的全部可见后代，按 createdAt 正序平铺（不再 6 层缩进嵌套）
 *   · replyCount —— replies.length（原来的「直接子评论数」语义已改成整条线程的回复数）
 *   · children   —— 旧字段保留，仍按 ?depth 嵌套，给还没切到平铺的调用方用
 * 每条回复额外带 replyToName（被回复者昵称，父评论查不到时是空串）。
 */
app.get('*', async (c) => {
  const env = c.env;
  const db = createDb(env);
  const raw = safeDecode(c.req.path.slice('/api/comments/'.length));
  if (!raw) fail(404, '缺少文章 slug');
  const slug = canonSlug(raw);

  const requested = Number.parseInt(c.req.query('depth') ?? '2', 10);
  const maxDepth = await getConfigInt(env, 'commentMaxDepth', 6);
  const visibleDepth = Math.min(Number.isNaN(requested) ? 2 : Math.max(1, requested), maxDepth);
  const sort = parseSort(c.req.query('sort'));
  const { offset, limit } = parsePaging(c);

  const user = c.get('user') ?? null;
  const isAdmin = user?.role === 'admin';
  const owners = ownersFromRequest(c);

  /* 评论行与这篇的赞数互不依赖（赞数只按 post_slug 圈范围），并发发出去：
     D1 一次网络往返就是 100~200ms 量级，串起来是评论区「转圈」的大头。 */
  const [rows, likeStats] = await Promise.all([
    db
      .select()
      .from(comments)
      .where(eq(comments.postSlug, slug))
      .orderBy(asc(comments.createdAt))
      .limit(SCAN_LIMIT),
    commentLikeStatsForSlug(env, c, slug, user),
  ]);
  const { counts, liked } = likeStats;

  const visible = rows.filter((r) => visibleTo(r, user, isAdmin, owners));

  const childCount = new Map<string, number>();
  const byParent = new Map<string, CommentRow[]>();
  for (const r of visible) {
    if (!r.parentId) continue;
    childCount.set(r.parentId, (childCount.get(r.parentId) ?? 0) + 1);
    const list = byParent.get(r.parentId) ?? [];
    list.push(r);
    byParent.set(r.parentId, list);
  }

  /* 二级平铺的准备：先按 id 建索引，被引用却不在扫描窗口里的父评论一次批量补齐，
   * 绝不在下面按条循环里查库（那才是 N+1）。 */
  const rowById = new Map<string, CommentRow>();
  for (const r of rows) rowById.set(r.id, r);
  const missingParents = new Set<string>();
  for (const r of visible) if (r.parentId && !rowById.has(r.parentId)) missingParents.add(r.parentId);
  if (missingParents.size) {
    const extra = await db.select().from(comments).where(inArray(comments.id, [...missingParents]));
    for (const r of extra) rowById.set(r.id, r);
  }

  /** 一条评论所属的顶层 id：优先 root_id，退回 parent 链上溯，链断了就用已知的最上层 */
  const rootIdOf = (row: CommentRow): string => {
    if (!row.parentId) return row.id;
    let cur = row;
    const seen = new Set<string>();
    while (cur.parentId && !seen.has(cur.id)) {
      seen.add(cur.id);
      const hop = cur.rootId ? rowById.get(cur.rootId) : rowById.get(cur.parentId);
      if (!hop) break;
      cur = hop;
    }
    return cur.parentId ? cur.rootId ?? cur.parentId : cur.id;
  };

  const byRoot = new Map<string, CommentRow[]>();
  for (const r of visible) {
    if (!r.parentId) continue;
    const rid = rootIdOf(r);
    const list = byRoot.get(rid) ?? [];
    list.push(r);
    byRoot.set(rid, list);
  }
  for (const list of byRoot.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || String(a.id).localeCompare(String(b.id)));
  }

  const avatarTemplate = (await getConfig(env, 'avatarTemplate'))?.trim() ?? '';
  const profiles = await profilesOf(env, [
    ...visible.filter((r) => r.authorType === 'user').map((r) => r.authorId ?? ''),
    ...[...missingParents].map((id) => rowById.get(id)).filter((r) => r?.authorType === 'user').map((r) => r!.authorId ?? ''),
  ]);
  const shape = makeShaper(avatarTemplate, profiles);
  /** 「回复 @某人」：被回复者也是登录用户时取账号昵称，父评论查不到就是空串（前端只少一段小字） */
  const nameOf = (id: string | null | undefined): string => {
    const parent = id ? rowById.get(id) : undefined;
    return parent ? authorDisplayName(parent, profiles) : '';
  };

  const likeOf = (id: string) => counts.get(id) ?? 0;
  const roots = visible.filter((r) => !r.parentId);
  roots.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (sort === 'hot' && likeOf(a.id) !== likeOf(b.id)) return likeOf(b.id) - likeOf(a.id);
    const byTime = sort === 'latest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt;
    // 同一秒内的并发评论用 id 兜底，翻页才不会漏条或重条
    return byTime || String(a.id).localeCompare(String(b.id));
  });

  const page = roots.slice(offset, offset + limit);

  const optsOf = (row: CommentRow, replyCount: number, parentId?: string | null): ShapeOpts => ({
    replyCount,
    likeCount: likeOf(row.id),
    liked: liked.has(row.id),
    ownerKey: proveKey(row, owners),
    replyToName: nameOf(parentId === undefined ? row.parentId : parentId),
  });

  const build = (row: CommentRow, level: number): Record<string, unknown> => {
    const kids = byParent.get(row.id) ?? [];
    const open = level < visibleDepth;
    return {
      ...shape(row, optsOf(row, childCount.get(row.id) ?? 0)),
      collapsed: !open && kids.length > 0,
      children: open ? kids.map((k) => build(k, level + 1)) : [],
    };
  };

  /** 同一顶层的回复平铺成一级列表：每项都带自己的 replyToName，不再嵌套 */
  const flatReplies = (root: CommentRow) =>
    (byRoot.get(root.id) ?? []).map((r) => ({
      ...shape(r, optsOf(r, 0)),
      collapsed: false,
      children: [],
      replies: [],
    }));

  const tree = page.map((r) => {
    const node = build(r, 1);
    const list = flatReplies(r);
    node.replies = list;
    node.replyCount = list.length;
    return node;
  });

  // 已经在 threads 里露过面的（含平铺进 replies 的）就别再发一份 mine
  const inTree = new Set<string>();
  const collect = (node: Record<string, unknown>) => {
    inTree.add(String(node.id));
    for (const kid of (node.children as Record<string, unknown>[] | undefined) ?? []) collect(kid);
    for (const rep of (node.replies as Record<string, unknown>[] | undefined) ?? []) inTree.add(String(rep.id));
  };
  for (const node of tree) collect(node);

  // 分页窗口外的「我自己的待审」另发一份，前端拼在列表里，不至于提交完看不见
  const mine = visible
    .filter((r) => isMinePending(r, user, owners) && !inTree.has(r.id))
    .map((r) => shape(r, optsOf(r, childCount.get(r.id) ?? 0)));

  return ok({
    comments: tree,
    mine,
    total: visible.length,
    threadTotal: roots.length,
    offset,
    limit,
    sort,
    hasMore: offset + page.length < roots.length,
    maxDepth,
    depth: visibleDepth,
    commentEnabled: await getConfigBool(env, 'commentEnabled', true),
    requireReview: await getConfigBool(env, 'commentRequireReview', false),
    // 前台账号系统关掉后没有任何登录途径，此时「需登录才能评论」会把评论区彻底锁死，
    // 所以总开关为 off 时一律按匿名可发返回，与下面 POST 的判定保持一致
    allowAnonymous:
      (await getConfigBool(env, 'commentAllowAnonymous', true)) ||
      !(await getConfigBool(env, 'accountSystemEnabled', true)),
  });
});

/** 网址可选，但入库前先补齐协议并校验，前端粘个「abc」这种就别写进去了 */
function normalizeLink(raw?: string): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    if (!url.hostname.includes('.')) return null;
    return url.toString().slice(0, 300);
  } catch {
    return null;
  }
}

/** POST /api/comments —— 登录用户用账号身份；匿名必填邮箱，昵称可留空 */
app.post('/', async (c) => {
  const env = c.env;
  if (!(await getConfigBool(env, 'commentEnabled', true))) fail(403, '评论功能已关闭');

  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, `参数有误，正文长度需在 ${MAX_CONTENT} 字以内`);
  const body = parsed.data;

  // 上限后台可配；设成 0 表示不限流（只靠蜜罐、关键词打分与先审后发）
  await rateLimit(c, 'comment', await getConfigInt(env, 'commentRateLimit', 10), 3600, body.postSlug);

  const db = createDb(env);
  const user = c.get('user') ?? null;
  if (!user && (await bannedByToken(env, tokenFromRequest(c)))) fail(403, '账号已被封禁，无法评论');
  // 前台账号系统关掉后整站无处登录，这时再要求「登录后评论」等于把评论区彻底锁死，按匿名可发放行
  const anonOk =
    (await getConfigBool(env, 'commentAllowAnonymous', true)) ||
    !(await getConfigBool(env, 'accountSystemEnabled', true));
  if (!user && !anonOk) fail(403, '本站评论需登录后进行');

  const content = body.content.trim();
  if (!content) fail(400, '内容不能为空');
  const slug = canonSlug(body.postSlug);

  let depth = 1;
  let rootId: string | null = null;
  let parent: { authorName: string; authorEmail: string | null; authorId: string | null } | null = null;
  if (body.parentId) {
    const parents = await db
      .select({
        id: comments.id,
        depth: comments.depth,
        rootId: comments.rootId,
        postSlug: comments.postSlug,
        status: comments.status,
        authorName: comments.authorName,
        authorEmail: comments.authorEmail,
        authorId: comments.authorId,
      })
      .from(comments)
      .where(eq(comments.id, body.parentId))
      .limit(1);
    const hit = parents[0];
    if (!hit) fail(404, '要回复的评论不存在');
    if (canonSlug(hit.postSlug) !== slug) fail(400, '不能跨文章回复');
    if (hit.status !== 'approved') fail(403, '该评论尚未通过审核');
    depth = hit.depth + 1;
    /* commentMaxDepth 必须在这里真的拦住：以前它只管「列表展示几层」，
       于是连点到第十层还能点，缩进超出面板宽度、整页破版，配置看起来像个摆设。 */
    const maxDepth = await getConfigInt(env, 'commentMaxDepth', 6);
    if (maxDepth > 0 && depth > maxDepth) fail(400, `回复层级已达上限（最多 ${maxDepth} 层），请回到顶层继续讨论`);
    rootId = hit.rootId ?? hit.id;
    parent = { authorName: hit.authorName, authorEmail: hit.authorEmail, authorId: hit.authorId };
  }

  const link = normalizeLink(body.link);
  if ((body.link ?? '').trim() && !link) fail(400, '网址格式有误，请填写完整链接（如 https://example.com）');

  const profile = user ? await profileOf(env, user.id) : null;
  // 登录用户一律用账号邮箱；匿名邮箱必填，用于头像与回复通知
  const email = user ? user.email.trim().toLowerCase() : (body.email ?? '').trim().toLowerCase();
  if (!user && !isEmail(email)) fail(400, '请填写正确的邮箱地址（不会公开显示，用于头像与回复提醒）');
  const name = ((user ? profile?.name ?? user.name : body.name) ?? '').trim() || nicknameFromEmail(email);

  const now = Math.floor(Date.now() / 1000);
  const id = newId();

  // 访客维度：明文 IP 一律不入库，只存加盐哈希；审核查「本来源近期被拒次数」用的也是它
  const ip = clientIp(c);
  const ua = userAgent(c);
  const meta = await visitorMeta(c, env, ip, ua);

  // 站长/管理员本人的评论不经过审核：这一层只管外来内容（文章与投稿都不在这里）
  const trusted = user?.role === 'admin';

  let status: 'approved' | 'pending' | 'spam' = 'approved';
  let spamScore: number | null = null;
  let spamReason: string | null = null;
  if (!trusted && (await getConfigBool(env, 'spamEnabled', true))) {
    let verdict: Verdict;
    try {
      verdict = await inspectComment(env, {
        content,
        authorName: name,
        authorEmail: email,
        authorLink: link,
        ipHash: meta.ipHash,
        authenticated: Boolean(user),
        createdAt: user?.createdAt,
      });
    } catch (err) {
      // 审核自己出错时不再「按通过处理」：静默放行等于整个审核形同虚设，宁可压到待审核由人看一眼
      console.warn('[zero-api] 评论审核异常，这条转人工待审', err);
      verdict = { spam: true, score: 0, reason: '审核流程异常，已转人工', hold: true };
    }
    spamScore = verdict.score;
    spamReason = verdict.reason || null;
    if (verdict.spam) status = verdict.hold ? 'pending' : 'spam';
  }
  if (!trusted && status === 'approved' && (await getConfigBool(env, 'commentRequireReview', false)) && !user) {
    status = 'pending';
  }

  // ownerKey 每次新生成，只有本人浏览器持有
  const ownerKey = user ? null : randomToken(16);

  const row: CommentRow = {
    id,
    postSlug: slug,
    parentId: body.parentId ?? null,
    depth,
    rootId,
    authorType: user ? 'user' : 'commenter',
    authorId: user?.id ?? null,
    authorName: name,
    authorEmail: email || null,
    authorLink: link,
    content,
    status,
    spamScore,
    spamReason,
    ipHash: meta.ipHash,
    country: meta.country,
    city: meta.city,
    browser: meta.browser,
    os: meta.os,
    device: meta.device,
    pinned: false,
    featured: false,
    ownerKey,
    userAgent: ua,
    isLegacy: false,
    legacyId: null,
    createdAt: now,
    updatedAt: now,
    editedAt: null,
  };

  await db.insert(comments).values(row);

  // 游客资料留档，前端下次可回填昵称邮箱
  if (!user && (name || email)) {
    await db.insert(commenters).values({
      id: newId(),
      name,
      email: email || null,
      emailMd5: email ? emailMd5(email) : null,
      link,
      createdAt: now,
    });
  }

  /*
   * 用户端只说「内容不合适」，不说命中了哪条规则、也不暴露「垃圾/审核拦截」这类判定用语：
   * 规则文本是给站长看的（在「评论审核」页），发给提交者只会教人怎么绕过它。
   */
  const message =
    status === 'spam' ? '内容不符合本站社区规范，未通过审核' : status === 'pending' ? '评论已提交，等待审核' : '评论成功';

  // 邮件提醒是附带动作：站内任何错误都不能让已经落库的评论失败
  const notifying = notifyNewComment({
    env,
    slug,
    comment: {
      id,
      content,
      authorName: name,
      authorEmail: email || null,
      authorId: user?.id ?? null,
      status,
    },
    parent,
  });
  void notifying.catch((err) => console.warn('[zero-api] 评论提醒任务异常', err));
  const ctx = c.executionCtx as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
  ctx?.waitUntil?.(notifying);

  const shape = makeShaper(
    (await getConfig(env, 'avatarTemplate'))?.trim() ?? '',
    user?.id && profile ? new Map([[user.id, profile]]) : new Map(),
  );

  /* 回复成功也要带上「回复 @某人」的昵称：被回复者是注册用户时取账号当前昵称，
   * 只在有 parent 的情况下按 id 取一次资料，不构成逐条查询。 */
  const parentProfile = parent?.authorId ? await profileOf(env, parent.authorId) : null;
  const replyToName = parent ? (parent.authorId ? parentProfile?.name || parent.authorName : parent.authorName) || '' : '';

  return ok({
    id,
    depth,
    status,
    message,
    ownerKey,
    comment: shape(row, {
      replyCount: 0,
      likeCount: 0,
      liked: false,
      ownerKey,
      replyToName,
    }),
  });
});

/** POST /api/comments/:id/like —— 登录按 user_id、匿名按访客指纹去重，点过即取消 */
app.post('/:id/like', async (c) => {
  const env = c.env;
  const id = c.req.param('id');
  const user = c.get('user') ?? null;

  const rows = await createDb(env)
    .select({ id: comments.id, status: comments.status })
    .from(comments)
    .where(eq(comments.id, id))
    .limit(1);
  const hit = rows[0];
  if (!hit) fail(404, '评论不存在');
  if (hit.status !== 'approved' && user?.role !== 'admin') fail(404, '评论尚未通过审核');

  const res = await toggleCommentLike(env, c, id, user);
  return ok({ id: res.commentId, liked: res.liked, likeCount: res.likeCount });
});

/**
 * DELETE /api/comments/:id
 * 管理员删任意；登录用户删自己的；匿名带上评论返回的 ownerKey（?owner= 或 X-Comment-Owner）自删。
 */
app.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user') ?? null;
  const ownerKey = ownerKeyFromRequest(c);
  // 登录用户与「匿名但持有该评论 ownerKey」两种情况都允许往下走，具体归属在查出行之后判定
  if (!user && !ownerKey) fail(401, '请先登录，或携带删除凭证');
  const db = createDb(c.env);
  const rows = await db
    .select({ id: comments.id, authorId: comments.authorId, ownerKey: comments.ownerKey })
    .from(comments)
    .where(eq(comments.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) fail(404, '评论不存在');

  const isSelf = Boolean(user?.id && row.authorId === user.id);
  const isOwner = Boolean(ownerKey && row.ownerKey === ownerKey);
  if (user?.role !== 'admin' && !isSelf && !isOwner) fail(403, '只能删除自己的评论');

  const deletedCount = await deleteCommentSubtree(c.env, id);
  return ok({ id, deletedCount });
});

/**
 * PATCH /api/comments/:id —— 作者本人改正文（匿名靠 ownerKey），写 edited_at 并重新过审核；
 * 管理员改正文是纠错，不打回待审。
 */
app.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const user = c.get('user') ?? null;
  const parsed = editSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, `评论内容不能为空且不超过 ${MAX_CONTENT} 字`);
  if (!user && !ownerKeyFromRequest(c, parsed.data)) fail(401, '请先登录，或携带编辑凭证');
  const content = parsed.data.content.trim();
  if (!content) fail(400, '评论内容不能为空');

  const env = c.env;
  const db = createDb(env);
  const rows = await db.select().from(comments).where(eq(comments.id, id)).limit(1);
  const row = rows[0];
  if (!row) fail(404, '评论不存在');

  const isSelf = Boolean(user && row.authorType === 'user' && row.authorId === user.id);
  const isOwner = Boolean(row.ownerKey && ownerKeyFromRequest(c, parsed.data) === row.ownerKey);
  const isAdmin = user?.role === 'admin';
  if (!isSelf && !isOwner && !isAdmin) fail(403, '只能编辑自己的评论');

  const now = Math.floor(Date.now() / 1000);
  const ownEdit = isSelf || isOwner;
  const editedAt = ownEdit ? now : row.editedAt;
  const set: Record<string, unknown> = { content, updatedAt: now };
  let status = row.status;

  // 本人改完必须重新审核，管理员的修订不该把已通过的评论打回
  if (ownEdit) {
    set.editedAt = editedAt;
    if (!isAdmin && (await getConfigBool(env, 'spamEnabled', true))) {
      let verdict: Verdict;
      try {
        verdict = await inspectComment(env, {
          content,
          authorName: row.authorName,
          authorEmail: row.authorEmail,
          authorLink: row.authorLink,
          ipHash: row.ipHash || (await hashIp(clientIp(c), env)),
          authenticated: Boolean(user),
          createdAt: user?.createdAt ?? row.createdAt,
        });
      } catch (err) {
        // 同新发：审核自己报错时转人工，不再静默按通过处理
        console.warn('[zero-api] 编辑评论审核异常，这条转人工待审', err);
        verdict = { spam: true, score: 0, reason: '审核流程异常，已转人工', hold: true };
      }
      set.spamScore = verdict.score;
      set.spamReason = verdict.reason || null;
      if (verdict.spam) status = verdict.hold ? 'pending' : 'spam';
      set.status = status;
    }
  }

  await db.update(comments).set(set).where(eq(comments.id, id));
  /* 改完没回到「已通过」时必须说一句：以前只回 {status:'spam'}，前台什么也不显示，
     在人眼里就是「我明明改了，评论凭空不见了」。（本人自己的未通过条目现在仍在列表里，标着状态） */
  const message =
    status === 'spam'
      ? '修改已保存，但这一版没通过自动审核，站内先不公开展示；站主放行后才会出现。'
      : status === 'pending'
        ? '修改已保存，这一版要重新审核；通过前只有你自己看得见。'
        : null;
  return ok({ id, content, status, editedAt, message });
});

export default app;
