import { and, asc, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { comments, friendPosts, friends, jobRuns, reactions, visits } from '../db/schema';
import { getConfig, getConfigBool, getConfigInt } from './config';
import { runDueBroadcastJobs } from './broadcast';
import { pushNewPostsToSubscribers } from './feed-push';
import { readRepoFile, repoBackend, writeRepoFile } from './repo';
import { normalizeFriendUrl, parseLinksYaml, type LinkSite } from './links-yaml';
import { triggerPagesBuild } from './git';
import { flushStatCounters, lifetimeStats } from './stats';
import { newId } from '../lib/crypto';

export interface JobOutcome {
  name: string;
  ok: boolean;
  detail: string;
}

/** Cron 入口：每个子任务独立记账，互不影响 */
export async function runScheduledJobs(env: Env, cron: string): Promise<JobOutcome[]> {
  const outcomes: JobOutcome[] = [];
  /** 这次 Cron 真正改动过的仓库文件；非空就触发一次构建，多个文件也只构建一次 */
  const changedFiles: string[] = [];
  const run = async (name: string, fn: () => Promise<string>) => {
    const startedAt = Math.floor(Date.now() / 1000);
    let status = 'ok';
    let detail = '';
    try {
      detail = await fn();
    } catch (e) {
      status = 'failed';
      detail = e instanceof Error ? e.message : String(e);
    }
    outcomes.push({ name, ok: status === 'ok', detail });
    // 跑完再落一行，而不是「先写 running 再改结果」：一天十来个任务，
    // 少一次 update 就少一次 D1 行写入，后台运行状况卡片看到的也是同一份结果
    try {
      await createDb(env)
        .insert(jobRuns)
        .values({ id: newId(), name, status, detail, startedAt, finishedAt: Math.floor(Date.now() / 1000) });
    } catch (e) {
      console.warn('[cron] 任务记账写入失败', name, e instanceof Error ? e.message : String(e));
    }
  };

  // 友链可用性检测 + 自动冷却
  if (await getConfigBool(env, 'friendsEnabled', true)) {
    // links.yaml 一次读回来，导入与写回 data/*.json 两处用（同一份名单，别读两遍）
    const linkSites = await readLinkSites(env);
    await run('friends:sync', () => importFriendsFromLinks(env, linkSites));
    await run('friends:check', () => checkFriends(env));
    if (await getConfigBool(env, 'friendsAutoCheck', true)) await run('friends:feed', () => fetchFriendFeeds(env));
    await run('friends:files', () => syncFriendFiles(env, linkSites, (paths) => changedFiles.push(...paths)));
  }


  // 到点的群发任务：schedule_at 已到且仍排队（queued）的逐个执行
  await run('broadcast:due', () => runDueBroadcastJobs(env));

  // 站点 RSS 有新条目就给订阅者发一封汇总邮件
  await run('subscribe:push', async () => {
    const pushed = await pushNewPostsToSubscribers(env);
    return pushed.reason;
  });

  // 文章阅读 / 评论 / 点赞 / 收藏数写回 data/poststats.json，首页精选与「最热」在构建期排序
  await run('poststats:export', () => exportPostStats(env));

  const retention = await getConfigInt(env, 'analyticsRetentionDays', 365);
  if (retention > 0) await run('analytics:prune', () => pruneVisits(env, retention));

  // 内存里还没落库的累计增量在 Cron 里结一次账。
  // 这里刻意不做「拿明细表对总数」的校准：一年下来明细上百万行，全表 count(*) 一次
  // 就吃掉当天相当大一块读额度；计数器按批量增量自己走，最多滞后不足一批（100 以内）。
  await run('stats:flush', async () => {
    await flushStatCounters(env);
    const life = await lifetimeStats(env);
    return `累计浏览 ${life.totalViews} / 累计访客 ${life.totalVisitors}`;
  });

  // 一轮任务最多只构建一次：友链文件与统计文件都写全了再触发
  if (changedFiles.length) {
    await run('pages:build', async () => {
      const r = await triggerPagesBuild(env);
      return r.triggered ? `已触发构建（${changedFiles.join('、')}）` : `未触发构建：${r.error ?? '未知原因'}`;
    });
  }

  console.log(`[cron ${cron}]`, JSON.stringify(outcomes));
  return outcomes;
}

/** 读仓库里的 data/links.yaml，解析成站点清单；读不到就是空表 */
async function readLinkSites(env: Env): Promise<LinkSite[]> {
  const file = await readRepoFile(env, await linksFilePath(env)).catch(() => null);
  return file ? parseLinksYaml(file.content) : [];
}

/**
 * 把 data/links.yaml 里登记的站点补进 D1。
 *
 * 前台友链页读的是 links.yaml，而检测与 RSS 聚合读的是 friends 表：两边不同步时，
 * 手工加在 yaml 里的朋友永远不会被抓取，朋友动态自然没有它们的新文章。
 */
async function importFriendsFromLinks(env: Env, sites: LinkSite[]): Promise<string> {
  if (!sites.length) return '没有 data/links.yaml 或里面没有条目，跳过';

  const db = createDb(env);
  const rows = await db.select().from(friends);
  const known = new Set(rows.map((r) => normalizeFriendUrl(r.url)));
  let added = 0;
  for (const s of sites) {
    const url = s.url.trim();
    if (!/^https?:\/\//i.test(url) || known.has(normalizeFriendUrl(url))) continue;
    await db.insert(friends).values({
      id: newId(),
      name: s.name || url,
      url,
      avatar: s.icon || null,
      rssUrl: s.rss || null,
      kind: s.kind,
      sortOrder: rows.length + added,
    });
    known.add(normalizeFriendUrl(url));
    added++;
  }
  return `登记 ${sites.length} 个站点，新增入库 ${added} 个`;
}

async function linksFilePath(env: Env): Promise<string> {
  const dir = ((await getConfig(env, 'githubDataDir')) || 'data').replace(/^\/+|\/+$/g, '');
  return `${dir}/links.yaml`;
}

/** 正常站，或冷却期已过的站，都重新纳入检测与抓取 */function eligible(now: number) {
  return or(eq(friends.status, 'active'), lt(friends.cooldownUntil, now));
}

/**
 * 友链可用性检测。
 *
 * 默认只检「填了 RSS 地址」的站（配置键 friendsCheckOnlyRss）：没有 RSS 的站不会进
 * 朋友动态，检它只能知道链接死没死，却要每天一次 Cron 里为每个站等最长 15 秒。
 * 想恢复全站扫描就把这个开关打开（false = 不只检 RSS）。
 *
 * friendsCheckIntervalHours（默认 24 小时）是每条友链自己的最小重检间隔：
 * Cron 一天可能跑多次，同一站在间隔内不重复出网，省 Workers 子请求也省 D1 写。
 */
async function checkFriends(env: Env): Promise<string> {
  const onlyRss = await getConfigBool(env, 'friendsCheckOnlyRss', true);
  const intervalH = Math.min(Math.max(Number(await getConfig(env, 'friendsCheckIntervalHours')) || 24, 1), 720);
  const db = createDb(env);
  const now = Math.floor(Date.now() / 1000);
  const candidates = await db
    .select()
    .from(friends)
    .where(eligible(now))
    .limit(100);
  const due = (f: (typeof candidates)[number]) => !f.lastCheckedAt || now - f.lastCheckedAt >= intervalH * 3600;
  const rows = candidates.filter((f) => due(f) && (!onlyRss || (f.rssUrl ?? '').trim() !== ''));

  let alive = 0;
  let cooled = 0;
  for (const f of rows) {
    let ok = false;
    try {
      const res = await fetch(f.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      ok = res.ok || res.status === 403 || res.status === 401; // 反爬站别误判为失效
    } catch {
      ok = false;
    }

    if (ok) {
      alive++;
      await db
        .update(friends)
        .set({ failCount: 0, lastCheckedAt: now, lastOkAt: now, status: 'active', cooldownUntil: null })
        .where(eq(friends.id, f.id));
    } else {
      const failCount = f.failCount + 1;
      // 连续 3 次失败冷却 1 小时，避免每次 Cron 都撞墙；
      // 「迷失的小船」不看这个冷却，看 lastOkAt 距今多少天（见 syncFriendFiles）
      const cooling = failCount >= 3;
      cooled += cooling ? 1 : 0;
      await db
        .update(friends)
        .set({
          failCount,
          lastCheckedAt: now,
          status: cooling ? 'cooldown' : 'active',
          cooldownUntil: cooling ? now + 3600 : null,
        })
        .where(eq(friends.id, f.id));
    }
  }
  return `检测 ${rows.length} 条（候选 ${candidates.length} 条，间隔 ${intervalH} 小时${onlyRss ? '，只检填了 RSS 的' : ''}），正常 ${alive}，进入冷却 ${cooled}`;
}

/**
 * RSS 聚合。解析刻意用最轻量的正则：友链源是外部脏数据，
 * 引完整 XML 解析器只会让 Worker 体积膨胀且更容易被畸形 feed 打挂。
 */
async function fetchFriendFeeds(env: Env): Promise<string> {
  const db = createDb(env);
  const rows = await db.select().from(friends).where(eligible(Math.floor(Date.now() / 1000))).limit(100);
  let added = 0;

  for (const f of rows) {
    const feedUrl = f.rssUrl ?? (await inferFeed(f.url));
    try {
      const res = await fetch(feedUrl, { signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'zero-cms/1.0 (+rss)' } });
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseFeed(xml, f.url).slice(0, 10);
      for (const item of items) {
        const exists = await db
          .select({ id: friendPosts.id })
          .from(friendPosts)
          .where(and(eq(friendPosts.friendId, f.id), eq(friendPosts.link, item.link)))
          .limit(1);
        if (exists.length) continue;
        await db.insert(friendPosts).values({
          id: newId(),
          friendId: f.id,
          title: item.title,
          link: item.link,
          summary: item.summary,
          pubDate: item.pubDate,
          fetchedAt: Math.floor(Date.now() / 1000),
        });
        added++;
      }
      await db
        .update(friends)
        .set({ lastCheckedAt: Math.floor(Date.now() / 1000), lastOkAt: Math.floor(Date.now() / 1000), failCount: 0 })
        .where(eq(friends.id, f.id));
    } catch {
      /* 单个站点失败不影响其它 */
    }
  }
  return `抓取 ${rows.length} 个源，新增 ${added} 篇文章`;
}

/**
 * 把 D1 里的检测结果落成站点 data/*.json。
 *
 * 前台「朋友动态」与「左邻右舍」的在线/失联分组只读这两个文件（Hugo 的 data 目录），
 * 库里有了数据而文件没更新，页面上就还是旧内容 —— 所以每次检测/抓取之后都要同步一次。
 * linksicons.json 不在此列：它存的是人工补过的 favicon 映射，比这里的 avatar 更全，不能被覆盖。
 */
async function syncFriendFiles(env: Env, linkSites: LinkSite[], onChange?: (paths: string[]) => void): Promise<string> {
  if ((await repoBackend(env)) === 'none') return '未配置内容仓库，跳过 data 文件写回';

  const db = createDb(env);
  const rows = await db.select().from(friends).orderBy(asc(friends.sortOrder), asc(friends.createdAt));
  if (!rows.length) return '友链表为空，保留仓库里现有的 data 文件';
  const posts = await db.select().from(friendPosts).orderBy(desc(friendPosts.pubDate)).limit(200);

  const byId = new Map(rows.map((f) => [f.id, f]));
  const now = Math.floor(Date.now() / 1000);
  const latest = new Map<string, number>();
  for (const p of posts) {
    const when = p.pubDate ?? p.fetchedAt;
    if (!latest.has(p.friendId)) latest.set(p.friendId, when);
  }

  // 页面顶部那句话的口径：30 天不可访问、或 90 天没有新动态 → 迷失的小船
  const lostAfter = Math.max(Number(await getConfig(env, 'friendsLostAfterDays')) || 30, 0) * 86400;
  const staleAfter = Math.max(Number(await getConfig(env, 'friendsStaleAfterDays')) || 90, 0) * 86400;

  const status: Record<string, unknown> = {};
  for (const f of rows) {
    const lp = latest.get(f.id);
    /* 「在线 / 失联」这个徽标看当下（连续三次检不上就标失联），
       而「活跃 / 迷失」这两组按页面承诺的阈值算：
         · 最近一次成功访问距今超过 friendsLostAfterDays 天
           （一次都没成功过的站按加入时间算，否则新加的死站永远留在「活跃的朋友」里）
         · 填了 RSS 且最新一篇文章超过 friendsStaleAfterDays 天 */
    const sinceOk = f.lastOkAt || f.createdAt;
    const unreachable = lostAfter > 0 && now - sinceOk >= lostAfter;
    const stale = staleAfter > 0 && lp ? now - lp >= staleAfter : false;
    const lost = unreachable || stale;
    status[f.url] = {
      name: f.name,
      url: f.url,
      group: lost ? 'lost' : 'active',
      /* 「在线」不能用 status 直接说：按阈值判定为不可访问的站，冷却还没到三次也是失联，
         不然小船里那条会顶着一个「在线」徽标，自相矛盾 */
      online: f.status === 'active' && !unreachable,
      icon: f.avatar ?? '',
      rss: f.rssUrl ?? '',
      latestPost: lp ? new Date(lp * 1000).toISOString() : '',
      daysSincePost: lp ? Math.max(0, Math.round((now - lp) / 86400)) : null,
      daysSinceOk: f.lastOkAt ? Math.max(0, Math.round((now - f.lastOkAt) / 86400)) : null,
    };
  }

  const feed = {
    // 用最新一条动态的时间当作 updated，而不是跑任务的时间：
    // 没有新内容时这份文件就该一个字节都不变，否则每次都算「有改动」，白触发一次 Pages 构建
    updated: posts.length ? new Date((posts[0]!.pubDate ?? posts[0]!.fetchedAt) * 1000).toISOString() : '',
    count: posts.length,
    items: posts.slice(0, 60).map((p) => {
      const owner = byId.get(p.friendId);
      return {
        title: p.title,
        url: p.link,
        site: owner?.name ?? '',
        siteurl: owner?.url ?? '',
        date: new Date((p.pubDate ?? p.fetchedAt) * 1000).toISOString(),
        summary: (p.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
        image: '',
      };
    }),
  };

  const dir = ((await getConfig(env, 'githubDataDir')) || 'data').replace(/^\/+|\/+$/g, '');
  const statusPath = `${dir}/linksstatus.json`;
  const feedPath = `${dir}/friendfeed.json`;

  /* 名单以「库里现有的 + data/links.yaml 现有的」为准。
     后台删掉一条友链并写回 yaml 之后，这里把它残留的检测记录与历史动态一并清掉，
     否则前台仍按旧键读到一条已经不存在的站（就是「删了还在显示」那个问题）。
     只在 yaml 里、还没进过库的站点保留它原有的那一份，不让一次检测把它们抹掉。 */
  const norm = (u: string) => normalizeFriendUrl(u);
  const inDb = new Set(rows.map((f) => norm(f.url)));
  const listed = new Set([...inDb, ...linkSites.map((s) => norm(s.url))]);
  const rewritten = new Set(Object.keys(status).map(norm));

  const oldStatus = (await readJson(env, statusPath)) as Record<string, unknown> | null;
  const mergedStatus: Record<string, unknown> = { ...status };
  for (const [url, v] of Object.entries(oldStatus ?? {})) {
    const k = norm(url);
    if (!listed.has(k) || rewritten.has(k)) continue;
    mergedStatus[url] = v;
  }

  const oldFeed = (await readJson(env, feedPath)) as { items?: { siteurl?: string; url?: string }[] } | null;
  const kept = (oldFeed?.items ?? []).filter((it) => !inDb.has(norm(it.siteurl ?? '')) && listed.has(norm(it.siteurl ?? '')));
  const items = [...feed.items, ...kept]
    .sort((a, b) => String((b as { date?: string }).date ?? '').localeCompare(String((a as { date?: string }).date ?? '')))
    .slice(0, 80);
  const mergedFeed = { updated: feed.updated, count: items.length, items };

  const files: [string, string][] = [
    [statusPath, JSON.stringify(mergedStatus, null, 2) + '\n'],
    [feedPath, JSON.stringify(mergedFeed, null, 2) + '\n'],
  ];
  const written: string[] = [];
  for (const [path, content] of files) {
    const res = await writeRepoFile(env, path, content, 'zero-api: 同步友链检测与朋友动态', { audit: false });
    // unchanged = 内容与仓库里那份一模一样，不记入待构建清单
    if (res.success && !res.unchanged) written.push(path);
  }
  if (written.length && onChange) onChange(written);
  else if (written.length) await triggerPagesBuild(env);
  return written.length
    ? `写入 ${written.join('、')}（本次 ${rows.length} 站 / 动态 ${items.length} 条）`
    : `内容与仓库一致，未提交（本次 ${rows.length} 站 / 动态 ${items.length} 条）`;
}

async function readJson(env: Env, path: string): Promise<unknown> {
  const file = await readRepoFile(env, path).catch(() => null);
  if (!file) return null;
  try {
    return JSON.parse(file.content);
  } catch {
    return null;
  }
}

/** Hugo 常见输出是 /index.xml，其余按 Atom / RSS 惯例依次探测 */const FEED_SUFFIXES = ['/index.xml', '/atom.xml', '/rss.xml', '/feed.xml', '/feed'];

async function inferFeed(siteUrl: string): Promise<string> {
  const base = siteUrl.replace(/\/+$/, '');
  for (const suffix of FEED_SUFFIXES) {
    const candidate = base + suffix;
    try {
      const res = await fetch(candidate, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      const head = (await res.text()).slice(0, 512);
      if (/<(rss|feed|rdf)[\s>]/i.test(head)) return candidate;
    } catch {
      continue;
    }
  }
  return base;
}

interface FeedItem {
  title: string;
  link: string;
  summary: string;
  pubDate: number | null;
}

function parseFeed(xml: string, siteUrl: string): FeedItem[] {
  const items: FeedItem[] = [];
  const chunks = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/g) ?? [];
  for (const chunk of chunks) {
    const title = tag(chunk, 'title');
    const link = tag(chunk, 'link') || attr(chunk, 'link', 'href') || '';
    const description = tag(chunk, 'description') || tag(chunk, 'summary') || tag(chunk, 'content') || '';
    const date = tag(chunk, 'pubDate') || tag(chunk, 'updated') || tag(chunk, 'published') || '';
    if (!title || !link) continue;
    items.push({
      title: stripCdata(decodeEntities(title)).trim(),
      link: stripCdata(decodeEntities(link)).trim() || new URL(link, siteUrl).toString(),
      summary: stripTags(stripCdata(decodeEntities(description))).slice(0, 300).trim(),
      pubDate: date ? Math.floor(new Date(date).getTime() / 1000) || null : null,
    });
  }
  return items;
}

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1]! : null;
}

function attr(xml: string, name: string, attrName: string): string | null {
  const m = xml.match(new RegExp(`<${name}[^>]*${attrName}="([^"]+)"`, 'i'));
  return m ? m[1]! : null;
}

function stripCdata(s: string): string {
  return s.replace(/^<!\[CDATA\[|\]\]>$/g, '');
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}



async function pruneVisits(env: Env, retentionDays: number): Promise<string> {
  const db = createDb(env);
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400;
  const row = await db.select({ n: sql<number>`count(*)` }).from(visits).where(lt(visits.createdAt, cutoff));
  await db.delete(visits).where(lt(visits.createdAt, cutoff));
  await db.delete(jobRuns).where(lt(jobRuns.startedAt, cutoff));
  return `清理 ${row[0]?.n ?? 0} 条过期统计`;
}

/**
 * 同一篇文章在几张表里写成三种样子：评论存解码后不带斜杠、reactions 可能是浏览器给的
 * 百分号编码、访问记录是编码 + 带尾斜杠。导出前统一成 Hugo .RelPermalink 的样子
 * （解码 + 首尾各一个斜杠），主题那边才能一次查到。
 */
function statKey(raw: string): string {
  let s = String(raw ?? '').split('?')[0].split('#')[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    /* 半截的 %xx 解不开就原样用 */
  }
  s = s.replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) s = `/${s}`;
  if (!s.endsWith('/')) s = `${s}/`;
  return s;
}

export interface PostStat {
  views: number;
  comments: number;
  likes: number;
  stars: number;
}

/**
 * 把每篇文章的评论 / 点赞 / 收藏 / 阅读数导出成 data/poststats.json。
 *
 * 这些数只存在 D1 里，Hugo 构建期拿不到；不导出的话首页精选只能按日期排，
 * 「最热」还得靠前端现查 Waline（没 JS、或后台换掉评论系统时就是错的）。
 * 导出后由主题在构建期排序，排名对所有人一致，代价是最多滞后一个定时周期。
 */
export async function exportPostStats(env: Env, onChange?: (paths: string[]) => void): Promise<string> {
  if (!(await getConfigBool(env, 'poststatsEnabled', true))) return '后台已关闭统计导出，跳过';
  if ((await repoBackend(env)) === 'none') return '未配置内容仓库，跳过 poststats.json 写回';

  const db = createDb(env);
  const windowDays = await getConfigInt(env, 'poststatsViewWindowDays', 0);
  const since = windowDays > 0 ? Math.floor(Date.now() / 1000) - windowDays * 86400 : 0;

  const stats = new Map<string, PostStat>();
  const at = (raw: string): PostStat => {
    const key = statKey(raw);
    let entry = stats.get(key);
    if (!entry) {
      entry = { views: 0, comments: 0, likes: 0, stars: 0 };
      stats.set(key, entry);
    }
    return entry;
  };

  // 只数已经放出来的评论，待审与被拦截的不参与热度
  const commentRows = await db
    .select({ slug: comments.postSlug, n: sql<number>`count(*)` })
    .from(comments)
    .where(eq(comments.status, 'approved'))
    .groupBy(comments.postSlug);
  for (const r of commentRows) at(r.slug).comments = Number(r.n || 0);

  const reactionRows = await db
    .select({ slug: reactions.targetSlug, kind: reactions.kind, n: sql<number>`count(*)` })
    .from(reactions)
    .groupBy(reactions.targetSlug, reactions.kind);
  for (const r of reactionRows) {
    const entry = at(r.slug);
    if (r.kind === 'star') entry.stars = Number(r.n || 0);
    else entry.likes = Number(r.n || 0);
  }

  // 阅读按「同一天同一访客只算一次」去重，与后台统计页口径一致（刷新五次不算五个阅读）
  const visitRows = await db
    .select({
      path: visits.path,
      n: sql<number>`count(distinct (${visits.createdAt} / 86400) || '-' || coalesce(nullif(${visits.ipHash}, ''), ${visits.sessionId}))`,
    })
    .from(visits)
    .where(gte(visits.createdAt, since))
    .groupBy(visits.path);
  for (const r of visitRows) at(r.path).views = Number(r.n || 0);

  const posts: Record<string, PostStat> = {};
  for (const [slug, stat] of [...stats.entries()]
    .filter(([key]) => key !== '/' && key !== '/posts/')
    .sort((a, b) => a[0].localeCompare(b[0]))) {
    posts[slug] = stat;
    // Hugo 输出的 .RelPermalink 对中文标题可能是解码形态也可能是百分号编码形态，
    // 两边都写一份，主题按哪个都能查到（多几行 JSON，省掉一次模板里的 urldecode）
    const encoded = encodeURI(slug);
    if (encoded !== slug) posts[encoded] = stat;
  }

  const dir = ((await getConfig(env, 'githubDataDir')) || 'data').replace(/^\/+|\/+$/g, '');
  const path = `${dir}/poststats.json`;
  // 不带「本次生成时间」这种字段：数字没变时文件就该完全一致，
  // 否则每次导出都被当成有改动，白烧一次提交与 Pages 构建（时间看 Git 记录就够了）
  const content = JSON.stringify({ viewWindowDays: windowDays, posts }, null, 2) + '\n';

  const res = await writeRepoFile(env, path, content, 'zero-api: 导出文章阅读/评论/点赞/收藏统计', { audit: false });
  if (!res.success) return `写入 ${path} 失败：${res.error ?? '未知原因'}`;
  if (res.unchanged) return `统计与上次一致，未提交（${Object.keys(posts).length} 篇，阅读窗口 ${windowDays > 0 ? `${windowDays} 天` : '全量'}）`;
  // 定时任务把构建推迟到整轮结束后统一触发一次；后台手动点「立即导出」时没有这层，直接构建
  if (onChange) onChange([path]);
  else await triggerPagesBuild(env);
  return `写入 ${path}（${Object.keys(posts).length} 篇，阅读窗口 ${windowDays > 0 ? `${windowDays} 天` : '全量'}）`;
}

