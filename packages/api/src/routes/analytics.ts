import { and, asc, desc, gte, sql } from 'drizzle-orm';
import { requireAdmin } from '../middleware/auth';
import { Hono } from 'hono';
import { createDb } from '../db/client';
import { visits } from '../db/schema';
import { getConfig } from '../services/config';
import { getConfigBool, getConfigInt } from '../services/config';
import { hashIp, lifetimeStats, recordPageview, statsMeta, visitorDistinctSql } from '../services/stats';
import { ok, fail } from '../lib/errors';
import { clientIp, country, isBot, parseUserAgent, referrerHost, userAgent } from '../lib/http';
import { rateLimit } from '../lib/rate-limit';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

/*
 * 后台这几块统计（概览 / 趋势 / 设备 / 排行）都是对 visits 的区间扫描：
 * 30 天窗口在 5000 访问/天 下要读 15 万行，一次打开四张卡片就是六十万行，
 * 而 D1 免费额度是 500 万行读/天 —— 后台来回刷新几次就把一天的额度用完了。
 * 按「接口 + 参数」在 isolate 内存里缓存一分钟：后台看的是趋势，不是秒级实时，
 * 而且新访问量本身就有最长 5 分钟的批量落库延迟。
 */
const MEMO_MS = 60_000;
const memo = new Map<string, { at: number; data: unknown }>();

async function memoized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.data as T;
  const data = await fn();
  memo.set(key, { at: Date.now(), data });
  // 参数是有限集合（days 只有几种），不需要淘汰策略；这里只兜住手改参数造成的堆积
  if (memo.size > 64) for (const [k, v] of memo) if (Date.now() - v.at > MEMO_MS) memo.delete(k);
  return data;
}

/**
 * 进入页面：建立会话。sendBeacon 只能发 POST 且带不了自定义头，
 * 所以所有字段走 URL 查询串，body 兜底再读一遍；顺便记一次「建站以来累计」。
 */
app.post('/beat', async (c) => {
  const env = c.env;
  if (!(await getConfigBool(env, 'analyticsEnabled', true))) return ok({ tracked: false });

  const q = c.req.query();
  let payload = { ...q };
  if (!payload.p) {
    const body = (await c.req.json().catch(() => null)) as Record<string, string> | null;
    payload = { ...payload, ...(body ?? {}) };
  }

  const path = normalizePath(payload.p ?? payload.path ?? '/');
  const ua = userAgent(c);
  const ip = clientIp(c);
  // 爬虫与监控探针不入库，否则浏览量与热门页 Top 会被机器流量抬虚高
  if (isBot(ua)) return ok({ tracked: false });
  /* 频控：一个 IP 一小时 240 次（约每分钟翻 4 页），正常人逛站碰不到这条线。
     放在 UA 判断之后，爬虫已经不入库，别为它们白写 KV。 */
  await rateLimit(c, 'beat', 240, 3600);
  const { device, browser, os } = parseUserAgent(ua);

  // 访客指纹 sha256(salt|ip)：明文 IP 只在这一步存在于内存，入库的只有哈希
  const ipHash = await hashIp(env, ip);

  const db = createDb(env);
  await db.insert(visits).values({
    id: crypto.randomUUID(),
    // session_id 只表示「同一次会话」，用于实时在线；按人去重看 ip_hash
    sessionId: payload.s || payload.session || hash(ip + '|' + ua),
    ipHash,
    path,
    referrer: referrerHost(payload.r || payload.referrer || ''),
    country: country(c),
    device,
    browser,
    os,
    duration: 0,
    createdAt: Math.floor(Date.now() / 1000),
  });

  // 「建站以来累计」单独记在 site_config 计数器里（新访客首次出现才 +1）：
  // 明细表会被 analytics:prune 按 retentionDays 删掉，计数器不受影响，所以累计口径不会倒退。
  await recordPageview(env, ipHash);
  return ok({ tracked: true });
});

/**
 * 停留时长结算：把客户端累计到的秒数加到本次会话最近一条记录上。
 * 一条 SQL 定位 + 累加，不再「先查两遍再更新」——每次访问只进来一次，读额度同样金贵。
 */
app.post('/heartbeat', async (c) => {
  const env = c.env;
  if (!(await getConfigBool(env, 'analyticsEnabled', true))) return ok({ tracked: false });

  const q = c.req.query();
  const body = (await c.req.json().catch(() => null)) as Record<string, string | number> | null;
  const merged = { ...q, ...(body ?? {}) };
  const sessionId = String(merged.s || merged.session || '');
  const seconds = Number(merged.d ?? merged.duration ?? 0);
  if (!sessionId || !Number.isFinite(seconds) || seconds <= 0) return ok({ tracked: false });

  // 访客指纹 sha256(salt|ip)，只用来给缺哈希的老行补数据，新行由 /beat 写入
  const ipHash = await hashIp(env, clientIp(c));
  const row = await env.DB.prepare(
    `update visits
       set duration = min(duration + ?, 86400),
           ip_hash = coalesce(nullif(ip_hash, ''), ?)
     where id = (select id from visits
                  where session_id = ? and created_at >= ?
                  order by created_at desc limit 1)
     returning duration`,
  )
    .bind(Math.round(seconds), ipHash, sessionId, Math.floor(Date.now() / 1000) - 86400)
    .first<{ duration: number }>();
  if (!row) return ok({ tracked: false });
  return ok({ tracked: true, duration: Number(row.duration ?? 0) });
});

/* ---------------- 后台统计接口 ---------------- */

app.get('/summary', async (c) => {
  requireAdmin(c);
  const env = c.env;
  return ok(
    await memoized('analytics:summary', async () => {
      const db = createDb(env);
      const offset = await offsetHours(env);
      const todayStart = localStartOfDay(offset);
      const onlineWindow = Math.floor(Date.now() / 1000) - 300;

      /*
       * 口径：
       * - 访客去重用 visitorDistinctSql() = count(distinct coalesce(nullif(ip_hash,''), session_id))：
       *   优先按加盐 IP 哈希去重（真实人数），迁移前写的老行没有哈希就退回会话指纹，旧数据不会被漏计。
       * - todayViews / todayVisitors / onlineNow / avgDurationSeconds 走 created_at 索引的区间查询。
       * - totalViews / totalVisitors 与 allTimeViews / totalUniqueIpVisitors 同源，都取「建站以来累计」
       *   （site_config 计数器 + 访客注册表）。这里刻意不再对明细表做 count(*)：
       *   按默认 365 天留存，一年就是上百万行，开一次后台就把当天的 D1 读额度烧掉一大截，
       *   而清理只删明细不动计数器，累计值本来也不会倒退。
       */
      const [today] = await db
        .select({ n: sql<number>`count(*)`, s: visitorDistinctSql() })
        .from(visits)
        .where(gte(visits.createdAt, todayStart));
      const online = await db
        .select({ s: visitorDistinctSql() })
        .from(visits)
        .where(gte(visits.createdAt, onlineWindow));
      const avg = await db
        .select({ d: sql<number>`coalesce(avg(duration), 0)` })
        .from(visits)
        .where(gte(visits.createdAt, todayStart - 7 * 86400));
      const [lifetime, meta] = await Promise.all([lifetimeStats(env), statsMeta(env)]);

      return {
        // ↓ 建站以来累计（site_config 计数器，不受到期清理影响）
        totalViews: lifetime.totalViews,
        totalVisitors: lifetime.totalVisitors,
        todayViews: Number(today?.n ?? 0),
        todayVisitors: Number(today?.s ?? 0),
        onlineNow: Number(online[0]?.s ?? 0),
        avgDurationSeconds: Math.round(Number(avg[0]?.d ?? 0)),
        // ↓ 与 todayVisitors 同一个「按 IP 去重」数值，cms stats 页的「独立访客（按 IP 去重）」读这个显式字段名
        todayUniqueIpVisitors: Number(today?.s ?? 0),
        allTimeViews: lifetime.totalViews,
        totalUniqueIpVisitors: lifetime.totalVisitors,
        retentionDays: meta.retentionDays,
        retentionNote: meta.note,
      };
    }),
  );
});

app.get('/trend', async (c) => {
  requireAdmin(c);
  const env = c.env;
  const days = Math.min(Number(c.req.query('days') ?? '30') || 30, 90);
  return ok(
    await memoized(`analytics:trend:${days}`, async () => {
      const offset = await offsetHours(env);
      const shift = offset * 3600;
      const dayExpr = sql<string>`date(created_at + ${shift}, 'unixepoch')`;
      const since = localStartOfDay(offset) - (days - 1) * 86400;
      const rows = await createDb(env)
        .select({
          day: dayExpr.as('day'),
          views: sql<number>`count(*)`,
          // 与 /summary 同一口径：按 ip_hash 去重，老行退回 session_id；字段名 visitors 保持不变，仪表盘直接吃
          visitors: visitorDistinctSql(),
        })
        .from(visits)
        .where(gte(visits.createdAt, since))
        .groupBy(dayExpr)
        .orderBy(asc(dayExpr));

      // 补齐没有访问的日期，前端画折线就不用再处理稀疏数组
      const map = new Map(rows.map((r) => [r.day, r]));
      const out: { day: string; views: number; visitors: number }[] = [];
      const start = localStartOfDay(offset);
      for (let i = days - 1; i >= 0; i--) {
        const day = new Date((start - i * 86400 + shift) * 1000).toISOString().slice(0, 10);
        const hit = map.get(day);
        out.push({ day, views: Number(hit?.views ?? 0), visitors: Number(hit?.visitors ?? 0) });
      }
      return out;
    }),
  );
});

app.get('/devices', async (c) => {
  requireAdmin(c);
  return ok(
    await memoized('analytics:devices', async () => {
      const offset = await offsetHours(c.env);
      const since = localStartOfDay(offset) - 30 * 86400;
      const groupBy = (field: 'device' | 'browser' | 'os' | 'country') =>
        createDb(c.env as Env)
          .select({ k: visits[field], n: sql<number>`count(*)` })
          .from(visits)
          .where(gte(visits.createdAt, since))
          .groupBy(visits[field])
          .orderBy(desc(sql`count(*)`));
      return {
        device: await groupBy('device'),
        browser: await groupBy('browser'),
        os: await groupBy('os'),
        country: (await groupBy('country')).slice(0, 20),
      };
    }),
  );
});

app.get('/top', async (c) => {
  requireAdmin(c);
  const days = Math.min(Number(c.req.query('days') ?? '30') || 30, 90);
  return ok(
    await memoized(`analytics:top:${days}`, async () => {
      const offset = await offsetHours(c.env);
      // 与 /trend 同一个窗口：含今天在内共 days 天（原来这里是 days 整，比趋势多算一天）
      const since = localStartOfDay(offset) - (days - 1) * 86400;
      const db = createDb(c.env);
      const pathRows = await db
        .select({
          path: visits.path,
          views: sql<number>`count(*)`,
          visitors: visitorDistinctSql(),
        })
        .from(visits)
        .where(gte(visits.createdAt, since))
        .groupBy(visits.path);
      // 同一篇文章在早期数据里可能存成 /x 与 /x/ 两行（normalizePath 之前没有强制尾斜杠），
      // 读的时候并成一条；去重访客不能相加，取两边上界，宁可少报也不虚报。
      const merged = new Map<string, { views: number; visitors: number }>();
      for (const r of pathRows) {
        const key = normalizePath(String(r.path ?? '/'));
        const hit = merged.get(key) ?? { views: 0, visitors: 0 };
        hit.views += Number(r.views ?? 0);
        hit.visitors = Math.max(hit.visitors, Number(r.visitors ?? 0));
        merged.set(key, hit);
      }
      const pages = [...merged.entries()]
        .map(([path, v]) => ({ path, views: v.views, visitors: v.visitors }))
        .sort((a, b) => b.views - a.views || b.visitors - a.visitors)
        .slice(0, 10);
      const refs = await db
        .select({ referrer: visits.referrer, n: sql<number>`count(*)`, s: visitorDistinctSql() })
        .from(visits)
        .where(and(gte(visits.createdAt, since), sql`${visits.referrer} <> ''`))
        .groupBy(visits.referrer)
        .orderBy(desc(sql`count(*)`))
        .limit(10);
      // siteUrl 给后台拼「点开就是站点页面」的绝对链接：后台和站点常常不同源，
      // 直接用站内相对路径会在后台自己的域名下 404
      const site = ((await getConfig(c.env, 'siteUrl')) ?? c.env.SITE_URL ?? '').replace(/\/+$/, '');
      return {
        site,
        days,
        pages,
        referrers: refs.map((r) => ({ referrer: r.referrer, views: Number(r.n), visitors: Number(r.s) })),
      };
    }),
  );
});

function normalizePath(p: string): string {
  const withSlash = p.startsWith('/') ? p : '/' + p;
  const clean = withSlash.split('?')[0]!.split('#')[0]!;
  return clean.length > 1 ? clean.replace(/\/+$/, '') + '/' : '/';
}

/** 统计的时区偏移（小时），默认东八区：不配它的话中国的「今天」会从 UTC 零点起算，早上那几小时的访问量算到昨天 */
async function offsetHours(env: Env): Promise<number> {
  const raw = Number(await getConfig(env, 'statsUtcOffsetHours'));
  if (!Number.isFinite(raw)) return 8;
  return Math.min(14, Math.max(-12, Math.trunc(raw)));
}

/** 本地日界的起点（UTC 秒）：按 offsetHours 那个时区算「今天 00:00」 */
function localStartOfDay(offset: number): number {
  const shift = offset * 3600;
  return Math.floor((Math.floor(Date.now() / 1000) + shift) / 86400) * 86400 - shift;
}

/** 会话标识兜底：IP+UA 的短哈希，不存原始 IP */
function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

void fail;
void getConfigInt;
export default app;
