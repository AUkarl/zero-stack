/**
 * comment-notify.ts — 新评论的三封邮件提醒
 *
 *   commentNotifyAdmin  → 提醒站长（收件人取 emailFrom）
 *   commentNotifyReply  → 回复了某条评论时，通知那条评论的作者
 *   commentNotifyAuthor → 文章被评论时，通知那篇文章的作者（共创投稿走 post_drafts 认领）
 *
 * 正文一律用 emailTemplateComment 渲染（{author} {where} {content} {url} {title} {siteName}），
 * 发送走 queueEmail：队列不可用时它自己退化成直发，任何失败都只写日志，
 * 绝不因为「通知没发出去」让用户的评论失败。
 */

import { and, eq, like, or } from 'drizzle-orm';
import { createDb } from '../db/client';
import { postDrafts, users } from '../db/schema';
import { canonSlug } from '../lib/slug';
import { siteAuthorName } from './authors';
import { getConfig, getConfigBool } from './config';
import { queueEmail, renderEmail } from './email';

export interface NotifyComment {
  id: string;
  content: string;
  authorName: string;
  authorEmail: string | null;
  /** 登录账号 id，匿名评论为 null */
  authorId: string | null;
  /** 已通过的评论才提醒作者与回复对象；待审核的只提醒站长（他得去处理） */
  status: string;
}

export interface NotifyParent {
  authorName: string;
  authorEmail: string | null;
  authorId: string | null;
}

export interface NotifyInput {
  env: Env;
  /** canonSlug 之后的文章路径 */
  slug: string;
  comment: NotifyComment;
  /** 被回复的那条评论；不是回复就传 null */
  parent?: NotifyParent | null;
  /** 文章标题，调用方没有就留空，这里按 slug 兜底 */
  title?: string | null;
}

interface Recipient {
  to: string;
  where: string;
  subject: string;
  /** 邮件称呼「亲爱的 X」；留空写「朋友」 */
  nickname?: string;
}

/** 站点绝对地址：优先后台配置，其次 wrangler var，最后请求 origin（这里拿不到请求，兜个空） */
async function siteBase(env: Env): Promise<string> {
  const configured = await getConfig(env, 'siteUrl');
  const raw = configured || env.SITE_URL || '';
  return raw.replace(/\/+$/, '');
}

function lastSegment(slug: string): string {
  const parts = slug.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : slug;
}

/** 标题兜底：草稿里有就用，没有就把 slug 末段人类可读化 */
function prettyTitle(slug: string, known?: string | null): string {
  if (known && known.trim()) return known.trim();
  const seg = decodeURIComponent(lastSegment(slug));
  const cleaned = seg.replace(/\.(md|html)$/i, '').replace(/[-_]+/g, ' ').trim();
  return cleaned || '这篇文章';
}

/** 按 post_drafts 认领文章作者：共创投稿的文章才有记录，站长的文章没有 */
async function findPostAuthor(env: Env, slug: string): Promise<{ email: string; title: string } | null> {
  const seg = lastSegment(slug);
  if (!seg) return null;
  try {
    const db = createDb(env);
    const rows = await db
      .select({
        title: postDrafts.title,
        userId: postDrafts.userId,
        email: users.email,
      })
      .from(postDrafts)
      .innerJoin(users, eq(users.id, postDrafts.userId))
      .where(
        and(
          eq(postDrafts.status, 'approved'),
          or(eq(postDrafts.slug, seg), like(postDrafts.publishedPath, `%${seg}%`)),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.email) return null;
    return { email: row.email, title: row.title };
  } catch (err) {
    console.warn('[zero-api] 查询文章作者失败', err);
    return null;
  }
}

async function emailOfAuthor(env: Env, author: NotifyParent): Promise<string> {
  if (author.authorId) {
    try {
      const db = createDb(env);
      const rows = await db.select({ email: users.email }).from(users).where(eq(users.id, author.authorId)).limit(1);
      const email = rows[0]?.email;
      if (email) return email;
    } catch (err) {
      console.warn('[zero-api] 查询被回复者邮箱失败', err);
    }
  }
  return author.authorEmail?.trim() ?? '';
}

/**
 * 入口：评论落库之后调用。整体 try/catch，永不抛出。
 * 收件人去重（同一个人别收两封），自己的评论不通知自己。
 */
export async function notifyNewComment(input: NotifyInput): Promise<void> {
  const { env, slug, comment, parent } = input;
  try {
    const siteName = (await getConfig(env, 'siteName')) ?? '';
    const adminEmail = (await getConfig(env, 'emailFrom'))?.trim() ?? '';
    const articleTitle = prettyTitle(slug, input.title);
    const url = `${await siteBase(env)}${canonSlug(slug)}`;

    const recipients: Recipient[] = [];
    const push = (r: Recipient) => {
      const to = r.to.toLowerCase();
      if (!to || recipients.some((x) => x.to.toLowerCase() === to)) return;
      recipients.push({ ...r, to });
    };

    // 1) 站长：待审核的也要提醒，不然评论卡在队列里没人看
    if (adminEmail && (await getConfigBool(env, 'commentNotifyAdmin', true))) {
      const ownerName = await siteAuthorName(env);
      push({ to: adminEmail, where: `文章「${articleTitle}」`, subject: `【${siteName}】新评论待处理`, nickname: ownerName });
    }

    const visible = comment.status === 'approved';

    // 2) 被回复的人：登录的按账号邮箱，匿名的按 author_email
    if (visible && parent && (await getConfigBool(env, 'commentNotifyReply', true))) {
      const isSelfReply =
        (Boolean(comment.authorId) && parent.authorId === comment.authorId) ||
        (Boolean(comment.authorEmail) &&
          parent.authorEmail?.toLowerCase() === comment.authorEmail?.trim().toLowerCase());
      if (!isSelfReply) {
        const to = await emailOfAuthor(env, parent);
        if (to)
          push({
            to,
            where: `文章「${articleTitle}」的评论下`,
            subject: `【${siteName}】${comment.authorName} 回复了你的评论`,
            nickname: parent.authorName ?? '',
          });
      }
    }

    // 3) 被评论文章的作者：目前只有共创投稿（post_drafts）能认到作者，
    //    站长自己的文章认不到——那封已经由 commentNotifyAdmin 覆盖了。
    if (visible && (await getConfigBool(env, 'commentNotifyAuthor', true))) {
      const author = await findPostAuthor(env, slug);
      if (author) {
        const isSelf =
          (Boolean(comment.authorId) && (await sameAccount(env, comment.authorId, author.email))) ||
          (Boolean(comment.authorEmail) &&
            comment.authorEmail?.trim().toLowerCase() === author.email.toLowerCase());
        if (!isSelf) {
          push({
            to: author.email,
            where: `你的文章「${author.title || articleTitle}」`,
            subject: `【${siteName}】有人评论了你的文章`,
          });
        }
      }
    }

    if (!recipients.length) return;

    for (const r of recipients) {
      // {where} 每封不同，逐收件人各渲染一次最省心
      const html = await renderEmail(
        env,
        'comment',
        {
          author: comment.authorName || '匿名',
          where: r.where,
          content: comment.content,
          url,
          title: articleTitle,
          siteName,
        },
        { title: r.subject, nickname: r.nickname },
      );
      await queueEmail(env, {
        to: r.to,
        subject: r.subject,
        html,
        from: adminEmail || undefined,
        kind: 'notice',
        postId: slug,
      });
    }
  } catch (err) {
    console.warn('[zero-api] 评论邮件提醒失败（不影响评论）', err);
  }
}

async function sameAccount(env: Env, userId: string | null, email: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const db = createDb(env);
    const rows = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.email, email))).limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}
