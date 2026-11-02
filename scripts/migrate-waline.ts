import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonSlug } from '../packages/api/src/lib/slug.js';
import { API_DIR, D1_NAME, ROOT, die, good, info, parseJson, step, wrangler } from './_util.js';

/**
 * Waline / Twikoo 导出 → zero D1 评论表
 *
 *   pnpm migrate:waline -- --from=scripts/waline-export.json
 *   pnpm migrate:waline -- --from=scripts/twikoo-export.json --apply=remote
 *
 * 默认只生成 scripts/converted-comments.sql（已被 .gitignore 排除），
 * 加 --apply=local|remote 才真正写入 D1。SQL 用 INSERT OR IGNORE + 由旧 id
 * 派生的确定性主键，重复执行不会产生副本。
 */

const OUT_SQL = resolve(ROOT, 'scripts/converted-comments.sql');
const DEFAULT_MAX_DEPTH = 6;

type Status = 'approved' | 'pending' | 'spam';

interface RawComment {
  legacyId: string;
  slugRaw: string;
  parentRaw: string | null;
  name: string;
  email: string | null;
  link: string | null;
  content: string;
  status: Status;
  createdAt: number;
  updatedAt: number;
  ip: string | null;
  userAgent: string | null;
}

interface OutComment extends RawComment {
  id: string;
  parentId: string | null;
  rootId: string | null;
  depth: number;
  postSlug: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
}

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

/* --------------------------- 解析 --------------------------- */

const toNumber = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
};

/** 时间戳来源不一：秒、毫秒、ISO 字符串都可能出现 */
function toUnix(v: unknown, fallback: number): number {
  const n = toNumber(v);
  if (n == null) return fallback;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number') return String(v);
  return null;
}

/** 只取 pathname：查询串与锚点会让同一篇文章出现多个 slug */
function pathOf(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!s || s === 'undefined' || s === 'null') return null;
  try {
    if (/^https?:\/\//i.test(s)) return new URL(s).pathname;
  } catch {
    return null;
  }
  return s.split(/[?#]/)[0] ?? null;
}

function looksLikePath(v: string | null): boolean {
  return !!v && (v.startsWith('/') || /\.[a-z]{2,5}$/i.test(v));
}

type Format = 'waline' | 'twikoo';

function detectFormat(rows: Record<string, unknown>[]): Format | null {
  const keys = new Set(rows.flatMap((r) => Object.keys(r)));
  if (keys.has('insertedAt') || keys.has('mailMd5') || keys.has('children') || keys.has('type')) return 'waline';
  if (keys.has('_userAgent') || keys.has('isSpam') || keys.has('adminFlag') || keys.has('hideContent')) return 'twikoo';
  return null;
}

function normalize(rows: Record<string, unknown>[], format: Format, slugField: string) {
  const out: RawComment[] = [];
  let skipped = 0;
  let empty = 0;
  for (const r of rows) {
    if (format === 'waline' && str(r.type) && str(r.type) !== 'COMMENT') {
      skipped++;
      continue;
    }
    const legacyId = str(r._id) ?? str(r.id) ?? str(r.oid);
    const fromPost = pathOf(str(r.post));
    const fromUrl = pathOf(str(r.url)) ?? pathOf(str(r.pathname));
    const slugRaw =
      slugField === 'post' ? (fromPost ?? fromUrl ?? '') : slugField === 'url' ? (fromUrl ?? fromPost ?? '') : ((looksLikePath(fromPost) ? fromPost : fromUrl) ?? fromPost ?? fromUrl ?? '');
    if (!legacyId || !slugRaw) {
      skipped++;
      continue;
    }
    const content = str(r.text) ?? str(r.content) ?? '';
    if (content.trim() === '') {
      empty++;
      continue;
    }
    const rawStatus = str(r.status)?.toLowerCase() ?? null;
    const status: Status =
      r.isSpam === true || rawStatus === 'spam'
        ? 'spam'
        : rawStatus === 'waiting' || rawStatus === 'pending' || rawStatus === 'verify'
          ? 'pending'
          : 'approved';
    const created = toUnix(r.createdAt ?? r.insertedAt ?? r.created ?? r.updated, Math.floor(Date.now() / 1000));
    out.push({
      legacyId,
      slugRaw,
      parentRaw: str(r.parent) ?? str(r.parentId),
      name: str(r.nick) ?? str(r._userNick) ?? str(r.name) ?? '匿名',
      email: str(r.mail) ?? str(r._userMail),
      link: str(r.link),
      content,
      status,
      createdAt: created,
      updatedAt: toUnix(r.updatedAt ?? r.updated, created),
      ip: str(r.ip),
      userAgent: str(r.agent) ?? str(r._userAgent) ?? str(r.ua),
    });
  }
  return { comments: out, skipped, empty };
}

/* --------------------------- 建树 --------------------------- */

/** 旧 id 派生稳定 uuid，保证同一份导出重复导入得到同一批主键 */
function newIdFrom(legacyId: string): string {
  const h = createHash('md5').update(`zero-legacy:${legacyId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function buildTree(rows: RawComment[], maxDepth: number) {
  const unique = new Map(rows.map((r) => [r.legacyId, r]));
  let orphans = 0;
  let clamped = 0;
  let cycles = 0;

  const list: OutComment[] = [...unique.values()].map((row) => {
    // 向上回溯祖先链：root 在前。父记录不在导出里或成环时，就只能挂到已解析出的最高层祖先
    const chain: RawComment[] = [];
    const seen = new Set([row.legacyId]);
    let cur = row;
    let cyclic = false;
    while (cur.parentRaw) {
      const parent = unique.get(cur.parentRaw);
      if (!parent) {
        orphans++;
        break;
      }
      if (seen.has(parent.legacyId)) {
        // 环形引用只能截断：整条链作废，本条降为顶层，否则父子互相引用会卡住插入顺序
        cycles++;
        cyclic = true;
        break;
      }
      seen.add(parent.legacyId);
      chain.push(parent);
      cur = parent;
    }
    const ancestors = cyclic ? [] : chain.reverse();
    if (!ancestors.length) {
      return { ...row, id: newIdFrom(row.legacyId), parentId: null, rootId: null, depth: 1, postSlug: canonSlug(row.slugRaw) };
    }
    // 祖先 ancestors[i] 的深度是 i+1，本条深度即 i+2
    const idx = Math.min(ancestors.length - 1, maxDepth - 2);
    if (ancestors.length - 1 > maxDepth - 2) clamped++;
    return {
      ...row,
      id: newIdFrom(row.legacyId),
      parentId: newIdFrom(ancestors[idx]!.legacyId),
      rootId: newIdFrom(ancestors[0]!.legacyId),
      depth: idx + 2,
      postSlug: canonSlug(row.slugRaw),
    };
  });

  // D1 默认强制外键：父评论必须先于子评论插入
  list.sort((a, b) => a.depth - b.depth || a.createdAt - b.createdAt);
  return { list, orphans, clamped, cycles };
}

/* --------------------------- SQL --------------------------- */

function q(v: string | null): string {
  return v == null ? 'null' : `'${v.replace(/'/g, "''")}'`;
}

function toSql(list: OutComment[]): string {
  // 不包 BEGIN/COMMIT：wrangler d1 execute --local 会直接拒绝显式事务语句
  const head = `-- 由 scripts/migrate-waline.ts 生成，导入前请先备份
-- 用法：npx wrangler d1 execute ${D1_NAME} --remote --yes --file=<本文件路径>
`;
  const body = list
    .map((c) =>
      [
        'INSERT OR IGNORE INTO comments',
        // 列清单以「跑完全部迁移之后」的表为准：comments.ip 已被 0005_round2_drop_ip 删除，
        // 这里再写就会在最后一步 `d1 execute` 上撞 `table comments has no column named ip`。
        '(id, post_slug, parent_id, depth, root_id, author_type, author_id, author_name, author_email, author_link,',
        ' content, status, user_agent, is_legacy, legacy_id, created_at, updated_at)',
        'VALUES',
        `(${q(c.id)}, ${q(c.postSlug)}, ${q(c.parentId)}, ${c.depth}, ${q(c.rootId)}, 'commenter', null, ${q(c.name)}, ${q(c.email)}, ${q(c.link)},`,
        ` ${q(c.content)}, ${q(c.status)}, ${q(c.userAgent)}, 1, ${q(c.legacyId)}, ${c.createdAt}, ${c.updatedAt});`,
      ].join(' '),
    )
    .join('\n');
  return `${head}\n${body}\n`;
}

/* --------------------------- 主流程 --------------------------- */

function main(): void {
  const fromArg = arg('from');
  const candidates = [fromArg, 'scripts/waline-export.json', 'scripts/twikoo-export.json'].filter(
    (p): p is string => Boolean(p),
  );
  const source = candidates.map((p) => resolve(ROOT, p)).find((p) => existsSync(p));
  if (!source) {
    die(
      `找不到导出文件。先从 Waline / Twikoo 管理端导出评论 JSON，保存到 scripts/waline-export.json 或 scripts/twikoo-export.json，` +
        `或用 --from=<路径> 指定。`,
    );
  }

  const parsed = JSON.parse(readFileSync(source, 'utf-8')) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : ((parsed as { data?: unknown[] }).data ?? [])) as Record<string, unknown>[];
  if (!Array.isArray(rows) || rows.length === 0) die(`${source} 里没有解析出任何评论记录`);

  const format = detectFormat(rows) ?? (has('twikoo') ? 'twikoo' : 'waline');
  const maxDepth = Number(arg('max-depth', String(DEFAULT_MAX_DEPTH)) ?? DEFAULT_MAX_DEPTH);
  const slugField = arg('slug-field', 'auto') as 'auto' | 'post' | 'url';

  step(`读取 ${source}`);
  info(`格式判定：${format}${has('twikoo') || has('waline') ? '（已用参数指定）' : ''}，原始记录 ${rows.length} 条`);

  const { comments, skipped, empty } = normalize(rows, format, slugField);
  const { list, orphans, clamped, cycles } = buildTree(comments, maxDepth);
  const byStatus = list.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {});
  const slugs = new Map<string, number>();
  for (const c of list) slugs.set(c.postSlug, (slugs.get(c.postSlug) ?? 0) + 1);

  step('转换结果');
  info(`入库评论：${list.length} 条（approved ${byStatus.approved ?? 0}，pending ${byStatus.pending ?? 0}，spam ${byStatus.spam ?? 0}）`);
  info(`丢弃：非评论记录/缺 id 或缺文章 ${skipped} 条，正文为空 ${empty} 条`);
  info(`嵌套层数上限 ${maxDepth}：被上提 ${clamped} 条，父记录缺失或成环 ${orphans + cycles} 条`);
  info(`涉及文章 ${slugs.size} 篇：`);
  for (const [slug, n] of [...slugs].sort((a, b) => b[1] - a[1]).slice(0, 15)) info(`  ${n}\t${slug}`);
  if (slugs.size > 15) info(`  …另有 ${slugs.size - 15} 篇`);

  writeFileSync(OUT_SQL, toSql(list));
  good(`已生成 ${OUT_SQL}`);

  const apply = arg('apply');
  if (!apply) {
    console.log('\n下一步（确认无误后执行）：');
    console.log(`  npx wrangler d1 execute ${D1_NAME} --local --yes --file=${OUT_SQL}`);
    console.log(`  npx wrangler d1 execute ${D1_NAME} --remote --yes --file=${OUT_SQL}`);
    console.log('或直接加参数：pnpm migrate:waline -- --apply=remote');
    return;
  }
  if (apply !== 'local' && apply !== 'remote') die('--apply 只能是 local 或 remote');

  step(`导入 D1（${apply}）`);
  try {
    wrangler(`d1 execute ${D1_NAME} --${apply} --yes --file="${OUT_SQL}"`, { cwd: API_DIR, capture: true });
  } catch (e) {
    // 原来这里直接把整段 node 堆栈与退出码抛出来，而「✓ 已生成 SQL」刚打印完，
    // 看起来像脚本坏了。把 wrangler 真正的那行 SQL 错误提到第一行，人一眼就知道改哪。
    const text = String((e as Error)?.message ?? e);
    const first = text.split('\n').find((l) => /ERROR|SQLITE_|no such|failed/i.test(l)) ?? '';
    die(`写入 D1 失败（${apply}）：${first.trim() || text.split('\n')[0] || '未知错误'}\nSQL 文件留在 ${OUT_SQL}，可自己打开核对或改完重跑。`);
  }
  const check = wrangler(
    `d1 execute ${D1_NAME} --${apply} --json --command "SELECT COUNT(*) AS n FROM comments WHERE is_legacy = 1"`,
    { cwd: API_DIR, capture: true },
  );
  const counted = parseJson<Array<{ results: Array<{ n: number }> }>>(check)?.[0]?.results?.[0]?.n;
  good(`库内历史评论总数：${counted ?? check}`);
  info('请在后台「评论」页抽查层级与头像显示，再停用旧的 Waline / Twikoo 服务。');
}

main();
