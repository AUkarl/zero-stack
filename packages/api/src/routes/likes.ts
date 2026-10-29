import { Hono } from 'hono';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { createDb } from '../db/client';
import { commentLikes, comments, reactions } from '../db/schema';
import { getConfigBool } from '../services/config';
import { anonymousFingerprint, newId } from '../lib/crypto';
import { hashIp } from '../lib/ua';
import { readRepoFile } from '../services/repo';
import { fail, ok } from '../lib/errors';
import { clientIp } from '../lib/http';
import { rateLimit, rateLimitLocal } from '../lib/rate-limit';
import { mapChunks, parseKeys } from '../lib/batch';
import { canonSlug } from '../lib/slug';
import { contentDirs, readTargetFlag, writeTargetFlag } from '../services/target-cache';
import type { AuthUser } from '../services/auth';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

function secret(env: Env): string {
  if (!env.AUTH_SECRET) fail(500, '服务端未配置 AUTH_SECRET，请执行 wrangler secret put AUTH_SECRET');
  return env.AUTH_SECRET!;
}

/**
 * 这一页在站上真的存在吗？
 *
 * 不做这一步，`/posts/随手编一个/` 也能攒出点赞与计数（实测给根本不存在的文章点赞 200 落库），
 * 后台看不出差别。地址 → 文件的换算与删除文章、清缓存同一份口径：文章/时刻目录 + 文件名即 slug。
 * posts / moments 之外的地址（/links/、/about/、/home/ 这类单页）也要核对内容仓库里真有
 * 对应的 _index.md / index.md / <名>.md，不再「不是文章就放过」——否则任意 /foo/ 都能写评论。
 * 探一次仓库，结果在 KV 存 6 分钟；仓库读不动（没配、限流、网络）时按「存在」放过 ——
 * 反刷不能把正常评论/点赞拦在门外。
 */
export async function targetExists(env: Env, slug: string): Promise<boolean> {
  const clean = slug.replace(/^\/+|\/+$/g, '');
  // 路径段里出现 . / .. 一律当作不存在，别让拼出来的仓库路径跑出内容目录
  if (clean.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  const hit = /^(posts|moments)\/([^/]+)$/.exec(clean);

  /* 键、TTL 与作废点都在 services/target-cache.ts 那一处，别在这里再拼一遍字面量 */
  const cached = await readTargetFlag(env, clean);
  if (cached === '1') return true;
  if (cached === '0') return false;

  const dirs = await contentDirs(env);
  const postsDir = dirs.posts;
  const momentsDir = dirs.moments;
  let found = false;
  if (hit) {
    for (const dir of [postsDir, momentsDir]) {
      const base = `${dir.replace(/\/+$/, '')}/${hit[2]}`;
      /* 扁平文件与页面包（post/index.md）都认；只认扁平会把 page bundle 站点整片判成 404。 */
      for (const file of [`${base}.md`, `${base}/index.md`]) {
        try {
          if (await readRepoFile(env, file)) {
            found = true;
            break;
          }
        } catch {
          return true;
        }
      }
      if (found) break;
    }
  } else {
    /* 静态页（/links/、/about/、首页）也要核对内容仓库里真有这个页面；
       不能因为路径不以 posts/moments 开头就放行任意 /foo/ 评论。 */
    const root = postsDir.replace(/\/posts\/?$/, '').replace(/\/+$/, '') || 'content/zh';
    const rel = clean;
    const bases = rel
      ? [`${root}/${rel}/_index.md`, `${root}/${rel}/index.md`, `${root}/${rel}.md`]
      : [`${root}/_index.md`];
    for (const file of bases) {
      try {
        if (await readRepoFile(env, file)) {
          found = true;
          break;
        }
      } catch {
        return true;
      }
    }
  }
  await writeTargetFlag(env, clean, found);
  return found;
}

/* ------------------------------------------------------------------
 * 评论点赞的共用逻辑（路由挂在 routes/comments.ts 的 /api/comments/:id/like）
 *
 * 与文章点赞同一套思路，只是目标从 slug 换成 comment_id：
 *   登录 → 记 user_id；匿名 → 记加盐 IP 哈希，同一个人同一条只算一次。
 * 匿名身份刻意不含 User-Agent：掺了 UA 就等于「换一条 UA 多一票」。
 * ----------------------------------------------------------------*/

/** 当前访客在 comment_likes 里的身份：登录用 user，匿名用 IP 哈希 */
async function likeActor(env: Env, c: Context, user: AuthUser | null): Promise<{ userId: string | null; fingerprint: string | null }> {
  if (user) return { userId: user.id, fingerprint: null };
  return { userId: null, fingerprint: await hashIp(clientIp(c), env) };
}

/**
 * 整篇文章一次拿齐赞数：评论列表最多 2000 条，把 id 全塞进 IN 里 SQL 会很长，
 * 用子查询按 post_slug 圈范围，D1 走 comment_likes_comment_idx 足够快。
 */
export async function commentLikeStatsForSlug(
  env: Env,
  c: Context,
  slug: string,
  user: AuthUser | null,
): Promise<{ counts: Map<string, number>; liked: Set<string> }> {
  const counts = new Map<string, number>();
  const liked = new Set<string>();
  const db = createDb(env);
  const inPost = sql`${commentLikes.commentId} IN (SELECT ${comments.id} FROM ${comments} WHERE ${comments.postSlug} = ${slug})`;

  /* 总赞数与「我点过的」是两条独立的查询，并发跑：这条接口每篇评论区都要用，
     串起来等于白等一次 D1 往返 */
  const [agg, mine] = await Promise.all([
    db
      .select({ commentId: commentLikes.commentId, n: sql<number>`count(*)` })
      .from(commentLikes)
      .where(inPost)
      .groupBy(commentLikes.commentId),
    commentLikesOfActor(db, env, c, user, inPost),
  ]);
  for (const r of agg) counts.set(r.commentId, Number(r.n));
  for (const r of mine) liked.add(r.commentId);
  return { counts, liked };
}

/** 当前访客在这批评论里点过赞的 id（登录按 user_id，匿名按指纹） */
async function commentLikesOfActor(
  db: ReturnType<typeof createDb>,
  env: Env,
  c: Context,
  user: AuthUser | null,
  scope: SQL,
): Promise<{ commentId: string }[]> {
  const actor = await likeActor(env, c, user);
  if (!actor.userId && !actor.fingerprint) return [];
  return db
    .select({ commentId: commentLikes.commentId })
    .from(commentLikes)
    .where(and(scope, actor.userId ? eq(commentLikes.userId, actor.userId) : eq(commentLikes.fingerprint, actor.fingerprint ?? '')));
}

/** 一条评论的赞数（列表外的单点场景，比如刚点完赞要回显） */
export async function commentLikeCount(env: Env, commentId: string): Promise<number> {
  const db = createDb(env);
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(commentLikes)
    .where(eq(commentLikes.commentId, commentId));
  return Number(rows[0]?.n ?? 0);
}

/** POST /api/comments/:id/like 的实现：点过就取消，没点过就加上 */
export async function toggleCommentLike(env: Env, c: Context, commentId: string, user: AuthUser | null) {
  if (!(await getConfigBool(env, 'likeEnabled', true))) fail(403, '点赞功能已关闭');
  if (!user && !(await getConfigBool(env, 'likeAllowAnonymous', true))) fail(403, '需登录后才能点赞');

  await rateLimit(c, 'comment-like', 120, 3600, commentId);

  const db = createDb(env);
  const actor = await likeActor(env, c, user);

  const existing = await db
    .select({ id: commentLikes.id })
    .from(commentLikes)
    .where(
      and(
        eq(commentLikes.commentId, commentId),
        actor.userId ? eq(commentLikes.userId, actor.userId) : eq(commentLikes.fingerprint, actor.fingerprint ?? ''),
      ),
    )
    .limit(1);

  if (existing.length) {
    await db.delete(commentLikes).where(eq(commentLikes.id, existing[0]!.id));
  } else {
    await db.insert(commentLikes).values({
      id: newId(),
      commentId,
      userId: actor.userId,
      fingerprint: actor.fingerprint,
      createdAt: Math.floor(Date.now() / 1000),
    });
  }

  return {
    commentId,
    liked: existing.length === 0,
    likeCount: await commentLikeCount(env, commentId),
  };
}

/** POST /api/reactions { slug, kind } —— 点赞/收藏，已点则取消 */
app.post('/', async (c) => {
  const env = c.env;
  const body = (await c.req.json().catch(() => null)) as { slug?: string; kind?: string } | null;
  const kind = body?.kind === 'star' ? 'star' : 'like';
  const slug = canonSlug(body?.slug ?? '');
  if (!slug || slug === '/') fail(400, '缺少目标文章');

  const enabled = await getConfigBool(env, kind === 'star' ? 'starEnabled' : 'likeEnabled', true);
  if (!enabled) fail(403, kind === 'star' ? '收藏功能已关闭' : '点赞功能已关闭');

  const user = c.get('user');
  if (!user && !(await getConfigBool(env, 'likeAllowAnonymous', true))) fail(403, '需登录后才能点赞');

  // 点赞收藏是前台高频口，计数走 isolate 内存，不占 KV 写额度
  rateLimitLocal(c, 'reaction', 60, 3600, slug);
  const db = createDb(env);
  const fingerprint = user ? null : await anonymousFingerprint(secret(env), clientIp(c));

  const existing = await db
    .select({ id: reactions.id })
    .from(reactions)
    .where(
      and(
        eq(reactions.targetSlug, slug),
        eq(reactions.kind, kind),
        user ? eq(reactions.userId, user.id) : eq(reactions.fingerprint, fingerprint ?? ''),
      ),
    )
    .limit(1);

  if (existing.length) {
    await db.delete(reactions).where(eq(reactions.id, existing[0]!.id));
  } else {
    // 取消已有的赞不需要文章还在（删掉的文章也要能把自己那一票收回来）；新增才验地址
    if (!(await targetExists(env, slug))) fail(404, '这一页在站上不存在，无法点赞或收藏');
    await db.insert(reactions).values({
      id: newId(),
      targetSlug: slug,
      kind,
      userId: user?.id ?? null,
      fingerprint,
      createdAt: Math.floor(Date.now() / 1000),
    });
  }

  const count = await db
    .select({ n: sql<number>`count(*)` })
    .from(reactions)
    .where(and(eq(reactions.targetSlug, slug), eq(reactions.kind, kind)));

  return ok({ slug, kind, active: existing.length === 0, count: Number(count[0]?.n ?? 0) });
});

/** GET /api/reactions?slugs=/a/,/b&kind=like —— 列表页批量取计数与本人状态 */
app.get('/', async (c) => {
  const env = c.env;
  const raw = parseKeys(c.req.query('slugs'));
  const kind = c.req.query('kind') === 'star' ? 'star' : 'like';
  if (raw.length === 0) return ok({});
  const slugs = [...new Set(raw.map(canonSlug))];

  const db = createDb(env);
  /* 这一条比评论计数更早撞墙：两个 in 各绑一次全部键。分批发，回包形状不变。 */
  const counts = await mapChunks(slugs, (part) =>
    db
      .select({ slug: reactions.targetSlug, n: sql<number>`count(*)` })
      .from(reactions)
      .where(and(inArray(reactions.targetSlug, part), eq(reactions.kind, kind)))
      .groupBy(reactions.targetSlug),
  );

  const byCanon: Record<string, { count: number; active: boolean }> = {};
  for (const s of slugs) byCanon[s] = { count: 0, active: false };
  for (const r of counts) if (byCanon[r.slug]) byCanon[r.slug]!.count = Number(r.n);

  const user = c.get('user');
  const fingerprint = user ? null : await anonymousFingerprint(secret(env), clientIp(c));
  const mine = await mapChunks(slugs, (part) =>
    db
      .select({ slug: reactions.targetSlug })
      .from(reactions)
      .where(
        and(
          inArray(reactions.targetSlug, part),
          eq(reactions.kind, kind),
          user ? eq(reactions.userId, user.id) : eq(reactions.fingerprint, fingerprint ?? ''),
        ),
      ),
  );
  for (const m of mine) if (byCanon[m.slug]) byCanon[m.slug]!.active = true;

  const out: Record<string, { count: number; active: boolean }> = {};
  for (const s of raw) out[s] = byCanon[canonSlug(s)] ?? { count: 0, active: false };

  return ok(out);
});

export default app;
