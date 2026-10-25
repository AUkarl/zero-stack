/**
 * 友链在线申请：访客提交 → 后台审核 → 通过后写进 D1 并回写站点的 data/links.yaml。
 *
 * 分成两个导出：
 *   publicApp   挂在 /api/friends 下，供友链页表单调用
 *   adminApp    挂在 /api/admin/applications 下，供后台审核页调用
 *
 * 公开口子做了四道闸：开关、黑名单、重复申请、同 IP 限流，外加一个蜜罐字段。
 */

import { Hono } from 'hono';
import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../db/client';
import { friendApplications, friends } from '../db/schema';
import { getConfig, getConfigBool, getConfigJson } from '../services/config';
import { normalizeFriendUrl, type NewFriend } from '../services/links-yaml';
import { FRIEND_KINDS, normalizeFriendKind, type FriendKind } from '../services/friends-groups';
import { addFriendToLinksFile } from '../services/friends-file';
import { finishRepoWrites } from '../services/git';
import type { BuildHealth } from '../services/repo';
import { writeAudit } from '../services/audit';
import { sendFriendReviewResult } from '../services/review-mail';
import { newId } from '../lib/crypto';
import { clientIp } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';
import { fail, ok } from '../lib/errors';
import { requireAdmin } from '../middleware/auth';
import type { AppEnv } from '../lib/app';

const httpUrl = z
  .string()
  .trim()
  .max(300)
  .refine((v) => /^https?:\/\/[^\s]+\.[^\s]+/i.test(v), { message: '需为 http(s) 开头的完整网址' });

const applySchema = z.object({
  name: z.string().trim().min(1).max(60),
  url: httpUrl,
  description: z.string().trim().max(200).optional().or(z.literal('')),
  avatar: z.string().trim().max(300).optional().or(z.literal('')),
  email: z.string().trim().email().max(120).optional().or(z.literal('')),
  rssUrl: z.string().trim().max(300).optional().or(z.literal('')),
  reason: z.string().trim().max(500).optional().or(z.literal('')),
  /** 蜜罐：真人看不到这个输入框，填了就直接丢弃 */
  hp: z.string().max(200).optional(),
});

const optionalUrl = z
  .string()
  .trim()
  .max(300)
  .optional()
  .or(z.literal(''))
  .refine((v) => !v || /^https?:\/\/[^\s]+\.[^\s]+/i.test(v), { message: '需为 http(s) 开头的完整网址' });

/* ================= 公开：提交与查询 ================= */

export const publicApp = new Hono<AppEnv>();

publicApp.post('/apply', async (c) => {
  const env = c.env;
  if (!(await getConfigBool(env, 'friendsEnabled', true))) fail(403, '友链功能已关闭');
  if (!(await getConfigBool(env, 'friendApplyEnabled', true))) fail(403, '本站已关闭友链在线申请');

  const parsed = applySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, parsed.error.issues[0]?.message ?? '表单填写有误，请检查名称与网址');
  const input = parsed.data;

  // 蜜罐命中也回一个成功，免得脚本知道自己被识破
  if (input.hp) return ok({ status: 'pending', message: '已提交，等待站主审核' });

  const db = createDb(env);
  const now = Math.floor(Date.now() / 1000);
  const url = input.url;
  const normalized = normalizeFriendUrl(url);

  if (await blocked(env, normalized)) fail(400, '该站点不在收录范围内');

  const own = await getConfig(env, 'siteUrl');
  if (own && normalizeFriendUrl(own) === normalized) fail(400, '这是本站自己的地址');

  const listed = await db.select({ url: friends.url }).from(friends).limit(500);
  if (listed.some((f) => normalizeFriendUrl(f.url) === normalized)) fail(409, '该站点已在友链列表中');

  const previous = await findByNormalized(env, normalized);
  if (previous && previous.status === 'pending') fail(409, '该站点已提交过申请，请等待审核');
  if (previous && previous.status === 'approved') fail(409, '该站点已审核通过');

  /* 限流放所有校验之后、真正落库之前：填自己站点(400)、重复申请(409) 这些一次都没改过库，
     却照样吃掉 3 次/小时的配额 —— 正常人试两次就被 429 挡住，而换个 IP 还能接着刷。 */
  await rateLimit(c, 'friend-apply', 3, 3600);

  if (previous) {
    // url 上有唯一索引，驳回后重新提交复用同一行，顺带留下重新审核的时间
    await db
      .update(friendApplications)
      .set({
        userId: c.get('user')?.id ?? previous.userId,
        name: input.name,
        description: input.description || null,
        avatar: input.avatar || null,
        rssUrl: input.rssUrl || null,
        email: input.email || null,
        reason: input.reason || null,
        status: 'pending',
        reviewerId: null,
        reviewNote: null,
        reviewedAt: null,
        ip: clientIp(c),
        createdAt: now,
      })
      .where(eq(friendApplications.id, previous.id));
    await writeAudit(env, { actor: null, action: 'friendApp', target: url, detail: { event: 'resubmitted', id: previous.id }, ip: clientIp(c) });
    return ok({ id: previous.id, status: 'pending', message: '已重新提交，站主会再审核一次' });
  }

  const id = newId();
  await db.insert(friendApplications).values({
    id,
    userId: c.get('user')?.id ?? null,
    name: input.name,
    url,
    description: input.description || null,
    avatar: input.avatar || null,
    rssUrl: input.rssUrl || null,
    email: input.email || null,
    reason: input.reason || null,
    status: 'pending',
    ip: clientIp(c),
    createdAt: now,
  });

  // 关闭了审核环节就直接发布；失败也只回提示，申请记录仍留在库里
  const requireReview = await getConfigBool(env, 'friendApplyRequireReview', true);
  if (requireReview) {
    await writeAudit(env, { actor: null, action: 'friendApp', target: url, detail: { event: 'submitted', id }, ip: clientIp(c) });
    return ok({ id, status: 'pending', message: '已提交，站主审核通过后会出现在友链页' });
  }

  const row = await db.select().from(friendApplications).where(eq(friendApplications.id, id)).limit(1);
  const result = await approve(env, null, row[0]!);
  // 免审核的站点也要给申请人一封回音，否则他只知道「已收录」却不知道能不能点进去
  const mail = await sendFriendReviewResult(env, row[0]!, true);
  return ok({ id, status: 'approved', kind: result.kind, message: result.synced ? '已收录并同步到站点' : '已收录', ...mail });
});

/** 访客用网址查自己的申请进度；只回状态与驳回理由，不回邮箱和 IP */
publicApp.get('/apply/status', async (c) => {
  const url = (c.req.query('url') ?? '').trim();
  if (!url) fail(400, '请填写站点地址');
  await rateLimit(c, 'friend-apply-status', 20, 600);
  const row = await findByNormalized(c.env, normalizeFriendUrl(url));
  if (!row) return ok({ status: 'none' });
  return ok({
    status: row.status,
    reviewNote: row.reviewNote,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    exists: true,
  });
});

/**
 * 申请记录存的是访客原始填写的网址，同站常有 www / 末尾斜杠 / http 几种写法，
 * 所以按规范化后的网址比对，取最近提交的那一条。
 */
async function findByNormalized(env: Env, normalized: string) {
  const rows = await createDb(env)
    .select()
    .from(friendApplications)
    .orderBy(desc(friendApplications.createdAt))
    .limit(500);
  return rows.find((r) => normalizeFriendUrl(r.url) === normalized) ?? null;
}

async function blocked(env: Env, normalized: string): Promise<boolean> {
  const list = await getConfigJson<string[]>(env, 'friendApplyBlocklist', []);
  if (!Array.isArray(list)) return false;
  return list.some((rule) => {
    const r = String(rule).trim().toLowerCase();
    if (!r) return false;
    return normalized.includes(r.replace(/^https?:\/\//, '').replace(/^www\./, ''));
  });
}

/* ================= 管理：审核 ================= */

const adminApp = new Hono<AppEnv>();

interface AppRow {
  id: string;
  name: string;
  url: string;
  description: string | null;
  avatar: string | null;
  rssUrl: string | null;
  email: string | null;
  reason: string | null;
  status: string;
  reviewerId: string | null;
  reviewNote: string | null;
  ip: string | null;
  createdAt: number;
  reviewedAt: number | null;
  publishedFriendId: string | null;
}

adminApp.get('/', async (c) => {
  requireAdmin(c);
  const status = c.req.query('status') ?? '';
  const q = (c.req.query('q') ?? '').trim();
  const limit = Math.min(Number(c.req.query('limit') ?? '100') || 100, 300);
  const offset = Math.max(0, Number(c.req.query('offset') ?? '0') || 0);

  const conds = [];
  if (status && status !== 'all') conds.push(eq(friendApplications.status, status));
  if (q) conds.push(or(like(friendApplications.name, `%${q}%`), like(friendApplications.url, `%${q}%`)));
  const where = conds.length ? and(...conds) : undefined;

  const db = createDb(c.env);
  const rows = where
    ? await db.select().from(friendApplications).where(where).orderBy(desc(friendApplications.createdAt)).limit(limit).offset(offset)
    : await db.select().from(friendApplications).orderBy(desc(friendApplications.createdAt)).limit(limit).offset(offset);
  const total = await db.select({ n: sql<number>`count(*)` }).from(friendApplications).where(where);
  return ok({ items: rows as unknown as AppRow[], total: Number(total[0]?.n ?? 0) });
});

adminApp.get('/stats', async (c) => {
  requireAdmin(c);
  const rows = await createDb(c.env)
    .select({ status: friendApplications.status, n: sql<number>`count(*)` })
    .from(friendApplications)
    .groupBy(friendApplications.status);
  const by: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const r of rows) by[r.status] = Number(r.n);
  return ok({ ...by, total: by.pending + by.approved + by.rejected });
});

const approveSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  url: httpUrl.optional(),
  description: z.string().trim().max(200).optional(),
  avatar: optionalUrl,
  rssUrl: optionalUrl,
  note: z.string().trim().max(300).optional(),
  publish: z.boolean().optional(),
  /** 收录进哪一组：友链（默认）还是站点联盟 */
  kind: z.enum(FRIEND_KINDS).optional(),
  /** 组内位置；不传就排到该组末尾 */
  sortOrder: z.number().int().min(0).max(99999).optional(),
});

adminApp.post('/:id/approve', async (c) => {
  const admin = requireAdmin(c);
  const row = await loadApplication(c.env, c.req.param('id'));
  if (row.status === 'approved') fail(409, '该申请已通过');
  const parsed = approveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) fail(400, '参数有误');
  const b = parsed.data;

  const patched = { ...row, name: b.name ?? row.name, url: b.url ?? row.url, description: b.description ?? row.description, avatar: b.avatar ?? row.avatar, rssUrl: b.rssUrl ?? row.rssUrl };
  const result = await approve(c.env, admin, patched, { note: b.note, publish: b.publish !== false, kind: b.kind, sortOrder: b.sortOrder });
  // 结论先落库，邮件只是通知：发不出去也不影响「已通过」这个事实
  const mail = await sendFriendReviewResult(c.env, { ...patched, reviewNote: b.note ?? patched.reviewNote }, true, b.note);
  return ok({ id: row.id, ...result, ...mail });
});

/** 已通过但没写进 Git 的申请（当时没配仓库或提交失败），补一次同步 */
adminApp.post('/:id/publish', async (c) => {
  const admin = requireAdmin(c);
  const row = await loadApplication(c.env, c.req.param('id'));
  if (row.status !== 'approved') fail(400, '只有已通过的申请可以发布');
  // 申请表不存 kind，按已落库的那条友链决定写进 links.yaml 的哪一段
  const linked = row.publishedFriendId
    ? await createDb(c.env).select({ kind: friends.kind }).from(friends).where(eq(friends.id, row.publishedFriendId)).limit(1)
    : [];
  const synced = await syncLinksYaml(c.env, {
    name: row.name,
    url: row.url,
    description: row.description,
    avatar: row.avatar,
    email: row.email,
    rssUrl: row.rssUrl,
    kind: normalizeFriendKind(linked[0]?.kind),
  });
  await writeAudit(c.env, { actor: admin, action: 'friendApp', target: row.url, detail: { event: 'republish', ...synced }, ip: clientIp(c) });
  return ok(synced);
});

const rejectSchema = z.object({ note: z.string().trim().max(300).optional() });

adminApp.post('/:id/reject', async (c) => {
  const admin = requireAdmin(c);
  const row = await loadApplication(c.env, c.req.param('id'));
  const parsed = rejectSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) fail(400, '参数有误');

  await createDb(c.env)
    .update(friendApplications)
    .set({ status: 'rejected', reviewerId: admin.id, reviewNote: parsed.data.note || null, reviewedAt: Math.floor(Date.now() / 1000) })
    .where(eq(friendApplications.id, row.id));
  await writeAudit(c.env, { actor: admin, action: 'friendApp', target: row.url, detail: { event: 'reject', note: parsed.data.note }, ip: clientIp(c) });
  const mail = await sendFriendReviewResult(c.env, { ...row, reviewNote: parsed.data.note ?? row.reviewNote }, false, parsed.data.note);
  return ok({ id: row.id, status: 'rejected', ...mail });
});

adminApp.delete('/:id', async (c) => {
  const admin = requireAdmin(c);
  const id = c.req.param('id');
  await createDb(c.env).delete(friendApplications).where(eq(friendApplications.id, id));
  await writeAudit(c.env, { actor: admin, action: 'friendApp', target: id, detail: { event: 'delete' }, ip: clientIp(c) });
  return ok({ id, deleted: true });
});

async function loadApplication(env: Env, id: string): Promise<AppRow> {
  const rows = await createDb(env).select().from(friendApplications).where(eq(friendApplications.id, id)).limit(1);
  const row = rows[0];
  if (!row) fail(404, '申请不存在');
  return row as unknown as AppRow;
}

interface ApproveResult {
  friendId: string;
  kind: FriendKind;
  synced: boolean;
  syncError: string | null;
  /** 写进仓库后那一版 links.yaml 的 blob 号（不是提交号，见 adapters/github.ts writeFile） */
  contentSha: string | null;
  /** 本地后端的构建体检（线上没有桥时为 null）；links.yaml 写坏是「友链整页没」，所以这条也要体检 */
  buildHealth: BuildHealth | null;
}

/**
 * 通过审核：先落 D1（健康检测与动态聚合依赖它），再按开关回写站点的 links.yaml。
 * Git 那段失败不回滚 D1——站点重建是异步的，缺的那条可以用「补发布」按钮重来。
 *
 * kind 决定这条站点进「友链」还是「站点联盟」（缺省 friend），sortOrder 决定组内位置；
 * 地址已在册时不新建行，只在显式传了 kind / sortOrder 时把分组与位置挪过去。
 */
async function approve(
  env: Env,
  admin: { id?: string | null; name?: string | null } | null,
  row: AppRow,
  opts: { note?: string; publish?: boolean; kind?: FriendKind; sortOrder?: number } = {},
): Promise<ApproveResult> {
  const db = createDb(env);
  const now = Math.floor(Date.now() / 1000);
  const kind: FriendKind = opts.kind ?? 'friend';

  const dup = await db.select({ id: friends.id, url: friends.url, kind: friends.kind, sortOrder: friends.sortOrder }).from(friends).limit(500);
  const already = dup.find((f) => normalizeFriendUrl(f.url) === normalizeFriendUrl(row.url));
  const friendId = already?.id ?? newId();
  if (!already) {
    await db.insert(friends).values({
      id: friendId,
      name: row.name,
      url: row.url,
      description: row.description || null,
      avatar: row.avatar || null,
      rssUrl: row.rssUrl || null,
      kind,
      sortOrder: opts.sortOrder ?? 0,
      status: 'active',
      failCount: 0,
      createdAt: now,
    });
  } else if (opts.kind !== undefined || opts.sortOrder !== undefined) {
    // 同一地址换组或挪位置：管理员在审核框里改了 kind / sortOrder 才动，否则维持原样
    const patch: Record<string, unknown> = {};
    if (opts.kind !== undefined) patch.kind = kind;
    if (opts.sortOrder !== undefined) patch.sortOrder = opts.sortOrder;
    await db.update(friends).set(patch).where(eq(friends.id, friendId));
  }

  await db
    .update(friendApplications)
    .set({ status: 'approved', reviewerId: admin?.id ?? null, reviewNote: opts.note || row.reviewNote, reviewedAt: now, publishedFriendId: friendId })
    .where(eq(friendApplications.id, row.id));

  let synced = false;
  let syncError: string | null = null;
  let contentSha: string | null = null;
  let buildHealth: BuildHealth | null = null;
  const autoPublish = await getConfigBool(env, 'friendApplyAutoPublish', true);
  if (opts.publish !== false && autoPublish) {
    const res = await syncLinksYaml(env, {
      name: row.name,
      url: row.url,
      description: row.description,
      avatar: row.avatar,
      email: row.email,
      rssUrl: row.rssUrl,
      kind,
    });
    synced = res.synced;
    syncError = res.error;
    contentSha = res.contentSha;
    /* 同意一条友链 = 往 data/links.yaml 里写一笔，写坏了是「友链整页没」甚至整站构建失败。
       重建与体检统一放在这里（两条调用路径都过），以前是各调一次 triggerPagesBuild、谁也看不见构建结果。 */
    if (synced) buildHealth = (await finishRepoWrites(env, 1)).buildHealth;
  }

  await writeAudit(env, {
    actor: admin,
    action: 'friendApp',
    target: row.url,
    detail: { event: 'approve', friendId, kind, reused: Boolean(already), synced, syncError, contentSha, buildHealth },
  });
  return { friendId, kind, synced, syncError, contentSha, buildHealth };
}

/** 新站点写进仓库里的 data/links.yaml（文件还不存在时由 friends-file 顺手按骨架建出来） */
async function syncLinksYaml(
  env: Env,
  entry: NewFriend & { email?: string | null },
): Promise<{ synced: boolean; error: string | null; contentSha: string | null }> {
  const res = await addFriendToLinksFile(env, entry);
  return { synced: res.synced, error: res.error, contentSha: res.sha ?? null };
}

export default adminApp;
