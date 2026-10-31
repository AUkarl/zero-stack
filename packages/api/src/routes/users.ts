import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { comments, inviteCodes, sessions, users } from '../db/schema';
import { hashPassword, randomPassword } from '../lib/crypto';
import { destroyUserSessions } from '../services/auth';
import { purgeUser } from '../services/account-purge';
import { contentTitles } from '../services/content-title';
import { writeAudit } from '../services/audit';
import { requireAdmin } from '../middleware/auth';
import { clientIp } from '../lib/http';
import { canonHandle } from '../lib/slug';
import { deriveHandle, userGroupName, withAdminAuthorBits } from '../services/admin-author';
import { fail, ok, okRows } from '../lib/errors';
import type { AppEnv } from '../lib/app';

/**
 * 账号标识：后台手工改定时也要保证唯一——规范化后撞车就追加三位随机数。
 * 与注册时分配 account_slug 的规则一致，用户中心 /account/me/?u=@<标识> 用它定位。
 */
async function uniqueAccountSlug(env: Env, raw: string, selfId: string): Promise<string> {
  const db = createDb(env);
  const base = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!base) fail(400, '账号标识只能用字母、数字、点、下划线和短横线');

  const clash = async (candidate: string) => {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.accountSlug, candidate), sql`${users.id} <> ${selfId}`))
      .limit(1);
    return rows[0];
  };

  if (!(await clash(base))) return base;
  for (let i = 0; i < 20; i++) {
    const candidate = `${base}${100 + Math.floor(Math.random() * 900)}`.slice(0, 40);
    if (!(await clash(candidate))) return candidate;
  }
  return fail(409, '账号标识重复太多，请手工指定一个');
}

/**
 * 除了 selfId 之外还有没有别的管理员。
 * 降权 / 封禁 / 切用户组前都要问一句，免得整站没人能进后台。
 */
async function hasOtherAdmin(db: ReturnType<typeof createDb>, selfId: string): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(users)
    .where(and(eq(users.role, 'admin'), sql`${users.id} <> ${selfId}`))
    .limit(1);
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * 用户管理（挂在 /api/admin/users）：列表、改权限位与用户组、封禁/解封、删除账号。
 * 封禁会立刻作废该用户全部会话，并阻止其继续评论（评论侧按 userId 复查状态）。
 *
 * 站长自己那一行也列在里页（标「站长」，权限位常亮）。以前这里默认
 * `where role <> 'admin'`，要 ?includeAdmin=1 才看得到，而 handle（作者标识）
 * 偏偏只在这一页能改 —— 于是「站长作者资料」保存时报「先到『用户』页补一个」，
 * 那一页又没有站长那一行，成一个死循环。
 *
 * 管理员唯一：这里不再能把 role 改成 admin —— 首个账号自动成为管理员，
 * 之后只有那条路径能产生 admin，避免后台一点就把读者提成第二个管理员。
 * 作者认证通过后 user_group 由 reviews 侧写成 coauthor，这里不勾就不动它。
 */
const app = new Hono<AppEnv>();

/** 显示口径的用户组：管理员恒为 owner（中文「站长」），其余按库里的 user_group */
export function userGroupView(row: { role: string | null; userGroup: string | null }): string {
  return row.role === 'admin' ? 'owner' : row.userGroup || 'friend';
}

app.get('/', async (c) => {
  const db = createDb(c.env);
  const [rows, cmt, sess] = await Promise.all([
    db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        handle: users.handle,
        role: users.role,
        status: users.status,
        canPublish: users.canPublish,
        canAuthor: users.canAuthor,
        authorVerified: users.authorVerified,
        emailVerified: users.emailVerified,
        accountSlug: users.accountSlug,
        userGroup: users.userGroup,
        totpEnabled: users.totpEnabled,
        invitedBy: users.invitedBy,
        createdAt: users.createdAt,
      })
      .from(users),
    /* 评论数与会话数另查两次再在内存里并上：
       原先写成 select 里的相关子查询（`(select count(*) ... = ${users.id})`），
       D1 那边恒回 0 —— 列表说「评论 0」而点开详情列得出两条，两处自相矛盾。 */
    db
      .select({ id: comments.authorId, n: sql<number>`count(*)` })
      .from(comments)
      .where(eq(comments.authorType, 'user'))
      .groupBy(comments.authorId),
    db.select({ id: sessions.userId, n: sql<number>`count(*)` }).from(sessions).groupBy(sessions.userId),
  ]);
  const cmtById = new Map(cmt.map((r) => [r.id ?? '', Number(r.n)]));
  const sessById = new Map(sess.map((r) => [r.id ?? '', Number(r.n)]));
  const counted = rows.map((r) => ({ ...r, commentCount: cmtById.get(r.id) ?? 0, sessionCount: sessById.get(r.id) ?? 0 }));

  // 邀请码只用来把 invitedBy 还原成人能看的码，不参与分页
  const codes = await db.select({ id: inviteCodes.id, code: inviteCodes.code }).from(inviteCodes);
  const codeById = new Map(codes.map((r) => [r.id, r.code]));
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const filtered = q
    ? counted.filter(
        (r) =>
          r.email.toLowerCase().includes(q) ||
          (r.name ?? '').toLowerCase().includes(q) ||
          (r.handle ?? '').toLowerCase().includes(q) ||
          (codeById.get(r.invitedBy ?? '') ?? '').toLowerCase().includes(q),
      )
    : counted;

  const list = filtered
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((raw) => {
      // 管理员那一行读出来就是全亮的（库里值与显示口径不再分两套）
      const r = withAdminAuthorBits(raw);
      return {
        ...r,
        invitedCode: codeById.get(r.invitedBy ?? '') ?? null,
        /** 库里的原值（friend|coauthor），PATCH 回填用这个 */
        user_group: r.userGroup,
        /** 显示口径：管理员为 owner（站长） */
        userGroupView: userGroupView(r),
        user_group_name: userGroupName(r),
      };
    });

  /* 形状：`{data:{items,total,data}}` + 顶层同值的 `items/total`。旧读者照旧读 `data.data`，
     新脚本与后台一律读 `items` —— 管理列表口过去有三种形状，自测脚本按错键名取数就报「列表是空的」。 */
  return okRows(list, { total: filtered.length, data: list });
});

app.patch('/:id', async (c) => {
  const admin = requireAdmin(c);
  const id = c.req.param('id');
  const parsed = z
    .object({
      role: z.enum(['admin', 'reader']).optional(),
      status: z.enum(['active', 'banned']).optional(),
      canPublish: z.boolean().optional(),
      canAuthor: z.boolean().optional(),
      authorVerified: z.boolean().optional(),
      handle: z.union([z.string().max(60), z.null()]).optional(),
      /**
       * 用户组：朋友 / 共创 / 站长。
       * 'owner' 是管理员（站长）的显示组，只有目标本身就是管理员时才可写；
       * 作者认证通过时由 reviews 侧写 coauthor，这里不传就不覆盖。
       */
      user_group: z.enum(['friend', 'coauthor', 'owner']).optional(),
      /** 用户中心地址用的账号标识 */
      account_slug: z.union([z.string().trim().min(1).max(40), z.null()]).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, 'role 只能是 admin 或 reader，status 只能是 active 或 banned，user_group 只能是 friend / coauthor / owner，权限位只能是布尔值');
  const db = createDb(c.env);

  const target = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const user = target[0];
  if (!user) fail(404, '用户不存在');
  // 管理员唯一：不能把读者提成第二个管理员（admin 只由「首个账号」那一条路径产生）
  if (parsed.data.role === 'admin' && user.role !== 'admin') {
    fail(400, '站内只保留一个管理员账号，不能把读者提升为管理员');
  }
  if (user.id === admin.id && (parsed.data.role === 'reader' || parsed.data.status === 'banned')) {
    fail(400, '不能对自己降权或封禁');
  }
  if (parsed.data.user_group === 'owner' && user.role !== 'admin') {
    fail(400, '「站长」只属于管理员账号，普通账号请选朋友或共创');
  }
  // 摘掉最后一个管理员（降权或封禁）之后后台就没人能进了，一律拒绝
  if (user.role === 'admin' && (parsed.data.role === 'reader' || parsed.data.status === 'banned')) {
    if (!(await hasOtherAdmin(db, id))) {
      fail(409, '这是站内最后一个管理员：降权或封禁后没人能进后台。请先让另一个账号接手管理员，再动这个账号。');
    }
  }

  const set: Record<string, unknown> = { updatedAt: Math.floor(Date.now() / 1000) };
  if (parsed.data.role) set.role = parsed.data.role;
  if (parsed.data.status) set.status = parsed.data.status;
  if (parsed.data.canPublish !== undefined) set.canPublish = parsed.data.canPublish;
  if (parsed.data.canAuthor !== undefined) set.canAuthor = parsed.data.canAuthor;
  if (parsed.data.authorVerified !== undefined) set.authorVerified = parsed.data.authorVerified;
  if (parsed.data.user_group !== undefined) set.userGroup = parsed.data.user_group;
  // 用户组就是权限包：共创 = 可投稿 + 可作者认证，朋友 = 两者都没有。
  // 只有调用方明确单独传了某个权限位时才尊重它，否则会出现「共创却不能投稿」这种半开状态。
  if (parsed.data.user_group === 'coauthor' || parsed.data.user_group === 'owner') {
    if (parsed.data.canPublish === undefined) set.canPublish = true;
    if (parsed.data.canAuthor === undefined) set.canAuthor = true;
  } else if (parsed.data.user_group === 'friend') {
    if (parsed.data.canPublish === undefined) set.canPublish = false;
    if (parsed.data.canAuthor === undefined) set.canAuthor = false;
  }
  if (parsed.data.handle !== undefined) {
    const raw = parsed.data.handle ?? '';
    const handle = canonHandle(raw);
    if (raw && !handle) fail(400, '作者标识只能用英文、数字和短横线');
    if (handle) {
      const clash = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.handle, handle), sql`${users.id} <> ${id}`))
        .limit(1);
      if (clash[0]) fail(409, `作者标识 ${handle} 已被其它账号占用`);
    }
    // 管理员清空 handle 等于把前台署名推回主题占位作者，所以清空时按注册信息重新推一个
    set.handle = handle || (user.role === 'admin' ? deriveHandle(user) : null);
  }
  /*
   * 管理员那一行的权限位与用户组永远亮着（口径见 services/admin-author.ts）。
   * 界面上这三个框对站长是置灰的，这里再兜一层：就算有人直接发 canPublish:false，
   * 也不会再出现「管理员未认证、用户组是朋友」这种半开状态 —— 线上这次就是这么坏的。
   */
  if (user.role === 'admin') {
    set.canPublish = true;
    set.canAuthor = true;
    set.authorVerified = true;
    set.userGroup = 'owner';
  }
  if (parsed.data.account_slug !== undefined) {
    if (parsed.data.account_slug === null) {
      set.accountSlug = null;
    } else {
      const slug = await uniqueAccountSlug(c.env, parsed.data.account_slug, id);
      set.accountSlug = slug;
    }
  }
  await db.update(users).set(set).where(eq(users.id, id));

  // 解封不需要重建会话；封禁必须把已登录的踢下去
  if (parsed.data.status === 'banned') await destroyUserSessions(c.env, id);

  await writeAudit(c.env, {
    actor: admin,
    action: 'user',
    target: id,
    detail: { email: user.email, from: { role: user.role, status: user.status }, to: parsed.data },
    ip: clientIp(c),
  });
  const after = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return ok({
    updated: true,
    account: after[0]
      ? {
          id: after[0].id,
          role: after[0].role,
          status: after[0].status,
          /** 库里的原值，回填表单用 */
          user_group: after[0].userGroup,
          /** 显示口径：管理员为 owner（站长） */
          userGroupView: userGroupView(after[0]),
          userGroupName: after[0].role === 'admin' ? '站长' : after[0].userGroup === 'coauthor' ? '共创' : '朋友',
          account_slug: after[0].accountSlug,
          handle: after[0].handle,
          can_publish: after[0].canPublish,
          can_author: after[0].canAuthor,
          author_verified: after[0].authorVerified,
        }
      : null,
  });
});

/** 单个用户的最近评论，后台点进去就能判断是不是误封 */
app.get('/:id/comments', async (c) => {
  requireAdmin(c);
  const db = createDb(c.env);
  const rows = await db
    .select()
    .from(comments)
    .where(and(eq(comments.authorType, 'user'), eq(comments.authorId, c.req.param('id'))))
    .orderBy(sql`created_at desc`)
    .limit(50);
  /* 与审核队列同一个口径：给标题，认不到留空由界面回落到地址 */
  const titles = await contentTitles(c.env, rows.map((r) => r.postSlug));
  return ok(rows.map((r) => ({ ...r, postTitle: titles.get(r.postSlug) ?? '' })));
});

/**
 * DELETE /api/admin/users/:id —— 级联删除该用户全部数据后再摘掉账号行（purgeUser）。
 * 与 /api/admin/deletions/:id/approve 的区别只有「没有注销申请」这一步：
 * 这里是站主主动清理（比如清理垃圾注册），那边是审核用户本人的申请。
 *
 * 管理员（站长）账号一律 403：后台不提供删站长的入口，注销也要走人工。
 */
app.delete('/:id', async (c) => {
  const admin = requireAdmin(c);
  const id = c.req.param('id');
  if (id === admin.id) fail(400, '不能删除自己的账号');

  const db = createDb(c.env);
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const user = rows[0];
  if (!user) fail(404, '用户不存在');
  if (user.role === 'admin') {
    fail(403, '管理员（站长）账号不能在后台删除。要交出站点请先由个人中心 /api/security/group 切换用户组，或手工处理数据库。');
  }

  const { deleted } = await purgeUser(c.env, id);
  await writeAudit(c.env, {
    actor: admin,
    action: 'user',
    target: id,
    detail: { event: 'user.purge', reason: '后台删除账号', email: user.email, accountSlug: user.accountSlug, deleted },
    ip: clientIp(c),
  });
  return ok({ id, deleted: true, removed: deleted });
});

/**
 * POST /api/admin/users/:id/reset-password —— 管理员一键重置某个账号的密码。
 * 明文只在这次响应里出现一次，库里只存哈希，同时吊销该账号全部会话：
 * 旧设备立刻掉线，拿着旧密码也进不来。
 */
app.post('/:id/reset-password', async (c) => {
  const admin = requireAdmin(c);
  const id = c.req.param('id');
  const db = createDb(c.env);
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  const user = rows[0];
  if (!user) fail(404, '用户不存在');
  // 管理员唯一，改自己的密码走「我的信息 → 修改密码」；这里挡住，
  // 免得一次误点把唯一的后台入口踢下线（明文只出现一次，关掉就找不回来了）
  if (user.role === 'admin') fail(400, '管理员账号的密码请在「我的信息」里修改，这里只处理普通账号');

  const password = randomPassword();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), updatedAt: Math.floor(Date.now() / 1000) })
    .where(eq(users.id, id));
  const sessionsKilled = await destroyUserSessions(c.env, id);

  await writeAudit(c.env, {
    actor: admin,
    action: 'user',
    target: id,
    detail: { event: 'user.reset-password', email: user.email, sessionsKilled },
    ip: clientIp(c),
  });

  return ok({
    id,
    email: user.email,
    password,
    sessionsKilled,
    message: '新密码只显示这一次，关掉弹窗就再也查不到；已同时踢掉该账号的全部登录会话。',
  });
});

export default app;
