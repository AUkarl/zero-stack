/**
 * 新文章邮件推送：读站点自己的 RSS，找出上次推送之后发布的条目，
 * 给已确认的订阅者各发一封汇总邮件。
 *
 * 为什么走 RSS 而不是直接读仓库：文章是 Hugo 构建出来的，
 * RSS 已经是「构建成功且公开可见」的那一份，推送的内容不会比站点还新。
 */

import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import { subscribers } from '../db/schema';
import { getConfig, getConfigBool } from './config';
import { mailQuotaCheck, queueEmail, renderEmail } from './email';
import { cleanSummary } from './feed-summary';

const STATE_KEY = 'zero:subscribe-push:last';

interface FeedItem {
  title: string;
  link: string;
  pubDate: string;
  summary: string;
}

interface PushState {
  link: string;
  date: string;
  pushedAt: number;
}

export interface PushOutcome {
  ran: boolean;
  reason: string;
  newPosts: string[];
  recipients: number;
  queued: number;
  baseline: boolean;
}

export async function pushNewPostsToSubscribers(env: Env, opts: { reset?: boolean } = {}): Promise<PushOutcome> {
  const skip = (reason: string): PushOutcome => ({ ran: false, reason, newPosts: [], recipients: 0, queued: 0, baseline: false });

  if (!(await getConfigBool(env, 'subscribePushEnabled', true))) return skip('推送开关（subscribePushEnabled）已关闭');
  if (!env.SESSION) return skip('未绑定 KV 命名空间，推送状态无处存放');

  const feedUrl = await resolveFeedUrl(env);
  if (!feedUrl) return skip('站点地址未配置，无法定位 RSS');

  let items: FeedItem[];
  try {
    items = await fetchFeed(feedUrl);
  } catch (e) {
    return skip(`RSS 读取失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!items.length) return skip(`RSS 里没有条目（${feedUrl}）`);

  const previous = opts.reset ? null : await readState(env);
  if (!previous) {
    // 首次运行只记基线，不然一上来就把整个存档群发一遍
    await writeState(env, { link: items[0]!.link, date: items[0]!.pubDate, pushedAt: Math.floor(Date.now() / 1000) });
    return { ran: true, reason: `已记录基线：${items[0]!.title}`, newPosts: [], recipients: 0, queued: 0, baseline: true };
  }

  const fresh = pickFresh(items, previous);
  if (!fresh.length) return { ran: true, reason: '没有新文章', newPosts: [], recipients: 0, queued: 0, baseline: false };

  const rows = await createDb(env)
    .select({ email: subscribers.email, token: subscribers.token })
    .from(subscribers)
    .where(eq(subscribers.status, 'confirmed'));
  if (!rows.length) return { ran: true, reason: '没有已确认的订阅者', newPosts: fresh.map((f) => f.link), recipients: 0, queued: 0, baseline: false };

  // 额度不够就整批不发，也不推进推送位点：明天的 Cron 会再看到这批新文章。
  // 宁可晚一天，也不能把 100 封的日额度撞成 50 封成功 50 封失败。
  const quota = await mailQuotaCheck(env, rows.length);
  if (!quota.ok) {
    return {
      ran: false,
      reason: quota.reason,
      newPosts: fresh.map((f) => f.link),
      recipients: rows.length,
      queued: 0,
      baseline: false,
    };
  }

  const siteName = (await getConfig(env, 'siteName')) ?? 'Zero';
  const base = await siteBase(env);
  const subject = `${siteName} 更新了：${fresh[0]!.title}${fresh.length > 1 ? ` 等 ${fresh.length} 篇` : ''}`;

  let queued = 0;
  for (const row of rows) {
    // 正文走后台「邮件模板 → 其它通知」：{content} 是下面拼好的文章列表（已逐条转义），
    // 退订链接放进落款下方的小字，外壳由模板统一提供，不再各封信各写一套 div
    const html = await renderEmail(
      env,
      'notice',
      {
        intro: `${siteName} 有新内容：`,
        content: feedItemsHtml({ base, items: fresh }),
        url: base,
        action: '访问站点',
      },
      {
        title: subject,
        nickname: '订阅者',
        actionNote: row.token ? '不想再收到更新邮件？点信件顶部的站点链接进入订阅页，或用下面的退订地址。' : '',
        rawKeys: ['content'],
      },
    );
    const res = await queueEmail(env, { to: row.email, subject, html, kind: 'broadcast', postId: fresh[0]!.link });
    if (res.success) queued++;
  }

  await writeState(env, { link: fresh[0]!.link, date: fresh[0]!.pubDate, pushedAt: Math.floor(Date.now() / 1000) });
  return {
    ran: true,
    reason: `已为 ${fresh.length} 篇新文章入队 ${queued}/${rows.length} 封`,
    newPosts: fresh.map((f) => f.link),
    recipients: rows.length,
    queued,
    baseline: false,
  };
}

async function siteBase(env: Env): Promise<string> {
  return ((await getConfig(env, 'siteUrl')) ?? env.SITE_URL ?? '').replace(/\/+$/, '');
}

async function resolveFeedUrl(env: Env): Promise<string> {
  const custom = (await getConfig(env, 'subscribeFeedUrl')) ?? '';
  if (custom) return custom;
  const base = await siteBase(env);
  if (!base) return '';
  return `${base}/index.xml`;
}

async function readState(env: Env): Promise<PushState | null> {
  const raw = await env.SESSION.get(STATE_KEY, { type: 'text' }).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PushState;
  } catch {
    return null;
  }
}

async function writeState(env: Env, state: PushState): Promise<void> {
  await env.SESSION.put(STATE_KEY, JSON.stringify(state)).catch(() => undefined);
}

/**
 * RSS 一般是新在前。找到上次推送的那条，取它之前的全部；
 * 找不到（比如 feed 只保留最近若干条）就退回按发布时间比较。
 */
function pickFresh(items: FeedItem[], previous: PushState): FeedItem[] {
  const at = items.findIndex((i) => i.link === previous.link);
  if (at > 0) return items.slice(0, at);
  if (at === 0) return [];
  const then = Date.parse(previous.date);
  if (Number.isNaN(then)) return [];
  return items.filter((i) => Date.parse(i.pubDate) > then).reverse();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

/** 新文章列表那段 HTML：外壳与称呼由 notice 模板负责，这里只出列表 */
function feedItemsHtml(input: { base: string; items: FeedItem[] }): string {
  const rows = input.items
    .map(
      (i) =>
        `<li style="margin:0 0 14px 0;">` +
        `<a href="${escapeHtml(i.link)}" style="color:#0d8368;text-decoration:none;font-weight:600">${escapeHtml(i.title)}</a>` +
        (i.summary ? `<div style="color:#57606a;font-size:13px;margin-top:4px;line-height:1.7">${escapeHtml(i.summary).slice(0, 160)}</div>` : '') +
        `</li>`,
    )
    .join('');
  return `<ul style="padding-left:18px;margin:16px 0">${rows}</ul>`;
}

/** 抓 feed 并抽出 item；只做够用解析，不引第三方 XML 库 */
async function fetchFeed(url: string): Promise<FeedItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let xml = '';
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/rss+xml, application/xml, text/xml', 'User-Agent': 'zero-api/1.0 (subscribe push)' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const items: FeedItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  for (const block of blocks) {
    const link = tagText(block, 'link') ?? tagAttr(block, 'guid');
    if (!link) continue;
    items.push({
      title: unescapeXml(tagText(block, 'title') ?? ''),
      link,
      pubDate: tagText(block, 'pubDate') ?? '',
      summary: cleanSummary(unescapeXml(stripTags(tagText(block, 'description') ?? tagText(block, 'content:encoded') ?? ''))).slice(0, 300),
    });
  }
  return items;
}

function tagText(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  if (!m) return null;
  const raw = m[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  return (cdata ? cdata[1]! : raw).trim() || null;
}

/** Atom 的 <link href="..."/> 形式 */
function tagAttr(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*href=["']([^"']+)["']`, 'i').exec(xml);
  if (m) return m[1]!;
  const plain = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return plain ? plain[1]!.trim() || null : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * RSS 的 description 往往是整篇正文（Hugo 默认给全文），末尾还带着主题自己那截页脚。
 * 清洗口径与朋友动态那条链路共用一份，见 services/feed-summary.ts。
 */

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}
