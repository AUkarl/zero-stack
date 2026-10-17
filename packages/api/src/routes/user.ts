/**
 * 用户中心（挂在 /api/user）：登录读者只看得到自己的数据。
 *
 * 权限位由管理员在后台勾选，这里每次请求都从会话里读最新值（resolveSession 走库），
 * 所以后台一取消授权，用户的投稿入口立刻关闭，不用等 token 过期。
 *
 * 另导出 authorsPublic（挂在 /api/authors）供文章署名旁渲染作者卡与认证徽章，是公开接口。
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, inArray, or } from 'drizzle-orm';
import { createDb } from '../db/client';
import { users } from '../db/schema';
import { writeAudit } from '../services/audit';
import { withAdminAuthorBits } from '../services/admin-author';
import { getConfig, getConfigBool } from '../services/config';
import { triggerPagesBuild } from '../services/git';
import { avatarForEmail } from '../lib/avatar';
import { setOwnerProfile } from './frontend';
import { requireUser } from '../middleware/auth';
import { clientIp } from '../lib/http';
import { fail, ok } from '../lib/errors';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

const optionalUrl = z
  .string()
  .trim()
  .max(300)
  .optional()
  .or(z.literal(''))
  .refine((v) => !v || /^https?:\/\/[^\s]+\.[^\s]+/i.test(v), { message: '需为 http(s) 开头的完整网址' });

/** 会话里的权限位汇总，前端据此决定标签页显示还是置灰 */
app.get('/permissions', async (c) => {
  const user = requireUser(c);
  const db = createDb(c.env);
  const rows = await db
    .select({
      name: users.name,
      handle: users.handle,
      email: users.email,
      image: users.image,
      bio: users.bio,
      website: users.website,
      role: users.role,
      canPublish: users.canPublish,
      canAuthor: users.canAuthor,
      authorVerified: users.authorVerified,
      emailVerified: users.emailVerified,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const row = rows[0];
  if (!row) fail(404, '账号不存在');
  return ok({
    ...row,
    isAdmin: row.role === 'admin',
    draftsEnabled: await getConfigBool(c.env, 'draftsEnabled', true),
    authorVerifyEnabled: await getConfigBool(c.env, 'authorVerifyEnabled', true),
  });
});

const profileSchema = z.object({
  name: z.string().trim().min(1).max(64),
  bio: z.string().trim().max(200).optional().or(z.literal('')),
  website: optionalUrl,
  image: z.string().trim().max(500).optional().or(z.literal('')),
});

/** PATCH /api/user/profile —— 昵称、简介、个人站点与头像；邮箱与密码走 auth 路由的验证码流程 */
app.patch('/profile', async (c) => {
  const user = requireUser(c);
  const parsed = profileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, parsed.error.issues[0]?.message ?? '资料填写有误');
  const db = createDb(c.env);
  const now = Math.floor(Date.now() / 1000);
  const image = (parsed.data.image || '').trim();
  if (image && !/^https?:\/\//i.test(image)) fail(400, '头像地址要以 http:// 或 https:// 开头');
  await db
    .update(users)
    .set({
      name: parsed.data.name,
      bio: parsed.data.bio || null,
      website: parsed.data.website || null,
      image: image || null,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));
  await writeAudit(c.env, {
    actor: user,
    action: 'profile',
    target: user.id,
    detail: { name: parsed.data.name, bio: parsed.data.bio || null, website: parsed.data.website || null, image: image || null },
    ip: clientIp(c),
  });
  /*
   * 站长改的是全站对外的身份：顺手把昵称 + 头像落到内容仓库的 data/owner.json，
   * 前台关于页顶部的头像与昵称读那份（主题 partials/about-content.html），
   * 等一次 Pages 构建就跟上，不用再让人去 params.toml 里改第二遍。
   * 普通读者的账号资料只影响他自己（评论、作者卡片），不碰仓库。
   * 头像没填时按邮箱给一张（后台头像模板优先，其次 Gravatar→Cravatar→QQ），
   * 与评论侧同一条链；关于页那边拿到的是地址，图挂了它自己回落 params。
   */
  let ownerSync: { ok: boolean; changed: boolean; detail: string; build?: Awaited<ReturnType<typeof triggerPagesBuild>> } | null = null;
  if (user.role === 'admin') {
    const mail = (user.email || '').trim().toLowerCase();
    const template = (await getConfig(c.env, 'avatarTemplate'))?.trim() ?? '';
    const avatar = image || avatarForEmail(mail, template);
    ownerSync = await setOwnerProfile(c.env, { name: parsed.data.name.trim(), avatar })
      .then(async (r) => {
        // 真写了文件才值得再跑一次构建；本来就是这样就原样回报，不动仓库也不重建
        if (!r.ok || !r.changed) return r;
        return { ...r, build: await triggerPagesBuild(c.env).catch((e) => ({ triggered: false, error: e instanceof Error ? e.message : '触发失败' })) };
      })
      .catch((e) => ({ ok: false, changed: false, detail: e instanceof Error ? e.message : '写入失败' }));
  }
  return ok({ updated: true, image: image || null, ownerSync });
});

/* ---------------- 我的评论 ---------------- */

/** GET /api/user/comments —— 含待审核与被拦截的，状态一并返回好让前端标注 */
export default app;

/* ================= 公开：作者卡片 ================= */

/**
 * GET /api/authors?ids=a,b,c —— 文章多作者署名用。
 * ids 既可以是 users.id，也可以是作者标识 handle（front matter 里写的那个）；
 * 只输出公开字段，邮箱与权限位一概不带，返回顺序跟着请求走。
 */
export const authorsPublic = new Hono<AppEnv>();

type AuthorRow = {
  id: string;
  role?: string | null;
  handle: string | null;
  name: string | null;
  image: string | null;
  bio: string | null;
  website: string | null;
  accountSlug?: string | null;
  authorVerified: boolean | null;
};

function toAuthorCard(source: AuthorRow) {
  // 管理员就是站点的认证作者，不用再去后台给自己点一遍「作者认证」
  const row = withAdminAuthorBits(source);
  return {
    id: row.id,
    handle: row.handle,
    name: row.name || '匿名',
    image: row.image,
    bio: row.bio,
    website: row.website,
    verified: Boolean(row.authorVerified),
  };
}

authorsPublic.get('/', async (c) => {
  const ids = (c.req.query('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (ids.length === 0) return ok([]);
  const db = createDb(c.env);
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      handle: users.handle,
      name: users.name,
      image: users.image,
      bio: users.bio,
      website: users.website,
      accountSlug: users.accountSlug,
      authorVerified: users.authorVerified,
    })
    .from(users)
    .where(and(or(inArray(users.id, ids), inArray(users.handle, ids.map((s) => s.toLowerCase()))), eq(users.status, 'active')));

  const byKey = new Map<string, AuthorRow>();
  for (const source of rows) {
    const r = withAdminAuthorBits(source);
    byKey.set(r.id, r);
    if (r.handle) byKey.set(r.handle, r);
  }

  const seen = new Set<string>();
  const cards: ReturnType<typeof toAuthorCard>[] = [];
  for (const key of ids) {
    const row = byKey.get(key) ?? byKey.get(key.toLowerCase());
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    cards.push(toAuthorCard(row));
  }
  return ok(cards);
});
