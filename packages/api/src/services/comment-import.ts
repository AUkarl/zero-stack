/**
 * 评论导入：把第三方评论系统（Waline / Twikoo / Artalk / Giscus / CommentBox）
 * 或自家备份文件里的评论，归一化成 comments 表的行。
 *
 * 为什么放在备份模块旁边：站主换评论系统时最容易丢的就是历史评论，
 * 而这些系统的导出格式互不相同 —— 字段名、时间格式、嵌套方式、状态取值都不一样。
 * 这里一次把差异吃掉：导入前先 dry-run，让站主看到「识别成哪种格式、
 * 一共几条、有几条会因为字段缺失被跳过、落到哪些 slug 上」，确认后才真写库。
 *
 * 落库的三条约定：
 * - isLegacy = true、legacyId = 原系统的 id：一眼看出哪些是搬来的，也防止同一份导出重复导入；
 * - 父子关系用 legacyId 索引重建（parent / parentId / parent_id 三种写法都认），
 *   depth 与 rootId 按重建出来的链算，最多六层，跟主题显示口径一致；
 * - 状态只映射成 approved / pending / spam 三态，映射表在下面 STATUS_MAP 里，
 *   默认全部按「已通过」入库（历史评论再走一遍先审后发没有意义）。
 */
import { and, eq, sql } from 'drizzle-orm';
import { commenters, comments, reactions, visits } from '../db/schema';
import { createDb } from '../db/client';
import { emailMd5, isEmail } from '../lib/avatar';
import { newId } from '../lib/crypto';

export type CommentFormat = 'zero' | 'waline' | 'twikoo' | 'artalk' | 'giscus' | 'commentbox' | 'generic';

export interface ImportRow {
  id: string;
  postSlug: string;
  parentId: string | null;
  depth: number;
  rootId: string | null;
  authorName: string;
  authorEmail: string | null;
  authorLink: string | null;
  content: string;
  status: string;
  userAgent: string | null;
  ipHash: string | null;
  browser: string | null;
  os: string | null;
  device: string | null;
  isLegacy: boolean;
  legacyId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ImportPlan {
  format: CommentFormat;
  total: number;
  rows: ImportRow[];
  /** 被跳过的条目原因计数，dry-run 面板直接显示 */
  skipped: { reason: string; count: number }[];
  /** 这批评论会落到哪些 slug 上（最多列 30 个），站主据此判断路径对不对 */
  slugs: { slug: string; count: number }[];
  notice: string | null;
}

/* ------------------------------------------------------------------ 取值 */

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** 按候选键名依次取值：不同系统给同一个意思起了五六个名字 */
function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

function pickStr(o: Record<string, unknown>, keys: string[]): string {
  const v = pick(o, keys);
  if (v === undefined) return '';
  if (typeof v === 'object') return '';
  return String(v).trim();
}

/** 时间：秒 / 毫秒 / ISO / 「2023-05-01 12:00:00」都吃 */
function toUnix(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    // 十位是秒、十三位是毫秒
    return n > 1e11 ? Math.floor(n / 1000) : n;
  }
  const parsed = Date.parse(String(v));
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000);
}

/** slug 归一：去掉域名、查询串，补前后斜杠；与 /api/comments 里的 canonSlug 同口径 */
function normSlug(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      /* 原样继续 */
    }
  }
  s = s.split('?')[0]!.split('#')[0]!;
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && !s.endsWith('/')) s += '/';
  return s;
}

const STATUS_MAP: Record<string, string> = {
  approved: 'approved',
  approved_by_admin: 'approved',
  published: 'approved',
  visible: 'approved',
  normal: 'approved',
  '0': 'approved',
  wait: 'pending',
  waiting: 'pending',
  pending: 'pending',
  review: 'pending',
  unreviewed: 'pending',
  hidden: 'pending',
  spam: 'spam',
  blocked: 'spam',
  rejected: 'spam',
  '2': 'spam',
};

function mapStatus(raw: unknown, fallback: string): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return fallback;
  return STATUS_MAP[s] ?? fallback;
}

/* ---------------------------------------------------------------- CSV 表格 */

/**
 * 只依赖标准库的 CSV 解析：Waline / Artalk 的控制台都能导出 .csv，
 * 表头就是字段名，所以解析成「表头 → 值」的对象数组后即可走同一套归一化。
 * 支持双引号包裹、字段内换行、CSV 里 \"\" 表示一个引号。
 */
export function parseCsvRows(text: string): Record<string, unknown>[] {
  const cells: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = String(text ?? '').replace(/^﻿/, '');

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    cells.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      endField();
      continue;
    }
    if (ch === '\n') {
      endRow();
      continue;
    }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field !== '' || row.length) endRow();

  const nonEmpty = cells.filter((r) => r.some((c) => c.trim() !== ''));
  if (nonEmpty.length < 2) return [];
  const header = nonEmpty[0]!.map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => {
    const o: Record<string, unknown> = {};
    header.forEach((h, idx) => {
      if (h) o[h] = r[idx] ?? '';
    });
    return o;
  });
}

/**
 * 附属计数：Waline 除了 Comment 那张表，还会导出 Counter 那张（浏览量与表态数），
 * 老版本是 {objectId, type:'Visit'|'Reaction', time}，1.4x 是 {url, time, reaction0..reaction8}。
 * 按地址汇总成 {slug, likes, views}，交给 planCounters / applyCounters 做「只增不减」。
 */
export interface CounterEntry {
  slug: string;
  likes: number;
  views: number;
  /** 这批计数发生在什么时候（有就用来给补出来的明细行定位，没有就 0） */
  at: number;
}

function counterTableOf(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return [];
  const o = rec(payload);
  const bucket = (v: unknown): Record<string, unknown>[] => {
    const map = rec(v);
    for (const [k, list] of Object.entries(map)) {
      if (/counter|count|stat/i.test(k) && Array.isArray(list)) return list.map(rec);
    }
    return [];
  };
    const fromData = bucket(o.data);
  if (fromData.length) return fromData;
  const fromTables = bucket(o.tables);
  return fromTables.length ? fromTables : bucket(o);
}

/** 一条 Counter 记录里挑出地址、浏览量与表态数 */
function oneCounter(r: Record<string, unknown>): CounterEntry | null {
  const slug = normSlug(
    pickStr(r, ['url', 'pathname', 'path', 'page_url', 'url_for', 'articlePath', 'article_path', 'slug', 'permalink']) ||
      (pickStr(r, ['objectId', 'oid', 'id']).includes('/') ? pickStr(r, ['objectId', 'oid', 'id']) : ''),
  );
  if (!slug || slug === '/') return null;
  const type = pickStr(r, ['type']).toLowerCase();
  const time = Math.max(0, Math.round(Number(pick(r, ['time', 'count', 'value']) ?? 0)) || 0);
  let likes = 0;
  for (let i = 0; i < 9; i++) likes += Math.max(0, Math.round(Number(r[`reaction${i}`] ?? 0)) || 0);
  let views = 0;
  if (type === 'reaction') likes += time;
  else if (type === 'visit' || type === 'counter') views += time;
  else if (type === 'comment') {
    /* 评论数由评论本身决定，这张表里的 Comment 行不额外补任何东西 */
  } else {
    // 1.4x 的 Counter 没有 type：time 是浏览量，reactionN 是表态数
    views += time;
  }
  const at = toUnix(pick(r, ['createdAt', 'created_at', 'updatedAt', 'insertedAt'])) ?? 0;
  return likes || views ? { slug, likes, views, at } : null;
}

/** 同一地址可能出现多行（多语言、改版前后），按地址合并 */
export function extractCounters(payload: unknown): CounterEntry[] {
  const merged = new Map<string, CounterEntry>();
  for (const row of counterTableOf(payload)) {
    const one = oneCounter(row);
    if (!one) continue;
    const cur = merged.get(one.slug);
    if (!cur) merged.set(one.slug, one);
    else {
      cur.likes += one.likes;
      cur.views += one.views;
      cur.at = cur.at || one.at;
    }
  }
  return [...merged.values()];
}

/**
 * 只增不减地并到本站：本站已经有更多的，就保持本站。
 * 指纹写成 legacy:<slug 哈希>:kind:序号，重复导入同一份文件时靠唯一索引自然去重。
 */
export interface CounterMergeResult {
  slugs: number;
  likesAdded: number;
  viewsAdded: number;
  kept: number;
}

/**
 * 地址 → 一小段稳定指纹，用作补出来的点赞 / 浏览行的 legacy 标记。
 * 不是加密用途（只是「同一地址每次算出同一个串」），所以自己写个 djb2，不引 crypto。
 */
function legacyTag(slug: string): string {
  let h = 5381;
  for (let i = 0; i < slug.length; i++) h = ((h << 5) + h + slug.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export async function planCounters(env: Env, entries: CounterEntry[]): Promise<CounterMergeResult> {
  const db = createDb(env);
  const out: CounterMergeResult = { slugs: 0, likesAdded: 0, viewsAdded: 0, kept: 0 };
  for (const e of entries) {
    if (!e.likes && !e.views) continue;
    out.slugs++;
    if (e.likes) {
      const cur = await db
        .select({ n: sql<number>`count(*)` })
        .from(reactions)
        .where(and(eq(reactions.targetSlug, e.slug), eq(reactions.kind, 'like')))
        .then((r) => Number(r[0]?.n ?? 0))
        .catch(() => 0);
      if (cur >= e.likes) out.kept++;
      else out.likesAdded += e.likes - cur;
    }
    if (e.views) {
      const cur = await db
        .select({ n: sql<number>`count(*)` })
        .from(visits)
        .where(eq(visits.path, e.slug))
        .then((r) => Number(r[0]?.n ?? 0))
        .catch(() => 0);
      if (cur >= e.views) out.kept++;
      else out.viewsAdded += e.views - cur;
    }
  }
  return out;
}

/** 补出来的浏览明细挂在同一个 legacy 会话下，时间用导出里的时间，不去污染「今天」的趋势 */
const VIEWS_PER_ROW_CAP = 20000;

export async function applyCounters(env: Env, entries: CounterEntry[]): Promise<CounterMergeResult> {
  const db = createDb(env);
  const out: CounterMergeResult = { slugs: 0, likesAdded: 0, viewsAdded: 0, kept: 0 };

  for (const e of entries) {
    if (!e.likes && !e.views) continue;
    out.slugs++;
    const hash = legacyTag(e.slug);

    if (e.likes) {
      const cur = await db
        .select({ n: sql<number>`count(*)` })
        .from(reactions)
        .where(and(eq(reactions.targetSlug, e.slug), eq(reactions.kind, 'like')))
        .then((r) => Number(r[0]?.n ?? 0))
        .catch(() => -1);
      if (cur < 0) out.kept++;
      else if (cur >= e.likes) out.kept++;
      else {
        const rows = Array.from({ length: e.likes - cur }, (_, i) => ({
          id: newId(),
          targetSlug: e.slug,
          kind: 'like',
          userId: null,
          fingerprint: `legacy:${hash}:like:${cur + i}`,
          createdAt: e.at || Math.floor(Date.now() / 1000),
        }));
        try {
          const res = await db.insert(reactions).values(rows).onConflictDoNothing();
          out.likesAdded += Number((res as unknown as { meta?: { changes?: number } }).meta?.changes ?? rows.length);
        } catch {
          out.kept++;
        }
      }
    }

    if (e.views) {
      const cur = await db
        .select({ n: sql<number>`count(*)` })
        .from(visits)
        .where(eq(visits.path, e.slug))
        .then((r) => Number(r[0]?.n ?? 0))
        .catch(() => -1);
      if (cur < 0 || cur >= e.views) out.kept++;
      else {
        const need = Math.min(e.views - cur, VIEWS_PER_ROW_CAP);
        const at = e.at || Math.floor(Date.now() / 1000);
        const rows = Array.from({ length: need }, (_, i) => ({
          id: newId(),
          sessionId: `legacy:${hash}:views`,
          ipHash: null,
          path: e.slug,
          referrer: null,
          country: null,
          device: null,
          browser: null,
          os: null,
          duration: 0,
          // 同一天只留一条足够：poststats 的浏览量按行数算，趋势按天聚合时不会全算到今天
          createdAt: at,
        }));
        // D1 一条语句最多绑 100 个参数，visits 一行 11 个字段
        for (let i = 0; i < rows.length; i += 8) {
          try {
            const res = await db.insert(visits).values(rows.slice(i, i + 8)).onConflictDoNothing();
            out.viewsAdded += Number((res as unknown as { meta?: { changes?: number } }).meta?.changes ?? 8);
          } catch {
            /* 补不上就算了，浏览数从来不是要紧的数据 */
          }
        }
      }
    }
  }
  return out;
}



/**
 * 「表名 → 行数组」这种导出结构：Waline 1.4x 是 `{data: {Comment:[], Counter:[], Users:[]}}`，
 * 别家的 `tables` 也可能是同形状的映射。挑真正装评论的那张：先看名字含 comment 的，
 * 再退到行数最多的那张（Counter/Users 通常比 Comment 少或字段不同）。
 */
function fromTableMap(obj: Record<string, unknown>): Record<string, unknown>[] {
  const arrays = Object.entries(obj).filter(
    ([, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null,
  ) as [string, Record<string, unknown>[]][];
  if (!arrays.length) return [];
  const byName = arrays.find(([key]) => /comment/i.test(key));
  const best = byName ?? arrays.reduce((a, b) => (b[1].length >= a[1].length ? b : a));
  return best[1];
}

/** 导出主体可能包在一层里：{data:[]} / {comments:[]} / [..] / {data:{Comment:[..]}} */
function extractList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.map(rec);
  const o = rec(payload);
  for (const key of ['comments', 'list', 'data', 'items', 'records', 'rows', 'result']) {
    const v = o[key];
    if (Array.isArray(v)) return v.map(rec);
    if (v && typeof v === 'object') {
      const inner = extractList(v);
      if (inner.length) return inner;
      const mapped = fromTableMap(rec(v));
      if (mapped.length) return mapped;
    }
  }
  // 自家备份：{ tables: { comments: [...] } }
  const tables = rec(o.tables);
  if (Array.isArray(tables.comments)) return tables.comments.map(rec);
  return fromTableMap(tables).length ? fromTableMap(tables) : fromTableMap(o);
}

export function detectCommentFormat(payload: unknown): CommentFormat {
  const o = rec(payload);
  if (o.version !== undefined && rec(o.tables).comments !== undefined) return 'zero';
  // 导出文件自己说了是哪个系统就信它（Waline 的 type 字段），省得靠字段名猜
  const self = typeof o.type === 'string' ? o.type.toLowerCase() : '';
  if (self === 'waline' || self === 'twikoo' || self === 'artalk' || self === 'giscus') return self;
  const list = extractList(payload);
  const first = list[0] ?? {};
  const keys = Object.keys(first);
  const has = (...names: string[]) => names.some((n) => keys.includes(n));
  if (has('postSlug', 'post_slug') && has('authorName', 'author_name')) return 'zero';
  // msg 只有 Twikoo 用，必须排在 Waline 前面：Twikoo 的 nick + mail + status 三个键齐全，
  // 会被下一条 Waline 规则抢走，识别成 Waline 后 dry-run 面板上的来源就写错了。
  if (has('msg')) return 'twikoo';
  if (has('articleId', 'objectId') || (has('nick') && has('mail') && has('status'))) return 'waline';
  if ((has('_id') && has('url') && (has('comment') || has('mail'))) || (has('url') && has('nick') && has('admin'))) return 'twikoo';
  if (has('page_id', 'pageId') || (has('content') && has('nick') && has('ua'))) return 'artalk';
  if (has('database_id', 'databaseId') || (has('body') && (has('created_at', 'createdAt') || has('author')))) return 'giscus';
  if (has('article_path') || has('user_name')) return 'commentbox';
  if (has('comment', 'content', 'body', 'text') && has('url', 'path', 'slug')) return 'generic';
  return 'generic';
}

/* -------------------------------------------------------------------- 归一 */

interface Raw {
  o: Record<string, unknown>;
  legacyId: string;
  slug: string;
  content: string;
  name: string;
  email: string;
  link: string;
  ua: string;
  status: string;
  createdAt: number;
  parentLegacy: string;
}

/**
 * 把一条各系统的记录摊平成通用形状。
 * 正文字段名最多：comment / msg / content / body / text / markdown；
 * 位置字段名也多：url / pathname / path / slug / page_url / articleId / url_for。
 */
function flatten(o: Record<string, unknown>): Raw {
  const content = pickStr(o, ['comment', 'msg', 'content', 'body', 'text', 'markdown', 'html', 'description']);
  const createdAt =
    toUnix(pick(o, ['createdAt', 'created_at', 'timestamp', 'time', 'date', 'insertTime', 'insert_time', 'created'])) ??
    Math.floor(Date.now() / 1000);
  const legacy = pickStr(o, ['_id', 'id', 'objectId', 'oid', 'legacyId', 'legacy_id']);
  const emailRaw = pickStr(o, ['mail', 'email', 'authorEmail', 'author_email']);
  const ua = pickStr(o, ['ua', 'userAgent', 'user_agent', 'agent', 'browserAgent']);
  // 候选键里不含 link：Waline / Twikoo 的 link 是评论者自己的网站，不是文章地址。
  // 单独的「/」按没填处理 —— 站外链接被解析成 pathname "/" 会伪装成首页评论。
  const slugRaw = normSlug(pickStr(o, ['url', 'pathname', 'path', 'slug', 'page_url', 'pageUrl', 'url_for', 'urlFor', 'articleId', 'article_path', 'articlePath', 'page_key', 'pageKey', 'postSlug', 'post_slug', 'permalink']));
  // 有些导出没有独立的地址字段，objectId 本身就是文章路径（Waline 的 /posts/x/、Giscus 的 pathname）。
  // 只有长得像路径（含斜杠）才拿来兜底，否则会把数字 id 当成 slug 建出一堆假页面。
  const idish = pickStr(o, ['objectId', 'oid', 'id']);
  const slug = slugRaw || (idish.includes('/') ? idish : '');
  // Giscus 的作者是对象：{ login: '…' }
  const authorName = pickStr(rec(o.author), ['login', 'name']);
  return {
    o,
    legacyId: legacy,
    slug: slug === '/' ? '' : slug,
    content,
    name:
      pickStr(o, ['nick', 'name', 'author', 'authorName', 'author_name', 'user_name', 'userName', 'displayName', 'display_name', 'login', 'from']) ||
      authorName ||
      '访客',
    email: isEmail(emailRaw) ? emailRaw.toLowerCase() : '',
    link: pickStr(o, ['link', 'website', 'site', 'url_site', 'homepage']),
    ua,
    status: mapStatus(pick(o, ['status', 'state', 'isDeleted', 'hidden', 'approved']), 'approved'),
    createdAt,
    parentLegacy: pickStr(o, ['parent', 'parentId', 'parent_id', 'replyTo', 'reply_to', 'pid']),
  };
}

export interface ImportOptions {
  /** 指定格式；'generic' 或留空表示自动识别 */
  format?: CommentFormat | '';
  /** 强制覆盖入库状态（默认按导出里的状态映射） */
  status?: 'approved' | 'pending' | 'spam' | 'keep';
  /** 同一个 legacyId 已在库里时跳过（默认 true），避免重复导入 */
  skipExisting?: boolean;
  /**
   * 导出里逐条都没带文章地址时统一用这个（Giscus 是按 discussion 导出的，
   * 一份文件里只有正文和作者，页面地址得由导入者补上）。
   */
  defaultSlug?: string;
}

/**
 * 生成导入计划（不写库）。
 * 嵌套关系在这里重建：先给每条分配新 id，再按 legacyId → 新 id 的映射接 parent/root，
 * 父条没被导入（被跳过或本就不在这份导出里）就当顶层评论处理。
 */
export async function planCommentImport(env: Env, payload: unknown, opts: ImportOptions = {}): Promise<ImportPlan> {
  const format = opts.format && opts.format !== 'generic' ? opts.format : detectCommentFormat(payload);
  const list = extractList(payload);
  const skipped: { reason: string; count: number }[] = [];
  const bumpSkip = (reason: string, count = 1) => {
    const hit = skipped.find((s) => s.reason === reason);
    if (hit) hit.count += count;
    else skipped.push({ reason, count });
  };

  if (!list.length) {
    return {
      format,
      total: 0,
      rows: [],
      skipped: [{ reason: '没找到评论条目：期望是数组，或带 comments / data / tables.comments 的对象', count: 1 }],
      slugs: [],
      notice: null,
    };
  }

  const flat = list.map(flatten);
  const fallback = opts.defaultSlug ? normSlug(opts.defaultSlug) : '';
  if (fallback) for (const f of flat) if (!f.slug) f.slug = fallback;
  const wanted = flat.filter((f) => {
    if (!f.content) {
      bumpSkip('正文为空');
      return false;
    }
    if (!f.slug) {
      bumpSkip('缺文章地址（url / path / articleId 都没有）');
      return false;
    }
    return true;
  });

  // 已导入过的同一份导出，按 legacyId 去重
  let keep = wanted;
  if (opts.skipExisting !== false) {
    const legacyIds = wanted.map((f) => f.legacyId).filter(Boolean);
    if (legacyIds.length) {
      const db = createDb(env);
      const existing = await db
        .select({ legacyId: comments.legacyId })
        .from(comments)
        .where(sql`${comments.legacyId} is not null`)
        .limit(200_000);
      const has = new Set(existing.map((r) => r.legacyId).filter(Boolean) as string[]);
      const hitSet = new Set(legacyIds.filter((id) => has.has(id)));
      if (hitSet.size) bumpSkip('库里已有同样的 legacyId（重复导入）', hitSet.size);
      keep = wanted.filter((f) => !f.legacyId || !hitSet.has(f.legacyId));
    }
  }

  const byLegacy = new Map<string, string>();
  const assigned = keep.map((f) => {
    const id = newId();
    if (f.legacyId) byLegacy.set(f.legacyId, id);
    return { f, id };
  });

  const rows: ImportRow[] = assigned.map(({ f, id }) => {
    const parentId = f.parentLegacy ? byLegacy.get(f.parentLegacy) ?? null : null;
    // 六层与主题显示口径一致，超出的挂到第六层下面，不再加深
    const depth = parentId ? Math.min(ancestorDepth(parentId, assigned, byLegacy) + 1, 6) : 1;
    const rootId = parentId ? (findRoot(parentId, assigned, byLegacy) ?? null) : id;
    const status = opts.status && opts.status !== 'keep' ? opts.status : f.status;
    return {
      id,
      postSlug: f.slug,
      parentId,
      depth,
      rootId: depth === 1 ? id : rootId,
      authorName: f.name.slice(0, 64),
      authorEmail: f.email || null,
      authorLink: f.link.slice(0, 300) || null,
      content: f.content,
      status,
      userAgent: f.ua.slice(0, 300) || null,
      ipHash: null,
      browser: null,
      os: null,
      device: null,
      isLegacy: true,
      legacyId: f.legacyId || null,
      createdAt: f.createdAt,
      updatedAt: f.createdAt,
    };
  });

  const slugCount = new Map<string, number>();
  for (const r of rows) slugCount.set(r.postSlug, (slugCount.get(r.postSlug) ?? 0) + 1);
  const slugs = [...slugCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([slug, count]) => ({ slug, count }));

  const notices: string[] = [];
  if (format === 'generic') notices.push('没认出具体是哪个系统的导出，按通用字段名尽量取了值；请先看 dry-run 的条数和 slug 对不对');
  if (rows.some((r) => r.isLegacy && r.legacyId === null)) notices.push('有几条没有原始 id，重复导入这份文件时会再插一遍');
  const noEmail = rows.filter((r) => !r.authorEmail).length;
  if (noEmail) notices.push(`${noEmail} 条没有邮箱，导入后头像与「我的评论」认领不了`);

  return { format, total: list.length, rows, skipped, slugs, notice: notices.join('；') || null };
}

/** 父亲那条自己的层数：顶层算 1，它回复过别人的就往上数 */
function ancestorDepth(
  parentId: string,
  assigned: { f: Raw; id: string }[],
  byLegacy: Map<string, string>,
): number {
  let depth = 0;
  let currentId: string | null = parentId;
  const byId = new Map(assigned.map((a) => [a.id, a.f]));
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const f = byId.get(currentId);
    if (!f) break;
    depth++;
    currentId = f.parentLegacy ? byLegacy.get(f.parentLegacy) ?? null : null;
  }
  return depth;
}

function findRoot(
  parentId: string,
  assigned: { f: Raw; id: string }[],
  byLegacy: Map<string, string>,
): string | null {
  const byId = new Map(assigned.map((a) => [a.id, a]));
  let current: string | null = parentId;
  const seen = new Set<string>();
  let root: string | null = parentId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const hit = byId.get(current);
    if (!hit) break;
    const nextParent = hit.f.parentLegacy ? byLegacy.get(hit.f.parentLegacy) ?? null : null;
    if (!nextParent) {
      root = current;
      break;
    }
    current = nextParent;
  }
  return root;
}

/* -------------------------------------------------------------------- 写库 */

export interface ImportResult {
  inserted: number;
  skipped: number;
  slugs: number;
}

/** 计划落库：整份导入包在一条批次里，逐条插入（D1 没有事务给后台用，量不大够用） */
export async function applyCommentImport(env: Env, plan: ImportPlan): Promise<ImportResult> {
  const db = createDb(env);
  let inserted = 0;
  for (const row of plan.rows) {
    try {
      await db.insert(comments).values({
        ...row,
        authorType: 'commenter',
        authorId: null,
        spamScore: null,
        spamReason: null,
        country: null,
        city: null,
        pinned: false,
        featured: false,
        ownerKey: null,
        editedAt: null,
      });
      inserted++;
      // 访客资料留档，和 /api/comments 正常发评论时同一张表；已存在的邮箱不重复插
      if (row.authorEmail) {
        const seen = await db
          .select({ id: commenters.id })
          .from(commenters)
          .where(and(eq(commenters.email, row.authorEmail)))
          .limit(1);
        if (!seen.length) {
          await db.insert(commenters).values({
            id: newId(),
            name: row.authorName,
            email: row.authorEmail,
            emailMd5: emailMd5(row.authorEmail),
            link: row.authorLink,
            createdAt: row.createdAt,
          });
        }
      }
    } catch {
      /* 单条坏了不终止整份导入，最后的计数里体现为少插了一条 */
    }
  }
  return { inserted, skipped: plan.rows.length - inserted, slugs: plan.slugs.length };
}

/** dry-run 摘要，后台面板直接显示这几行 */
export function planSummary(plan: ImportPlan, applied?: ImportResult): string {
  const parts = [`识别为 ${plan.format}`, `读出 ${plan.rows.length} 条`];
  if (plan.skipped.length) parts.push(`跳过 ${plan.skipped.reduce((a, b) => a + b.count, 0)} 条`);
  parts.push(`涉及 ${new Set(plan.rows.map((r) => r.postSlug)).size} 篇文章`);
  if (applied) parts.push(`实际写入 ${applied.inserted} 条`);
  return parts.join('，');
}

