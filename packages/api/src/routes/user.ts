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
import { getConfigBool } from '../services/config';
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
  return ok({ updated: true, image: image || null });
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
  handle: string | null;
  name: string | null;
  image: string | null;
  bio: string | null;
  website: string | null;
  authorVerified: boolean | null;
};

function toAuthorCard(row: AuthorRow) {
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
      handle: users.handle,
      name: users.name,
      image: users.image,
      bio: users.bio,
      website: users.website,
      authorVerified: users.authorVerified,
    })
    .from(users)
    .where(and(or(inArray(users.id, ids), inArray(users.handle, ids.map((s) => s.toLowerCase()))), eq(users.status, 'active')));

  const byKey = new Map<string, AuthorRow>();
  for (const r of rows) {
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
