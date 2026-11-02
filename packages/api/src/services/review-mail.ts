/**
 * review-mail.ts — 审核结果邮件
 *
 * 后台点「通过 / 驳回」时，除了改库还要给申请人一封信：友链申请发到他填的 email，
 * 投稿发到他账号邮箱。两封信都走 queueEmail（队列不可用时它自己退化成直发），
 * 任何失败都只回一个 notifyError，绝不因为「邮件没发出去」把审核结论回滚掉。
 *
 * 审核结果这类系统信统一走后台「邮件模板 → 其它通知」（配置键 emailTemplateNotice）：
 * 各流程只负责拼好正文并按 {content} 原样塞进去，外壳（站点名 / Logo / 称呼 / 落款）
 * 由模板层统一给，几封长得一样、中文也不乱码。
 */

import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import { users } from '../db/schema';
import { getConfig } from './config';
import { postWebPath } from './frontmatter';
import { queueEmail, renderEmail } from './email';

/**
 * 一封信的三种结局：
 *   sent   —— 已交给 SMTP/服务商（还不等于进了收件箱，但中继已收下）
 *   queued —— 只排进了发送队列，消费者还没投（群发与通知走队列时就是这个状态）
 *   failed —— 没邮箱、被拒、抛异常
 * 以前只有布尔值 notified，队列在跑还是失败界面分不出来，驳回那封信明明进了
 * email_logs 的 failed 行，接口却回「已发送邮件通知」。
 */
export type NotifyState = 'sent' | 'queued' | 'failed';
export interface NotifyOutcome {
  state: NotifyState;
  notifyError?: string;
}

/** 友链申请：只取邮件需要的字段，路由那边的行对象直接传进来 */
export interface FriendAppLike {
  id: string;
  name: string;
  url: string;
  /** 申请人留的联系邮箱，没填就发不出去 */
  email?: string | null;
  reviewNote?: string | null;
}

/** 投稿：正文与 slug 不在信里出现，只说结论 */
export interface DraftLike {
  id: string;
  userId: string;
  title: string;
  slug?: string;
  /** 整行传进来时会有，撤回驳回要用它判断措辞 */
  status?: string;
  reviewNote?: string | null;
  publishedPath?: string | null;
}

function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}

/** 段落级正文：note 可能是管理员随手打的中文，转义后包 <p> */
function paragraph(...lines: string[]): string {
  return lines.filter((l) => l.trim()).map((l) => `<p>${l}</p>`).join('');
}

async function siteName(env: Env): Promise<string> {
  return (await getConfig(env, 'siteName')) ?? '本站';
}

/** 站点首页链接，收件人顺着回来看结果 */
async function siteHome(env: Env): Promise<string> {
  return ((await getConfig(env, 'siteUrl')) ?? env.SITE_URL ?? '').replace(/\/+$/, '');
}

/**
 * 统一收口：没邮箱算失败，但不抛异常。
 * body 是各流程自己拼好的 HTML 段落（已经逐段转义过），所以按 rawKeys 里的 {content} 原样插入；
 * 外壳与称呼来自后台「邮件模板 → 其它通知」，改文案不必发版。
 */
async function notifyOne(
  env: Env,
  to: string,
  subject: string,
  body: string,
  /** 没有地址就别给按钮：空 url 会让信里出现一枚看不见字的灰块，点了还什么也不发生 */
  url = '',
  actionLabel = '回到站点查看',
): Promise<NotifyOutcome> {
  const address = to.trim();
  if (!address) return { state: 'failed', notifyError: '没有可用的收件邮箱' };
  const site = await siteName(env);
  const from = (await getConfig(env, 'emailFrom'))?.trim() ?? '';
  const html = await renderEmail(
    env,
    'notice',
    { intro: subject, content: body, title: subject, url, action: url ? actionLabel : '' },
    { title: subject, rawKeys: ['content'] },
  );
  try {
    const res = await queueEmail(env, {
      to: address,
      subject: `【${site}】${subject}`,
      html,
      from: from || undefined,
      kind: 'notice',
    });
    if (!res.success) return { state: 'failed', notifyError: res.error ?? '邮件发送失败' };
    return { state: res.queued ? 'queued' : 'sent' };
  } catch (e) {
    return { state: 'failed', notifyError: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 友链申请审核结果。
 * approved=true 告知已收录并给出友链页地址；false 时把驳回理由原样带进信里。
 */
export async function sendFriendReviewResult(env: Env, app: FriendAppLike, approved: boolean, note?: string): Promise<NotifyOutcome> {
  const home = await siteHome(env);
  const reason = (note ?? app.reviewNote ?? '').trim();
  const links = home ? `<p><a href="${escapeHtml(home)}">${escapeHtml(home)}</a></p>` : '';
  const body = approved
    ? paragraph(
        `你为「${escapeHtml(app.name)}〈${escapeHtml(app.url)}〉」提交的友链申请已通过审核。`,
        '稍后站点重建完成，就会出现在友链页上。',
        links,
      )
    : paragraph(
        `很遗憾，你为「${escapeHtml(app.name)}〈${escapeHtml(app.url)}〉」提交的友链申请没有通过审核。`,
        reason ? `站主说明：${escapeHtml(reason)}` : '站主没有留下具体理由，欢迎修改后重新提交。',
        links,
      );
  /* 按钮要落到具体页面：友链页能看到自己是否已上架，比只给一个首页有用得多 */
  return notifyOne(
    env,
    app.email ?? '',
    approved ? '友链申请已通过' : '友链申请未通过',
    body,
    home ? `${home}/links/` : '',
    approved ? '去友链页看看' : '回本站看看',
  );
}

/**
 * 投稿审核结果：收件人取账号邮箱。
 * approved=true 说明已发布（或未发布但已通过），false 时带上驳回理由。
 * 撤回申请（status = withdraw_requested）走另一套措辞：那时「通过」意味着文章被删掉，
 * 不是稿件被认可，别把作者说糊涂。
 */
export async function sendDraftReviewResult(env: Env, draft: DraftLike, approved: boolean, note?: string): Promise<NotifyOutcome> {
  const db = createDb(env);
  let email = '';
  try {
    const rows = await db.select({ email: users.email }).from(users).where(eq(users.id, draft.userId)).limit(1);
    email = rows[0]?.email ?? '';
  } catch (e) {
    return { state: 'failed', notifyError: `查不到作者邮箱：${e instanceof Error ? e.message : String(e)}` };
  }

  const home = await siteHome(env);
  const reason = (note ?? draft.reviewNote ?? '').trim();
  const isWithdraw = draft.status === 'withdraw_requested';
  let subject = approved ? '投稿已通过审核' : '投稿未通过审核';
  let body: string;

  if (isWithdraw) {
    subject = approved ? '撤回申请已同意' : '撤回申请未通过';
    body = approved
      ? paragraph(
          `你的撤回申请已通过，文章《${escapeHtml(draft.title)}》已从站点移除，稍后重建完成后就不再可访问。`,
          reason ? `站主说明：${escapeHtml(reason)}` : '',
        )
      : paragraph(
          `你的撤回申请没有通过，文章《${escapeHtml(draft.title)}》继续留在站点上。`,
          reason ? `站主说明：${escapeHtml(reason)}` : '站主没有留下具体理由，如需撤回可以再和站主说明情况。',
        );
  } else if (approved) {
    const published = Boolean(draft.publishedPath);
    body = paragraph(
      `你的投稿《${escapeHtml(draft.title)}》已通过审核。`,
      published ? '已经发布到站点，重建完成后即可访问。' : '站主会尽快把它发布到站点上，无需重新投稿。',
      reason ? `站主附言：${escapeHtml(reason)}` : '',
      published && home ? `<p>站点首页：<a href="${escapeHtml(home)}">${escapeHtml(home)}</a></p>` : '',
    );
  } else {
    body = paragraph(
      `你的投稿《${escapeHtml(draft.title)}》没有通过审核。`,
      reason ? `站主说明：${escapeHtml(reason)}` : '站主没有留下具体理由，可以在用户中心修改后再次提交。',
    );
  }

  /* 已经发布出去的投稿才给按钮（指向那篇文章）；没发布的给个首页链接只会让人以为文章上线了 */
  const web = draft.publishedPath ? postWebPath(String(draft.publishedPath)) : '';
  return notifyOne(
    env,
    email,
    subject,
    body,
    home && web ? `${home}${web.startsWith('/') ? web : `/${web}`}` : '',
    home && web ? '去读这篇文章' : '',
  );
}
