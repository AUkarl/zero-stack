/**
 * 访问统计的服务端部分：访客指纹 + 「建站以来累计」两个长期指标。
 *
 * 为什么累计值不能直接 count(*)：
 * analytics:prune 这个 Cron 会按 analyticsRetentionDays 删掉过期明细（默认 365 天），
 * 明细表只剩一年内，`select count(*) from visits` 就成了「近一年浏览量」而不是「建站以来」。
 * 所以累计量单独记账：site_config 里两行计数器（stats.totalViews / stats.totalVisitors）。
 *
 * 计数器只在「读」和「清理前」写，不在每次 PV 写：
 * 单次 PV 只留一行明细，读取累计时把计数器抬到「现有明细数 / 访客注册表数」的下限即可，
 * 这样既不会因为延迟落库而少计，也不会因为「既 +1 又抬升」而重复计数。
 * 唯一必须守住的顺序是 pruneVisits 先抬升再删除，这一步在 scheduler 里做。
 *
 * IP 只在内存里出现一次：sha256(salt|ip) 之后立刻丢弃明文，库里只有哈希。
 */

import { sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { visitorKeys, visits } from '../db/schema';
import { getConfig } from './config';

const enc = new TextEncoder();

const KEY_VIEWS = 'stats.totalViews';
const KEY_VISITORS = 'stats.totalVisitors';

function salt(env: Env): string {
  // 盐只用于把 IP 变成不可逆指纹，站点没配密钥时用固定串也比明文 IP 安全
  return env.SESSION_SECRET ?? env.AUTH_SECRET ?? 'zero-analytics-salt';
}

/** sha256(salt|ip) 十六进制；IP 为空或已经是哈希时返回 null */
export async function hashIp(env: Env, ip: string | null | undefined): Promise<string | null> {
  const raw = String(ip ?? '').trim();
  if (!raw || raw.length > 64) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${salt(env)}|${raw.toLowerCase()}`));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * 访客去重表达式：优先用 ip_hash，历史数据（哈希列为空）退回 session_id。
 * 空串与 null 都算「没有指纹」，交给 coalesce 兜底。
 */
export function visitorDistinctSql() {
  return sql<number>`count(distinct coalesce(nullif(${visits.ipHash}, ''), ${visits.sessionId}))`;
}

/** 计数器自增：一条 SQL 完成 upsert + delta，避免读改写丢更新 */
async function bumpCounter(env: Env, key: string, delta: number): Promise<void> {
  if (!Number.isFinite(delta) || delta === 0) return;
  try {
    await env.DB.prepare(
      `insert into site_config (key, value, value_type, updated_at)
       values (?, ?, 'number', (strftime('%s','now')))
       on conflict(key) do update
         set value = cast(max(0, cast(site_config.value as integer) + cast(excluded.value as integer)) as text),
             value_type = 'number',
             updated_at = (strftime('%s','now'))`,
    )
      .bind(key, String(delta))
      .run();
  } catch (e) {
    // 累计量是附加指标，记账失败绝不能影响页面统计上报
    console.warn('[stats] 计数器写入失败', key, e instanceof Error ? e.message : String(e));
  }
}

async function readCounter(env: Env, key: string): Promise<number | null> {
  try {
    const row = await env.DB.prepare('select value from site_config where key = ?').bind(key).first<{ value: string }>();
    if (!row) return null;
    const n = Number.parseInt(String(row.value), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** 把一个计数器抬到不低于 floor，只在「从来没记过」或明细比计数器多时写一次 */
async function raiseCounter(env: Env, key: string, floor: number): Promise<number> {
  const stored = await readCounter(env, key);
  if (stored !== null && stored >= floor) return stored;
  const next = Math.max(stored ?? 0, floor);
  try {
    await env.DB.prepare(
      `insert into site_config (key, value, value_type, updated_at)
       values (?, ?, 'number', (strftime('%s','now')))
       on conflict(key) do update
         set value = cast(max(cast(site_config.value as integer), excluded.value) as text),
             value_type = 'number',
             updated_at = (strftime('%s','now'))`,
    )
      .bind(key, String(next))
      .run();
  } catch (e) {
    console.warn('[stats] 计数器校正失败', key, e instanceof Error ? e.message : String(e));
  }
  return next;
}

/* ------------------------------------------------------------------
 * 批量落库
 *
 * PV 计数不逐次写 site_config：5000 访问/天就是 5000 次行写入，白占额度。
 * 增量先攒在当前 isolate 的内存里，攒够一批或隔了五分钟再一次性加上去。
 * isolate 被回收最多丢掉不足一批的量（上界 100 封），对「建站以来累计」这种
 * 只用来展示的整数是可以接受的；真要重新校准，把 site_config 里这两行删掉，
 * 下一次读取会用明细表与注册表现算一次基线。
 * ----------------------------------------------------------------*/

const FLUSH_ROWS = 100;
const FLUSH_AGE_MS = 300_000;

let pendingViews = 0;
let pendingVisitors = 0;
let pendingSince = Date.now();

/** 把内存里的增量写回 site_config，定时任务结束前也会调一次 */
export async function flushStatCounters(env: Env): Promise<void> {
  const views = pendingViews;
  const visitors = pendingVisitors;
  pendingViews = 0;
  pendingVisitors = 0;
  pendingSince = Date.now();
  if (!views && !visitors) return;
  const tasks: Promise<void>[] = [];
  if (views) tasks.push(bumpCounter(env, KEY_VIEWS, views));
  if (visitors) tasks.push(bumpCounter(env, KEY_VISITORS, visitors));
  await Promise.all(tasks);
}

/**
 * 每次 PV 记一次累计浏览；首次出现的访客指纹记一次累计访客。
 * ipHash 为空（拿不到 CF 头之外的可信 IP）时只记浏览量，不记访客，免得把空串当成同一个人。
 */
export async function recordPageview(env: Env, ipHash: string | null): Promise<void> {
  pendingViews += 1;
  if (ipHash && (await registerVisitor(env, ipHash))) pendingVisitors += 1;
  if (pendingViews + pendingVisitors >= FLUSH_ROWS || Date.now() - pendingSince >= FLUSH_AGE_MS) {
    await flushStatCounters(env);
  }
}

/** 登记访客指纹。返回 true 只在这个哈希第一次出现时给出，老访客不改任何行 */
async function registerVisitor(env: Env, ipHash: string): Promise<boolean> {
  try {
    const r = await env.DB.prepare('insert or ignore into visitor_keys (ip_hash, first_seen) values (?, ?)')
      .bind(ipHash, Math.floor(Date.now() / 1000))
      .run();
    return Number((r.meta as { changes?: number })?.changes ?? 0) > 0;
  } catch (e) {
    // 注册表读不到就不计新人，累计量靠每日的对账补回来
    console.warn('[stats] 访客登记失败', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * 建站以来累计：只读 site_config 的两行计数器，不扫明细表。
 * 明细表一年就能攒上百万行，`count(*)` 每开一次后台就全表扫一遍，
 * 读额度比写额度先顶不住；对账交给 reconcileLifetimeCounters 每天做一次。
 * 计数器还没建立时（全新站点第一条访问之前）才现算一次基线。
 */
export async function lifetimeStats(env: Env): Promise<{ totalViews: number; totalVisitors: number }> {
  const storedViews = await readCounter(env, KEY_VIEWS);
  const storedVisitors = await readCounter(env, KEY_VISITORS);
  if (storedViews !== null && storedVisitors !== null) return { totalViews: storedViews, totalVisitors: storedVisitors };
  return reconcileLifetimeCounters(env);
}

/**
 * 用明细表和访客注册表的现值给计数器做下限校正：只往上抬，绝不往下调。
 * 定时任务在删除过期明细之前调用一次，所以批量落库丢掉的零头、
 * 以及计数器行被误删的情况，都会在第二天补回来。
 */
export async function reconcileLifetimeCounters(env: Env): Promise<{ totalViews: number; totalVisitors: number }> {
  const db = createDb(env);
  const [counts, registry] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)`, s: visitorDistinctSql() })
      .from(visits)
      .then((r) => r[0]),
    db.select({ n: sql<number>`count(*)` }).from(visitorKeys).then((r) => Number(r[0]?.n ?? 0)),
  ]);
  const tableViews = Number(counts?.n ?? 0);
  const tableVisitors = Math.max(Number(counts?.s ?? 0), registry);

  const [totalViews, totalVisitors] = await Promise.all([
    raiseCounter(env, KEY_VIEWS, tableViews),
    raiseCounter(env, KEY_VISITORS, tableVisitors),
  ]);
  return { totalViews, totalVisitors };
}

/** 后台展示用的口径说明：明细表只留 N 天，页面上的总数走的却是永久计数器 */
export async function statsMeta(env: Env): Promise<{ retentionDays: number; note: string }> {
  const raw = await getConfig(env, 'analyticsRetentionDays');
  const days = Number.parseInt(raw ?? '365', 10);
  const retentionDays = Number.isFinite(days) && days > 0 ? days : 0;
  return {
    retentionDays,
    note: retentionDays
      ? `明细只留 ${retentionDays} 天，用于按天/按页的趋势与排行；总访问量与独立访客读的是永久计数器，删明细不会让它变小`
      : '明细不做清理；总访问量与独立访客读的是永久计数器',
  };
}

/**
 * 手动重算「建站以来累计」：与每日对账不同，这里允许把计数器**调低**。
 *
 * 每日 reconcileLifetimeCounters 只向上抬，是为了防「批量落库丢零头」；
 * 但导入旧站数据、误删明细之后，计数器可能比真实明细大，只能人工校正。
 * 所以这一步必须由后台按钮触发（先演习、再确认），不能让定时任务自己降。
 */
export async function recountLifetimeCounters(
  env: Env,
  opts: { apply?: boolean } = {},
): Promise<{
  applied: boolean;
  current: { views: number; visitors: number };
  computed: { views: number; visitors: number };
  retentionDays: number;
  note: string;
}> {
  // 本 isolate 攒着的增量先落库，否则重算完再 flush 会把同样的量重复加回来
  await flushStatCounters(env);

  const db = createDb(env);
  const [counts, registry] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)`, s: visitorDistinctSql() })
      .from(visits)
      .then((r) => r[0]),
    db.select({ n: sql<number>`count(*)` }).from(visitorKeys).then((r) => Number(r[0]?.n ?? 0)),
  ]);
  const computed = {
    views: Number(counts?.n ?? 0),
    visitors: Math.max(Number(counts?.s ?? 0), registry),
  };
  const current = {
    views: (await readCounter(env, KEY_VIEWS)) ?? 0,
    visitors: (await readCounter(env, KEY_VISITORS)) ?? 0,
  };

  if (opts.apply) {
    await Promise.all([setCounter(env, KEY_VIEWS, computed.views), setCounter(env, KEY_VISITORS, computed.visitors)]);
  }

  const meta = await statsMeta(env);
  const note = meta.retentionDays
    ? `重算只依据明细表里还留着的 ${meta.retentionDays} 天数据；更早的明细已被清理，应用后累计值可能比当前小。`
    : '重算依据全部明细与访客注册表；应用后累计值会与明细完全一致。';
  return { applied: opts.apply === true, current, computed, retentionDays: meta.retentionDays, note };
}

/** 把计数器写成指定值（重算用；与只抬不降的 raiseCounter 区分开） */
async function setCounter(env: Env, key: string, value: number): Promise<void> {
  const n = Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
  await env.DB.prepare(
    `insert into site_config (key, value, value_type, updated_at)
     values (?, ?, 'number', (strftime('%s','now')))
     on conflict(key) do update
       set value = excluded.value,
           value_type = 'number',
           updated_at = (strftime('%s','now'))`,
  )
    .bind(key, String(n))
    .run();
}
