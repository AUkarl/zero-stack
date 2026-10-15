import { Hono } from 'hono';
import { desc, eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { friendPosts, friends } from '../db/schema';
import { getConfigBool } from '../services/config';
import { ok } from '../lib/errors';
import { requireAdmin } from '../middleware/auth';
import { clientIp } from '../lib/http';
import { runScheduledJobs } from '../services/scheduler';
import {
  createFriend,
  deleteFriend,
  groupFriends,
  loadFriends,
  reorderFriends,
  updateFriend,
} from '../services/friends-groups';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

/**
 * 前台友链列表：按 kind 分成两组，各自按 sortOrder 升序、相同则按加入时间升序。
 * 响应体固定是 { friends: [...], alliance: [...] }，friendsEnabled 关闭时两个数组都为空。
 * 每项字段：id / name / url / description / avatar / rssUrl / kind / sortOrder / status。
 * 存活原因不对外解释，前端按 status === 'active' 判断（原先的 alive 布尔已并入 status）。
 */
app.get('/', async (c) => {
  const env = c.env;
  if (!(await getConfigBool(env, 'friendsEnabled', true))) return ok({ friends: [], alliance: [] });
  return ok(groupFriends(await loadFriends(env)));
});

/** 友链最新文章（RSS 聚合结果），首页或 /links 侧栏用 */
app.get('/posts', async (c) => {
  const env = c.env;
  const limit = Math.min(Number(c.req.query('limit') ?? '30') || 30, 100);
  const db = createDb(env);
  const rows = await db
    .select({
      id: friendPosts.id,
      title: friendPosts.title,
      link: friendPosts.link,
      summary: friendPosts.summary,
      pubDate: friendPosts.pubDate,
      siteName: friends.name,
      siteUrl: friends.url,
    })
    .from(friendPosts)
    .innerJoin(friends, eq(friends.id, friendPosts.friendId))
    .orderBy(desc(friendPosts.pubDate))
    .limit(limit);
  return ok(rows);
});

/* ------------------------------------------------ 后台（旧路径，仍可用） */

/** 后台旧列表：保持扁平数组，顺带把 kind / sortOrder 给出去，CMS 不改也能读到分组信息 */
app.get('/all', async (c) => {
  requireAdmin(c);
  const grouped = groupFriends(await loadFriends(c.env));
  return ok([...grouped.friends, ...grouped.alliance]);
});

app.post('/', async (c) => {
  const admin = requireAdmin(c);
  const { id, item } = await createFriend(c.env, admin, await c.req.json().catch(() => null), { ip: clientIp(c) });
  return ok({ id, item });
});

app.patch('/:id', async (c) => {
  const admin = requireAdmin(c);
  const result = await updateFriend(c.env, admin, c.req.param('id'), await c.req.json().catch(() => null), { ip: clientIp(c) });
  return ok(result);
});

app.delete('/:id', async (c) => {
  const admin = requireAdmin(c);
  return ok(await deleteFriend(c.env, admin, c.req.param('id'), { ip: clientIp(c) }));
});

/** 后台：整组保存顺序 / 在友链与站点联盟之间移动（旧路径，与 /api/admin/friends/reorder 同一实现） */
app.post('/reorder', async (c) => {
  const admin = requireAdmin(c);
  return ok(await reorderFriends(c.env, admin, await c.req.json().catch(() => null), { ip: clientIp(c) }));
});

/** 手动触发检测 + 抓取，后台"立即检测"按钮用 */
app.post('/check', async (c) => {
  requireAdmin(c);
  const outcomes = await runScheduledJobs(c.env, 'manual-friends-check');
  return ok(outcomes.filter((o) => o.name.startsWith('friends:')));
});

/** 后台：友链健康详情 */
app.get('/status', async (c) => {
  requireAdmin(c);
  const rows = await createDb(c.env).select().from(friends).orderBy(desc(friends.lastCheckedAt));
  return ok(
    rows.map((f) => ({
      id: f.id,
      name: f.name,
      url: f.url,
      kind: f.kind,
      sortOrder: f.sortOrder,
      status: f.status,
      failCount: f.failCount,
      lastCheckedAt: f.lastCheckedAt,
      cooldownUntil: f.cooldownUntil,
    })),
  );
});

/** 后台：聚合文章数 */
app.get('/posts/count', async (c) => {
  requireAdmin(c);
  const rows = await createDb(c.env).select({ n: sql<number>`count(*)` }).from(friendPosts);
  return ok({ count: Number(rows[0]?.n ?? 0) });
});

export default app;
