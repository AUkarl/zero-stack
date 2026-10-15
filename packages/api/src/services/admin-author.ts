/**
 * 站长（站内唯一的 role='admin' 账号）的作者身份与权限。
 *
 * 后台那三个权限位（可投稿 / 可作者认证 / 已认证作者）是「站长给别人授权」用的开关，
 * 站长自己不该被它们管着：管理员默认就是认证作者、默认拥有全部权限。
 *
 * 为什么需要一个专门的模块：这三处在代码里各读各的位，早期串成了一个死循环 ——
 *   ① 首个账号注册时只写了 role='admin'，handle 与三个位全是 schema 默认值（空 / false）；
 *   ② 「用户」页把 admin 过滤掉了（where role <> 'admin'），所以站长那一行根本看不见；
 *   ③ 「我的信息 → 站长作者资料」保存时要求已有 handle，没有就报「先到『用户』页补一个」；
 *   于是 handle 永远补不上，/api/authors 按 handle 匹配也永远匹配不到，
 *   前台署名就一直落在主题自带的占位作者上。
 * 现在：读的地方一律过 withAdminAuthorBits（admin 恒真），写的地方一律走
 * ensureAdminAuthorIdentity（幂等补齐），两头都不再依赖「有人记得去勾」。
 */

import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import { users } from '../db/schema';
import { canonHandle } from '../lib/slug';

/** 参与判定的最小字段集合；users 表整行传进来即可 */
export interface Authorish {
  role?: string | null;
  handle?: string | null;
  accountSlug?: string | null;
  name?: string | null;
  email?: string | null;
  canPublish?: boolean | null;
  canAuthor?: boolean | null;
  authorVerified?: boolean | null;
  userGroup?: string | null;
}

export function isAdminRow(row: Authorish | null | undefined): boolean {
  return row?.role === 'admin';
}

/**
 * 作者标识：注册信息里挑第一个还能用的 ASCII 片段。
 * 顺序是 handle → account_slug → name → 邮箱前缀，都过一遍 canonHandle（只留小写字母数字和短横线）。
 * account_slug 排在前面，是为了让 /author/<标识>/ 与 /account/@<账号标识>/ 两个地址一致。
 */
export function deriveHandle(row: Authorish | null | undefined): string {
  if (!row) return '';
  const explicit = canonHandle(String(row.handle ?? ''));
  if (explicit) return explicit;
  for (const candidate of [row.accountSlug, row.name, String(row.email ?? '').split('@')[0]]) {
    const h = canonHandle(String(candidate ?? ''));
    if (h) return h;
  }
  return 'admin';
}

/** 纯函数：把管理员的权限位与用户组读成「全亮 + 站长」，其它账号原样返回 */
export function withAdminAuthorBits<T extends Authorish>(row: T): T {
  if (row?.role !== 'admin') return row;
  return {
    ...row,
    handle: row.handle || deriveHandle(row),
    canPublish: true,
    canAuthor: true,
    authorVerified: true,
    userGroup: 'owner',
  };
}

/** 三处后台/前台都在渲染这个标签，统一从这里出，别再各自写一遍三元 */
export function userGroupName(row: Authorish | null | undefined): string {
  if (row?.role === 'admin') return '站长';
  return row?.userGroup === 'coauthor' ? '共创' : '朋友';
}

export interface IdentityRepair {
  /** 这次真的写了库（handle 或某个位原来是不对的） */
  changed: boolean;
  handle: string;
  /** handle 与别人的撞了，没敢写进去 */
  clash: boolean;
}

/**
 * 幂等补齐站长那一行：handle 缺就按注册信息推一个，三个位与用户组强制成全亮 + 站长。
 * 只在值真的不对时写库，所以可以放在注册后、登录时与「我的信息」读取时反复调用。
 * handle 撞车（别的账号已经占用）时不写 handle，其它三项照旧补齐，
 * 并把 clash 报给调用方 —— 这种情况下前端会提示去「用户」页改标识。
 */
export async function ensureAdminAuthorIdentity(env: Env, userId: string): Promise<IdentityRepair> {
  const db = createDb(env);
  const rows = await db
    .select({
      handle: users.handle,
      accountSlug: users.accountSlug,
      name: users.name,
      email: users.email,
      role: users.role,
      canPublish: users.canPublish,
      canAuthor: users.canAuthor,
      authorVerified: users.authorVerified,
      userGroup: users.userGroup,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row || row.role !== 'admin') return { changed: false, handle: row?.handle ?? '', clash: false };

  const wanted = deriveHandle(row);
  let handle = canonHandle(String(row.handle ?? '')) || '';
  let clash = false;
  if (!handle) {
    const taken = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.handle, wanted))
      .limit(1);
    if (taken.length && taken[0].id !== userId) clash = true;
    else handle = wanted;
  }

  const needHandle = Boolean(handle) && handle !== (row.handle ?? '');
  const needBits = !row.canPublish || !row.canAuthor || !row.authorVerified || row.userGroup !== 'owner';
  if (!needHandle && !needBits) return { changed: false, handle: handle || deriveHandle(row), clash };

  if (needHandle || needBits) {
    await db
      .update(users)
      .set({
        ...(handle ? { handle } : {}),
        canPublish: true,
        canAuthor: true,
        authorVerified: true,
        userGroup: 'owner',
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(eq(users.id, userId));
  }
  return { changed: true, handle: handle || deriveHandle(row), clash };
}
