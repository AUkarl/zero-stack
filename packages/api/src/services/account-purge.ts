/**
 * account-purge.ts — 账号注销的级联删除
 *
 * 只导出 purgeUser(env, userId)：把这个用户名下的数据清干净，但**不动别人的数据**，
 * 也不动 friends 表里已经收录的站点。返回每一类删掉了多少行，给后台与审计留痕用。
 *
 * 三条硬约束：
 *   1. 别人在我评论楼下的回复不跟着消失，改成往上一层挂。
 *   2. audits 保留但匿名化：actorId 置空、actorName 换成「已注销用户」、detail 抹掉，
 *      后台仍能回溯「什么时候发生过什么」，只是不再指向这个人。
 *   3. 别人指向这个账号的外键（审核人、创建人、第三方绑定人）一律置空，不删对方的行。
 *   4. 「本人数据」按两条口径认定：author_id 命中，或 author_email 命中（覆盖注册前用
 *      同一邮箱发的评论、评论者昵称档案与邮箱验证码）。
 *
 * 删掉 users 行后，D1 的 ON DELETE CASCADE 会把 account_deletions 那条申请一起带走，
 * 所以「注销」这件事本身的永久留痕是调用方写的那条 user.purge 审计。
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import {
  accountDeletions,
  accounts,
  auditLogs,
  authorRequests,
  broadcastJobs,
  commentLikes,
  commenters,
  comments,
  friendApplications,
  inviteCodes,
  postDrafts,
  reactions,
  sessions,
  subscribers,
  users,
  verifications,
} from '../db/schema';

export interface PurgeResult {
  deleted: Record<string, number>;
}

export async function purgeUser(env: Env, userId: string): Promise<PurgeResult> {
  const db = createDb(env);
  const deleted: Record<string, number> = {};
  const add = (key: string, n: number): void => {
    deleted[key] = (deleted[key] ?? 0) + n;
  };

  /** 先数再删：Drizzle 的 delete 不带受影响行数，注销这种低频操作多一次查询换可读性 */
  async function countOf(table: any, where: any): Promise<number> {
    const rows = await db.select({ n: sql<number>`count(*)` }).from(table).where(where);
    return Number(rows[0]?.n ?? 0);
  }

  /* ---------------- 邮箱先拿到：评论与验证码都要按邮箱再兜一遍口径 ---------------- */
  const emailRow = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  const email = emailRow[0]?.email;

  /* ---------------- 评论：先把别人在我楼下的回复往上挪一层 ---------------- */
  // 两条口径都算自己的评论：登录后发的（author_id）和注册前用同一邮箱发的（author_email）
  const commentConds = [and(eq(comments.authorType, 'user'), eq(comments.authorId, userId))];
  if (email) commentConds.push(eq(comments.authorEmail, email));
  const mine = await db
    .select({ id: comments.id, parentId: comments.parentId, rootId: comments.rootId, depth: comments.depth })
    .from(comments)
    .where(or(...commentConds));

  for (const row of mine) {
    await db
      .update(comments)
      .set({
        // 我的是顶层评论 → 回复也升为顶层；我的是楼中楼 → 回复挂到我的父评论下
        parentId: row.parentId ?? null,
        rootId: row.parentId ? row.rootId : null,
        depth: row.parentId ? row.depth : 1,
      })
      .where(eq(comments.parentId, row.id));
  }

  const myIds = mine.map((r) => r.id);
  add('comments', myIds.length);
  for (let i = 0; i < myIds.length; i += 100) {
    const slice = myIds.slice(i, i + 100);
    add('commentLikes', await countOf(commentLikes, inArray(commentLikes.commentId, slice)));
    await db.delete(commentLikes).where(inArray(commentLikes.commentId, slice));
    await db.delete(comments).where(inArray(comments.id, slice));
  }

  /* ---------------- 我点出去的赞与收藏 ---------------- */
  add('commentLikes', await countOf(commentLikes, eq(commentLikes.userId, userId)));
  await db.delete(commentLikes).where(eq(commentLikes.userId, userId));

  add('reactions', await countOf(reactions, eq(reactions.userId, userId)));
  await db.delete(reactions).where(eq(reactions.userId, userId));

  /* ---------------- 投稿与作者认证申请 ---------------- */
  add('postDrafts', await countOf(postDrafts, eq(postDrafts.userId, userId)));
  await db.delete(postDrafts).where(eq(postDrafts.userId, userId));

  add('authorRequests', await countOf(authorRequests, eq(authorRequests.userId, userId)));
  await db.delete(authorRequests).where(eq(authorRequests.userId, userId));

  /* ---------------- 友链申请：记录删掉，已收录的站点（friends）留着 ---------------- */
  add('friendApplications', await countOf(friendApplications, eq(friendApplications.userId, userId)));
  await db.delete(friendApplications).where(eq(friendApplications.userId, userId));

  /* ---------------- 会话与第三方绑定 ---------------- */
  add('sessions', await countOf(sessions, eq(sessions.userId, userId)));
  await db.delete(sessions).where(eq(sessions.userId, userId));

  add('accounts', await countOf(accounts, eq(accounts.userId, userId)));
  await db.delete(accounts).where(eq(accounts.userId, userId));

  /* ---------------- 邮箱订阅与验证码：按邮箱算，属于本人数据 ---------------- */
  if (email) {
    add('subscribers', await countOf(subscribers, eq(subscribers.email, email)));
    await db.delete(subscribers).where(eq(subscribers.email, email));
  }

  const verificationIds = [email, email ? `otp:${email}` : '', userId].filter(Boolean);
  add('verifications', await countOf(verifications, inArray(verifications.identifier, verificationIds)));
  await db.delete(verifications).where(inArray(verifications.identifier, verificationIds));

  /* ---------------- 一次性昵称/头像档案：本人用过的都算本人数据 ---------------- */
  const commenterCond = email ? or(eq(commenters.userId, userId), eq(commenters.email, email)) : eq(commenters.userId, userId);
  add('commenters', await countOf(commenters, commenterCond));
  await db.delete(commenters).where(commenterCond);

  /* ---------------- 指向这个账号的外键：置空，不删对方的行 ---------------- */
  await db.update(inviteCodes).set({ createdBy: null }).where(eq(inviteCodes.createdBy, userId));
  await db.update(broadcastJobs).set({ createdBy: null }).where(eq(broadcastJobs.createdBy, userId));
  await db.update(postDrafts).set({ reviewerId: null }).where(eq(postDrafts.reviewerId, userId));
  await db.update(authorRequests).set({ reviewerId: null }).where(eq(authorRequests.reviewerId, userId));
  await db.update(friendApplications).set({ reviewerId: null }).where(eq(friendApplications.reviewerId, userId));
  await db.update(accountDeletions).set({ reviewerId: null }).where(eq(accountDeletions.reviewerId, userId));

  /* ---------------- audits：保留但匿名化 ---------------- */
  add('auditLogsAnonymized', await countOf(auditLogs, eq(auditLogs.actorId, userId)));
  await db
    .update(auditLogs)
    .set({ actorId: null, actorName: '已注销用户', detail: JSON.stringify({ anonymized: true, reason: '账号注销' }) })
    .where(eq(auditLogs.actorId, userId));

  /* ---------------- 最后一刀：账号本身（invited_by 是先清的那根引用） ---------------- */
  await db.update(users).set({ invitedBy: null }).where(eq(users.id, userId));
  add('users', await countOf(users, eq(users.id, userId)));
  await db.delete(users).where(eq(users.id, userId));

  return { deleted };
}

/** 注销前给前台看一眼会删掉多少东西，用来做「二次确认」文案 */
export async function previewPurge(env: Env, userId: string): Promise<Record<string, number>> {
  const db = createDb(env);
  const one = async (table: any, where: any): Promise<number> => {
    const rows = await db.select({ n: sql<number>`count(*)` }).from(table).where(where);
    return Number(rows[0]?.n ?? 0);
  };
  const emailRow = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  const email = emailRow[0]?.email;
  // 口径与 purgeUser 保持一致：邮箱命中的评论/档案/验证码也算本人数据
  const commentCond = email
    ? or(and(eq(comments.authorType, 'user'), eq(comments.authorId, userId)), eq(comments.authorEmail, email))
    : and(eq(comments.authorType, 'user'), eq(comments.authorId, userId));
  const commenterCond = email ? or(eq(commenters.userId, userId), eq(commenters.email, email)) : eq(commenters.userId, userId);
  const verificationIds = [email, email ? `otp:${email}` : '', userId].filter(Boolean);
  return {
    comments: await one(comments, commentCond),
    commentLikes: await one(commentLikes, eq(commentLikes.userId, userId)),
    reactions: await one(reactions, eq(reactions.userId, userId)),
    commenters: await one(commenters, commenterCond),
    postDrafts: await one(postDrafts, eq(postDrafts.userId, userId)),
    authorRequests: await one(authorRequests, eq(authorRequests.userId, userId)),
    friendApplications: await one(friendApplications, eq(friendApplications.userId, userId)),
    sessions: await one(sessions, eq(sessions.userId, userId)),
    accounts: await one(accounts, eq(accounts.userId, userId)),
    subscribers: email ? await one(subscribers, eq(subscribers.email, email)) : 0,
    verifications: await one(verifications, inArray(verifications.identifier, verificationIds)),
  };
}
