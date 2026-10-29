/**
 * 友链 / 站点联盟的分组与排序（friends 表的 kind + sort_order）。
 *
 * 一份逻辑两处用：
 *   routes/friends.ts  前台 GET /api/friends 与旧的后台路径 /api/friends/*
 *   routes/admin.ts    新的后台路径 /api/admin/friends*（列表 / 新增 / 改 / 删 / 整组排序）
 * 两处都调这里，避免「后台改了顺序、前台读出来是另一个样」这种分裂。
 *
 * kind 只有两个取值：'friend'（友链，参与存活检测与 RSS 聚合）| 'alliance'（站点联盟）。
 * 排序：同组内 sortOrder 升序，相同则按加入时间（createdAt）升序，再按名称兜底。
 */

import { z } from 'zod';
import { eq, inArray, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { friendPosts, friends } from '../db/schema';
import { writeAudit } from './audit';
import { addFriendToLinksFile, linksFileHas, removeFriendFromLinksFile, updateFriendInLinksFile, type LinksFileResult } from './friends-file';
import { normalizeFriendUrl, type NewFriend } from './links-yaml';
import { finishRepoWrites } from './git';
import { newId } from '../lib/crypto';
import { httpUrlField, optionalHttpUrlField } from '../lib/httpUrl';
import { fail } from '../lib/errors';
import { zodZh } from '../lib/zmsg';

type FriendRow = typeof friends.$inferSelect;

export const FRIEND_KINDS = ['friend', 'alliance'] as const;
export type FriendKind = (typeof FRIEND_KINDS)[number];

/** 兜成合法取值：认不出的一律当 'friend'（旧数据与手工填错的 kind 都走这条） */
export function normalizeFriendKind(raw: unknown): FriendKind {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  return v === 'alliance' ? 'alliance' : 'friend';
}

/** 前台每一项的字段约定（CMS 与主题只认这 9 个键） */
export interface FriendItem {
  id: string;
  name: string;
  url: string;
  description: string | null;
  avatar: string | null;
  rssUrl: string | null;
  kind: FriendKind;
  sortOrder: number;
  status: string;
}

/* 协议口径不在本文件里定：见 lib/httpUrl.ts。这一份以前是本文件手抄的（而且只抄了一半 ——
   它用 zod 的 `.url()`，而那个判据不看协议，于是 `javascript:alert(1)` 存得进库、
   回读也拿得到，最后被主题原样写进 `<a href>`）。现在三条写入口共用同一份。 */
const maybeUrl = (label: string) =>
  optionalHttpUrlField({ max: 500, message: `${label}需为 http(s) 开头的完整网址（其它协议不能出现在链接里）` });

export const friendCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: httpUrlField({ max: 500 }),
  description: z.string().trim().max(200).optional().or(z.literal('')),
  avatar: maybeUrl('头像地址'),
  rssUrl: maybeUrl('RSS 地址'),
  kind: z.enum(FRIEND_KINDS).optional(),
  sortOrder: z.number().int().min(0).max(99999).optional(),
});

export const friendPatchSchema = friendCreateSchema.partial();

export const reorderSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(64),
        kind: z.enum(FRIEND_KINDS).optional(),
        sortOrder: z.number().int().min(0).max(99999),
      }),
    )
    .min(1, '请至少提交一条顺序')
    .max(500, '一次最多保存 500 条顺序'),
});

export function toFriendItem(row: FriendRow): FriendItem {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    description: row.description ?? null,
    avatar: row.avatar ?? null,
    rssUrl: row.rssUrl ?? null,
    kind: normalizeFriendKind(row.kind),
    sortOrder: Number(row.sortOrder ?? 0),
    status: row.status,
  };
}

/** D1 行 → 数据文件那一条（yaml 的 email / image 两样库里没有，留空由站长自己补） */
function toFileEntry(row: {
  name: string;
  url: string;
  description: string | null;
  avatar: string | null;
  rssUrl: string | null;
  kind: FriendKind;
}): NewFriend {
  return {
    name: row.name,
    url: row.url,
    description: row.description,
    avatar: row.avatar,
    rssUrl: row.rssUrl,
    kind: row.kind,
  };
}

/**
 * 写完数据文件就问一次 Pages 重建：没配 Hook 时它自己回「未配置」，
 * 提交已经成功这件事不受影响；本地开发走目录回写，由 hugo server 直接看到。
 */
async function applyLinksFile(env: Env, res: LinksFileResult): Promise<LinksFileResult> {
  if (!res.synced) return res;
  /* 走唯一的收尾（请重建 + 跑一次构建体检），别只调 triggerPagesBuild 就把结果扔掉：
     这一页每次增删改写的都是 data/links.yaml —— 那是 Hugo 构建期读的数据文件，
     写坏了是整站构建失败（实测过一次：段头 `friends: []` 后面挂条目，接口回「已同步」、站点从这一刻静默停更）。
     体检结论挂在 linksFile.buildHealth 上，后台用同一个 healthWarn() 说话。 */
  const { buildHealth } = await finishRepoWrites(env, 1);
  return { ...res, buildHealth };
}

/** 组内排序：sortOrder 升序 → 加入时间升序 → 名称兜底（保证顺序稳定可复现） */
function sortRows(rows: FriendRow[]): FriendRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0) ||
      Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0) ||
      a.name.localeCompare(b.name, 'zh'),
  );
}

function byKind(rows: FriendRow[], kind: FriendKind): FriendRow[] {
  return sortRows(rows.filter((r) => normalizeFriendKind(r.kind) === kind));
}

/** 按 kind 分成两组，各自排好序；前台 GET /api/friends 的响应体就是它 */
export function groupFriends(rows: FriendRow[]): { friends: FriendItem[]; alliance: FriendItem[] } {
  return { friends: byKind(rows, 'friend').map(toFriendItem), alliance: byKind(rows, 'alliance').map(toFriendItem) };
}

/** 后台列表：分组 + 保留健康详情字段，CMS 一张表就能显示状态 */
export function groupFriendsDetail(rows: FriendRow[]) {
  const pack = (kind: FriendKind) =>
    byKind(rows, kind).map((r) => ({
      ...toFriendItem(r),
      failCount: r.failCount,
      lastCheckedAt: r.lastCheckedAt,
      cooldownUntil: r.cooldownUntil,
      createdAt: r.createdAt,
    }));
  return { friends: pack('friend'), alliance: pack('alliance') };
}

/** 新条目默认排到该组末尾，免得管理员忘了填就全挤在 0 上 */
async function nextSortOrder(env: Env, kind: FriendKind): Promise<number> {
  const rows = await createDb(env)
    .select({ n: sql<number>`coalesce(max(${friends.sortOrder}), -1)` })
    .from(friends)
    .where(eq(friends.kind, kind));
  return Number(rows[0]?.n ?? -1) + 1;
}

/** 规范化后比对网址：www / 末尾斜杠 / http 与 https 视作同一个站 */
async function clashByNormalizedUrl(env: Env, url: string, selfId?: string): Promise<string | null> {
  const target = normalizeFriendUrl(url);
  const rows = await createDb(env)
    .select({ id: friends.id, url: friends.url })
    .from(friends)
    .limit(500);
  return rows.find((r) => r.id !== selfId && normalizeFriendUrl(r.url) === target)?.id ?? null;
}

export interface FriendMeta {
  ip?: string;
}

export interface FriendActor {
  id?: string | null;
  name?: string | null;
}

/** 新增：kind 缺省 'friend'，sortOrder 缺省排到该组末尾 */
export async function createFriend(env: Env, admin: FriendActor, body: unknown, meta: FriendMeta = {}) {
  const parsed = friendCreateSchema.safeParse(body);
  if (!parsed.success) fail(400, zodZh(parsed.error, '名称与合法 URL 为必填'));
  const kind = normalizeFriendKind(parsed.data.kind);
  if (await clashByNormalizedUrl(env, parsed.data.url)) fail(409, '该站点已被收录（同一地址不能出现两次；要换分组请用 PATCH 的 kind）');

  const db = createDb(env);
  const id = newId();
  const sortOrder = parsed.data.sortOrder ?? (await nextSortOrder(env, kind));
  await db.insert(friends).values({
    id,
    name: parsed.data.name,
    url: parsed.data.url,
    description: parsed.data.description || null,
    avatar: parsed.data.avatar || null,
    rssUrl: parsed.data.rssUrl || null,
    kind,
    sortOrder,
    status: 'active',
    failCount: 0,
    createdAt: Math.floor(Date.now() / 1000),
  });
  await writeAudit(env, { actor: admin, action: 'friend', target: id, detail: { event: 'create', kind, sortOrder, url: parsed.data.url }, ip: meta.ip });
  const row = await load(env, id);
  if (!row) fail(500, '写入后读不到这条友链，请刷新列表');
  const linksFile = await applyLinksFile(env, await addFriendToLinksFile(env, toFileEntry({ ...row, kind: normalizeFriendKind(row.kind) })));
  return { id, item: toFriendItem(row), linksFile };
}

/** 修改：可改 kind（在友链与站点联盟之间移动）与 sortOrder（改位置） */
export async function updateFriend(env: Env, admin: FriendActor, id: string, body: unknown, meta: FriendMeta = {}) {
  const parsed = friendPatchSchema.safeParse(body);
  if (!parsed.success) fail(400, zodZh(parsed.error, '参数有误'));
  const db = createDb(env);
  const before = await load(env, id);
  if (!before) fail(404, '友链不存在');

  const d = parsed.data;
  const patch: Record<string, unknown> = {};
  if (d.name !== undefined) patch.name = d.name;
  if (d.description !== undefined) patch.description = d.description || null;
  if (d.avatar !== undefined) patch.avatar = d.avatar || null;
  if (d.rssUrl !== undefined) patch.rssUrl = d.rssUrl || null;
  if (d.kind !== undefined) patch.kind = normalizeFriendKind(d.kind);
  if (d.sortOrder !== undefined) patch.sortOrder = d.sortOrder;
  if (d.url !== undefined && normalizeFriendUrl(d.url) !== normalizeFriendUrl(before.url)) {
    if (await clashByNormalizedUrl(env, d.url, id)) fail(409, '另一个条目已经占用了这个地址');
    // 改完地址就当新站看待，重新计数
    Object.assign(patch, { url: d.url, status: 'active', failCount: 0, cooldownUntil: null });
  }
  if (!Object.keys(patch).length) return { id, item: toFriendItem(before), unchanged: true };

  await db.update(friends).set(patch).where(eq(friends.id, id));
  await writeAudit(env, {
    actor: admin,
    action: 'friend',
    target: id,
    detail: {
      event: 'update',
      from: { kind: normalizeFriendKind(before.kind), sortOrder: before.sortOrder, url: before.url },
      to: patch,
    },
    ip: meta.ip,
  });
  const row = await load(env, id);
  if (!row) fail(500, '更新后读不到这条友链，请刷新列表');
  /* 数据文件里那条要跟着改：改网址 / 换分组必须动它，只改文字也要原位更新，
     否则「后台改了、站点上还是旧的」。找不到那条（早先手工删过文件）就补写一条。 */
  const linksFile = await applyLinksFile(
    env,
    await updateFriendInLinksFile(env, before.url, toFileEntry({ ...row, kind: normalizeFriendKind(row.kind) })),
  );
  return { id, item: toFriendItem(row), unchanged: false, linksFile };
}

/** 删除：连同桌这个站聚合来的文章 */
export async function deleteFriend(env: Env, admin: FriendActor, id: string, meta: FriendMeta = {}) {
  const db = createDb(env);
  const row = await load(env, id);
  if (!row) fail(404, '友链不存在');
  /* 先清数据文件再删库。前台那两个板块是构建期读 data/links.yaml 渲染的，
     库里删了、文件里留着，这条链接就变成后台再也管不到的僵尸（「多出的友链」就是这么来的）。
     文件里明确有这一条却没清掉时报错保持原样，让管理员重试；读不到文件（没配仓库）时只删库并回执原因。 */
  const inFile = await linksFileHas(env, row.url);
  const linksFile = await removeFriendFromLinksFile(env, row.url, row.name);
  if (inFile && !linksFile.synced) fail(502, `站点数据文件没清掉，这条友链保持原样：${linksFile.error ?? '未知原因'}`);
  await db.delete(friendPosts).where(inArray(friendPosts.friendId, [id]));
  await db.delete(friends).where(eq(friends.id, id));
  await writeAudit(env, {
    actor: admin,
    action: 'friend',
    target: id,
    detail: { event: 'delete', name: row.name, url: row.url, kind: normalizeFriendKind(row.kind), sortOrder: row.sortOrder },
    ip: meta.ip,
  });
  // 数据文件动过就问一次站点重建（没配 Hook 时它自己回「未配置」）
  return { id, deleted: true, linksFile: await applyLinksFile(env, linksFile) };
}

/**
 * 整组保存顺序：一次提交 [{id,kind,sortOrder}]，同时完成「换组」与「改位置」。
 * 未知 id 跳过并在返回里点名，前端据此提示刷新列表（可能别人刚删过）。
 */
export async function reorderFriends(env: Env, admin: FriendActor, body: unknown, meta: FriendMeta = {}) {
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) fail(400, zodZh(parsed.error, 'items 需为 [{id,kind,sortOrder}]'));
  const db = createDb(env);
  const ids = [...new Set(parsed.data.items.map((i) => i.id))];
  const rows = await db.select().from(friends).where(inArray(friends.id, ids));
  const known = new Map(rows.map((r) => [r.id, r]));

  const updated: { id: string; kind: FriendKind; sortOrder: number }[] = [];
  const missing: string[] = [];
  /** 真的换了组的那几条 —— 数据文件里的段落必须跟着搬 */
  const moved: { row: FriendRow; kind: FriendKind }[] = [];
  for (const item of parsed.data.items) {
    const row = known.get(item.id);
    if (!row) {
      missing.push(item.id);
      continue;
    }
    const kind = normalizeFriendKind(item.kind);
    const patch: Record<string, unknown> = { sortOrder: item.sortOrder };
    if (normalizeFriendKind(row.kind) !== kind) {
      patch.kind = kind;
      moved.push({ row, kind });
    }
    await db.update(friends).set(patch).where(eq(friends.id, item.id));
    updated.push({ id: item.id, kind, sortOrder: item.sortOrder });
  }

  /* 本函数的注释写着「一次提交同时完成换组与改位置」，可以前只改库：
     D1 里这条变成联盟了，data/links.yaml 里它还在 friends 段 —— 前台「站点联盟」是构建期从那份文件
     并进来的，于是界面上动完了、站点上没动，又是一次「两份各管一半」。
     新增 / 修改 / 删除三条都同步文件，唯独排序这条路漏了，现在补上（同一段落里的顺序变化
     前台不读文件，不必动它，所以只有真换组才写）。 */
  let linksFile: LinksFileResult | null = null;
  for (const m of moved) {
    linksFile = await applyLinksFile(
      env,
      await updateFriendInLinksFile(env, m.row.url, toFileEntry({ ...m.row, kind: m.kind })),
    );
  }

  await writeAudit(env, {
    actor: admin,
    action: 'friend',
    target: updated.map((u) => u.id).join(','),
    detail: { event: 'reorder', items: parsed.data.items, updated, missing, moved: moved.length, linksFile },
    ip: meta.ip,
  });
  return { updated: updated.length, missing, items: updated, moved: moved.length, linksFile };
}

/** 单条读取 */
async function load(env: Env, id: string): Promise<FriendRow | null> {
  const rows = await createDb(env).select().from(friends).where(eq(friends.id, id)).limit(1);
  return rows[0] ?? null;
}

/** 分组读全表：前台与管理端共用 */
export async function loadFriends(env: Env): Promise<FriendRow[]> {
  return createDb(env).select().from(friends);
}
