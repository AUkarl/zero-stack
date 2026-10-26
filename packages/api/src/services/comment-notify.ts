/**
 * comment-notify.ts — 新评论的三封邮件提醒
 *
 *   commentNotifyAdmin  → 提醒站长（收件人取 adminNotifyEmail，没填回落 emailFrom）
 *   commentNotifyReply  → 回复了某条评论时，通知那条评论的作者
 *   commentNotifyAuthor → 文章被评论时，通知那篇文章的作者（共创投稿走 post_drafts 认领）
 *
 * 三条都**不通知评论者自己**：自己回复自己不发②，自己评论自己的共创文章不发③，
 * 而①以前是唯一漏的那条 —— 站长（大多数站就是站主本人）每次发言都会给自己发一封「新评论待处理」，
 * 待审核的那条也算。现在评论者是管理员账号、或评论者邮箱正好就是①那个收件地址时跳过①：
 * 站主自己的发言只需要他自己知道，而别人评论他的文章照旧会通知他。
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
import { kvDelete, kvGet, kvPut } from './kv-cache';
import { resolveSiteName } from './site-name';
import { queueEmail, renderEmail, sendEmail } from './email';
import { commentEmailHtml } from './email-content';
import { postsDir, readRepoFileQuiet, titleFromMarkdown, webUrlForSlug } from './frontmatter';

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
    const siteName = await resolveSiteName(env);
    const fromMail = (await getConfig(env, 'emailFrom'))?.trim() ?? '';
    /**
     * 站长那一封的收件人：以前硬用 emailFrom，于是「发给站长」的邮件其实是发给发件邮箱自己，
     * 站主换邮箱收提醒就只能改发件地址（而发件地址还牵着 SMTP 登录名，不能乱改）。
     * 现在先取「设置 → 评论提醒与展示 → 站长收件邮箱」，没填才回落到发件邮箱 —— 大多数站两者本来就是同一个。
     */
    const adminEmail = (await getConfig(env, 'adminNotifyEmail'))?.trim() || fromMail;
    const articleTitle = prettyTitle(slug, input.title || (await postTitleFromRepo(env, slug)));
    const base = await siteBase(env);
    const url = `${base}${webUrlForSlug(canonSlug(slug))}`;

    const recipients: Recipient[] = [];
    const push = (r: Recipient) => {
      const to = r.to.toLowerCase();
      if (!to || recipients.some((x) => x.to.toLowerCase() === to)) return;
      recipients.push({ ...r, to });
    };

    // 1) 站长：待审核的也要提醒，不然评论卡在队列里没人看。
    //    但「站长自己发的评论」不该再提醒站长自己 —— 台架实测过：以前站主每发一条评论就给自己来一封。
    if (adminEmail && (await getConfigBool(env, 'commentNotifyAdmin', true))) {
      const who = await commenterIdentity(env, comment);
      const notifyingHimself = who.isAdmin || who.emails.has(adminEmail.trim().toLowerCase());
      if (!notifyingHimself) {
        const ownerName = await siteAuthorName(env);
        push({ to: adminEmail, where: `文章「${articleTitle}」`, subject: `【${siteName}】新评论待处理`, nickname: ownerName });
      }
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
          /* 表情与图片按前台那套渲染成 <img>，信里不再是 [weibo:smile] 这种字面标记 */
          content: commentEmailHtml(comment.content, base),
          url,
          title: articleTitle,
          siteName,
        },
        { title: r.subject, nickname: r.nickname, rawKeys: ['content'] },
      );
      await queueEmail(env, {
        to: r.to,
        subject: r.subject,
        html,
        from: fromMail || undefined,
        kind: 'notice',
        postId: slug,
      });
    }
  } catch (err) {
    console.warn('[zero-api] 评论邮件提醒失败（不影响评论）', err);
  }
}

/**
 * 文章的真标题：读仓库里那一篇的 front matter。
 *
 * 以前调用方没传标题时，`prettyTitle` 直接拿 slug 末段顶上 —— 站主的文章文件名就是日期串
 * （`content/zh/posts/20261025002.md`），于是一封提醒信里两处都写成「20261025002」，
 * 收件人根本不知道是哪篇被评论了。
 *
 * 结果按文章号缓存一天：标题几乎不变，而每条新评论都去仓库读一个文件不划算
 * （GitHub 那侧是一次 Contents API 调用）。没配仓库 / 文件名与 slug 不一致（front matter 另写了 slug）
 * 时照旧回落到文件名，不会比现在更差；认不到也短暂记一笔，免得无主评论反复打仓库。
 */
async function postTitleFromRepo(env: Env, slug: string): Promise<string> {
  const seg = lastSegment(slug);
  if (!seg) return '';
  const key = postTitleCacheKey(seg);
  const cached = await kvGet(env, key);
  if (typeof cached === 'string') return cached;
  const dir = await postsDir(env);
  let title = '';
  for (const p of [`${dir}/${seg}.md`, `${dir}/${seg}/index.md`]) {
    const file = await readRepoFileQuiet(env, p);
    if (!file?.content) continue;
    title = titleFromMarkdown(file.content);
    if (title) break;
  }
  await kvPut(env, key, title, title ? 24 * 3600 : 600);
  return title;
}

/** 标题缓存的键只在这一处拼：写入侧要清的是同一格，手抄一份字符串迟早和这边不一致。 */
export function postTitleCacheKey(stem: string): string {
  return `zero:post-title:${stem}`;
}

/**
 * 改了/删了哪几篇文章 → 清掉这几篇的标题缓存。
 * 加缓存就得配清缓存：后台把标题改了，提醒信不能还写着旧标题等 24 小时。
 * 只有文章目录里的 .md 才有这一格（数据文件、友链那些不用管）；bundle 形态认 index.md 的上一层。
 */
export async function purgePostTitleCache(env: Env, paths: string[]): Promise<void> {
  const dir = await postsDir(env);
  for (const raw of paths) {
    const rel = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel.startsWith(`${dir}/`) || !rel.endsWith('.md')) continue;
    const segs = rel.slice(dir.length + 1).split('/');
    const file = segs.pop() ?? '';
    const stem = file === 'index.md' ? (segs.pop() ?? '') : file.slice(0, -3);
    if (stem) await kvDelete(env, postTitleCacheKey(stem));
  }
}

/**
 * 评论者"自己"是哪几个地址、是不是管理员账号。
 * 匿名评论只有填的邮箱；登录评论以账号邮箱为准（他填的可能是别人的），两个都收进集合里比。
 */
async function commenterIdentity(env: Env, comment: NotifyComment): Promise<{ emails: Set<string>; isAdmin: boolean }> {
  const emails = new Set<string>();
  const filled = comment.authorEmail?.trim().toLowerCase();
  if (filled) emails.add(filled);
  let isAdmin = false;
  if (comment.authorId) {
    try {
      const db = createDb(env);
      const rows = await db
        .select({ email: users.email, role: users.role })
        .from(users)
        .where(eq(users.id, comment.authorId))
        .limit(1);
      const u = rows[0];
      if (u?.email) emails.add(u.email.trim().toLowerCase());
      isAdmin = u?.role === 'admin';
    } catch (err) {
      console.warn('[zero-api] 查询评论者身份失败', err);
    }
  }
  return { emails, isAdmin };
}

async function sameAccount(env: Env, userId: string | null, email: string): Promise<boolean> {  if (!userId) return false;
  try {
    const db = createDb(env);
    const rows = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.email, email))).limit(1);
    return rows.length > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 通知链路自检 */

export interface NotifySelfTestRow {
  /** 这一封在链路里扮演谁 */
  label: string;
  to: string;
  subject: string;
  sent: boolean;
  error: string | null;
  /** 发信服务器的原文回执 */
  detail: string | null;
  /** 这一封在「发信记录」里那一行的 id，两边可以逐条对上 */
  logId: string | null;
}

export interface NotifySelfTest {
  provider: string;
  smtp: string;
  from: string;
  adminEmail: string;
  adminEmailSource: 'adminNotifyEmail' | 'emailFrom（没单独填站长收件邮箱）' | '（两处都没填）';
  siteUrl: string;
  toggles: { commentNotifyAdmin: boolean; commentNotifyReply: boolean; commentNotifyAuthor: boolean };
  rows: NotifySelfTestRow[];
  note: string;
}

/**
 * 后台「通知链路自检」：按 notifyNewComment 真正用的那套配置与模板各发一封，
 * 并把 SMTP / 服务商的原文回执、实际算出来的收件人摊开给站主看。
 *
 * 为什么不走队列：这里要的是「当场知道结果」，队列是异步的，点完按钮只看到已入队，
 * 反而更迷惑。sendEmail 与队列消费者用的是同一个发送层，通道一致性不受影响。
 */
export async function notifySelfTest(env: Env, to: string): Promise<NotifySelfTest> {
  const siteName = (await getConfig(env, 'siteName')) ?? '';
  const fromMail = (await getConfig(env, 'emailFrom'))?.trim() ?? '';
  const configuredAdmin = (await getConfig(env, 'adminNotifyEmail'))?.trim() ?? '';
  const adminEmail = configuredAdmin || fromMail;
  const base = await siteBase(env);
  const ownerName = await siteAuthorName(env);
  const sample =
    '这是一封由后台「通知链路自检」发出的样例信，用来确认新评论提醒的通道、模板与收件人。' +
    `发信时间是 ${new Date().toISOString()}。收到它就说明这条链路是通的。`;

  const send = async (label: string, recipient: string, subject: string, nickname: string, where: string): Promise<NotifySelfTestRow> => {
    const html = await renderEmail(
      env,
      'comment',
      { author: '测试用户', where, content: sample, url: `${base}/`, title: '通知链路自检', siteName },
      { title: subject, nickname, rawKeys: ['content'] },
    );
    const res = await sendEmail(env, { to: recipient, subject, html, from: fromMail || undefined, kind: 'notice' });
    return { label, to: recipient, subject, sent: res.success, error: res.error ?? null, detail: res.detail ?? null, logId: res.logId ?? null };
  };

  // 第 1 封：站长期待收到的「新评论待处理」
  const toAdmin = adminEmail || to;
  const rows: NotifySelfTestRow[] = [];
  rows.push(
    await send(
      '站长那一封（commentNotifyAdmin）',
      toAdmin,
      `【${siteName}】新评论待处理`,
      ownerName || '站长',
      '文章「通知链路自检」',
    ),
  );
  // 第 2 封：用户那封（回复提醒）
  rows.push(
    await send(
      '用户那一封（commentNotifyReply）',
      to,
      `【${siteName}】测试用户 回复了你的评论`,
      to,
      '文章「通知链路自检」的评论下',
    ),
  );

  return {
    provider: (await getConfig(env, 'emailProvider')) ?? 'smtp',
    smtp: `${(await getConfig(env, 'smtpHost')) || '（未填）'}:${(await getConfig(env, 'smtpPort')) || '（未填）'}`,
    from: fromMail || '（未填 emailFrom）',
    adminEmail: adminEmail || '（空）',
    adminEmailSource: configuredAdmin ? 'adminNotifyEmail' : fromMail ? 'emailFrom（没单独填站长收件邮箱）' : '（两处都没填）',
    siteUrl: base || '（未配置 siteUrl，信里的链接会只剩路径）',
    toggles: {
      commentNotifyAdmin: await getConfigBool(env, 'commentNotifyAdmin', true),
      commentNotifyReply: await getConfigBool(env, 'commentNotifyReply', true),
      commentNotifyAuthor: await getConfigBool(env, 'commentNotifyAuthor', true),
    },
    rows,
    note:
      'sent = 中继已经收下这封信（SMTP 回 250）。250 不等于投进对方收件箱：' +
      '地址不存在、被判为垃圾、服务商限流都照样回 250。两封都 sent 却邮箱里没有，就查发信邮箱服务商的投递日志与垃圾箱。',
  };
}
