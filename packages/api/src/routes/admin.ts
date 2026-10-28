import { Hono } from 'hono';
import { kvDelete, kvGet, kvPut } from '../services/kv-cache';
import { and, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../db/client';
import { comments, emailLogs, jobRuns, reactions, subscribers, users, visits } from '../db/schema';
import { getAllConfig, getConfig, apiBase, isConfigKey, isSecretKey, maskSecrets, numericKeyBadValue, enumKeyBadValue, jsonKeyBadValue, lengthKeyBadValue, textKeyMaxLen, ALL_CONFIG_KEYS, ENUM_CONFIG_KEYS, setConfig, type ConfigKey } from '../services/config';
import { emailOtpAvailable, LOGIN_POLICIES } from '../services/account-shared';
import { ensureAdminAuthorIdentity } from '../services/admin-author';
import { avatarForEmail, emailMd5 } from '../lib/avatar';
import { listAudit, writeAudit } from '../services/audit';
import {
  AUTHORS_FILE_DEFAULT,
  authorsFilePath,
  getAuthorsFile,
  parseAuthorsYaml,
  putAuthorsFile,
  readAuthorProfile,
  resolveAuthorHandle,
  siteAuthorName,
  upsertAuthor,
  validateAuthorsYaml,
} from '../services/authors';
import { deleteCommentSubtree } from '../services/comment-tree';
import { notifySelfTest, quotedCommentHtml } from '../services/comment-notify';
import { contentTitles, purgeContentTitleCache } from '../services/content-title';
import { linksFilePath } from '../services/friends-file';
import { setSiteDefaultAuthor, writeSwitchSnapshot, syncCommentCsp } from './frontend';
import { purgePageUrls } from '../services/cf-purge';
import { inspectComment, invalidatePatternFile, DEFAULT_SPAM_PATTERN_TEXT, SPAM_PATTERN_FILE, resetPatternCache } from '../services/moderation';
import { clientIp, ipFallbackCount } from '../lib/http';
import { datedSlug } from '../lib/postName';
import { errorMessage, fail, ok } from '../lib/errors';
import { requireAdmin } from '../middleware/auth';
import { recountLifetimeCounters } from '../services/stats';
import { deleteFile, listDir, readFile } from '../services/git';
import { finishRepoWrites, repoTarget, triggerPagesBuild, buildReceipt } from '../services/git';
import { buildHealthReceipt, commitRepoFiles, listRepoDir, pruneLocalBuild, readRepoFile, repoBackend, runLocalBuildCheck, walkFiles, writeRepoFile } from '../services/repo';
import { checkRepoFileSyntax } from '../services/repo-syntax';
import { listBuckets, maskBucket, resolveBucket, putMediaObject, listMediaObjects, getMediaObject, mediaObjectExists, deleteMediaObject, objectPath, checkUploadType, type MediaBucket } from '../services/media';
import { isVariantKey, isValidOriginKey, isValidVariantObjectKey, deleteVariantsOf, mergeVariantEntry, readVariantsManifest, removeVariantEntry } from '../services/media-variants';
import { checkHugoDates, checkMediaKey, checkUploadBytes } from '../services/hugo-guard';
import { resolveSiteName } from '../services/site-name';
import {
  buildMarkdown,
  contentWebPath,
  excerpt,
  frontTitle,
  futureFrontDate,
  orderFront,
  parseFrontMatter,
  postWebPath,
  postsDir,
  type Front,
  type ParsedMarkdown,
  type RepoEntry,
} from '../services/frontmatter';
import { createBroadcastJob, postEmailUrl, runBroadcastJob } from '../services/broadcast';
import {
  createFriend,
  deleteFriend,
  groupFriendsDetail,
  loadFriends,
  reorderFriends,
  updateFriend,
} from '../services/friends-groups';
import { DEFAULT_TEMPLATES, TEMPLATE_LABELS, TEMPLATE_VARS, queueEmail, renderEmail, sendEmail } from '../services/email';
import { pushNewPostsToSubscribers } from '../services/feed-push';
import { exportPostStats, JOB_LABELS } from '../services/scheduler';
import { newId } from '../lib/crypto';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

/* ---------------- 配置 ---------------- */

app.get('/config', async (c) => {
  const all = await getAllConfig(c.env);
  const { data, hasSecret } = maskSecrets(all);
  // 库里可能留着已下线的策略值（比如早先的 'totp'），登录时实际退回单密码；
  // 读取时按同一个口径归一，后台下拉框显示的才是真正生效的那一种
  if (!POLICY_VALUES.includes(String(data.adminLoginPolicy))) {
    data.adminLoginPolicy = 'password';
  }
  /* 上限跟写入闸门（lengthKeyBadValue）读同一张表：后台输入框拿它当 maxlength，
     界面「能输多少」和保存「允许多少」就永远是同一个数，不会出现前端放行、后端 400。 */
  const maxLen = Object.fromEntries(ALL_CONFIG_KEYS.map((k) => [k, textKeyMaxLen(k)]));
  return Response.json({ data, hasSecret, maxLen });
});

const configWriteSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/** 登录策略以 LOGIN_POLICIES 为唯一口径：写错值会静默退回单密码，必须在入口就拦住 */
const POLICY_VALUES: string[] = LOGIN_POLICIES;

/** 仪表盘数文章/时刻时的上限：超过就标 capped，避免有人把整站仓库塞满文件后开一次后台烧光 D1/GitHub 额度 */
const CONTENT_COUNT_CAP = 2000;

app.patch('/config', async (c) => {
  const admin = requireAdmin(c);
  const parsed = configWriteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '配置格式有误');
  if (parsed.data.adminLoginPolicy !== undefined && !POLICY_VALUES.includes(String(parsed.data.adminLoginPolicy))) {
    fail(400, `登录方式只能是这些之一：${POLICY_VALUES.join(' / ')}`);
  }

  /*
   * 先把整份请求校验完、再开始写。以前是「边校验边写」：未知键排在中间时，它前面那几项
   * 已经落库了，接口却回 400「未知配置项」，后台显示「N 项未保存」—— 人和程序都说不清
   * 现在到底是什么状态。null 只给密钥用，表示「把已存的那份清掉」；
   * 留空字符串对密钥的含义是「不改」（密钥读取恒回空串，原样提交不能抹掉密码）。
   */
  const writes: { key: ConfigKey; value: string; valueType: string }[] = [];
  for (const [raw, value] of Object.entries(parsed.data)) {
    if (!isConfigKey(raw)) fail(400, `未知配置项 ${raw}`);
    const key = raw as ConfigKey;
    if (value === null) {
      if (!isSecretKey(key)) fail(400, `${key} 不是密钥项，不能用 null 清除：请填新值（清空就填 ""）`);
      writes.push({ key, value: '', valueType: 'string' });
      continue;
    }
    if (isSecretKey(key) && value === '') continue;
    const asText = typeof value === 'string' ? value : JSON.stringify(value);
    /** 数字键先在这儿拦住（整批不写）：让它落库就等于「存了但没用」，读的时候解析失败默默回落默认值 */
    if (numericKeyBadValue(key, asText)) fail(400, `${key} 只能填数字（现在送的是「${asText}」），留空表示用默认值`);
    /** 枚举键先在这儿拦住：存进去一个代码不认识的值，比直接报错难查得多（评论那两项会静默换掉整站评论区） */
    const enumBad = enumKeyBadValue(key, asText);
    if (enumBad) fail(400, enumBad);
    /** JSON 键同理：坏 JSON 不报错、只是让后台配的参数整组静默失效，那更查不动 */
    const jsonBad = jsonKeyBadValue(key, asText);
    if (jsonBad) fail(400, jsonBad);
    /** 文本键看长度：这些值是原样拼进 `<title>` / JSON-LD / 邮件里的，超上限等于全站显示事故 */
    const tooLong = lengthKeyBadValue(key, asText);
    if (tooLong) fail(400, tooLong);
    /** 枚举键统一按小写存：接口送 'SMTP' 也要归成 'smtp' —— 分流处（发信按通道、主题按 provider）认的是小写值 */
    const stored = ENUM_CONFIG_KEYS[key] && typeof value === 'string' ? asText.trim().toLowerCase() : asText;
    writes.push({
      key,
      value: stored,
      valueType: typeof value === 'string' ? 'string' : typeof value,
    });
  }

  const changed: { key: string; from: string; to: string }[] = [];
  const failed: { key: string; error: string }[] = [];
  for (const w of writes) {
    const before = (await getConfig(c.env, w.key)) ?? '';
    if (before === w.value) continue;
    try {
      await setConfig(c.env, w.key, w.value, w.valueType);
    } catch (e) {
      failed.push({ key: w.key, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    /* 流水里绝不落密钥原文（审计表既不加密也不导出，抄一份密码进去等于多一处泄露面）。
       界面上也要看得见「这次动过哪条凭据」，所以只留「有没有值」这一档信息。 */
    if (isSecretKey(w.key)) {
      changed.push({ key: w.key, from: before ? '（原有，值不记录）' : '（原本为空）', to: w.value ? '（已写入新值，值不记录）' : '（已清除）' });
      continue;
    }
    changed.push({ key: w.key, from: before, to: w.value });
  }

  await writeAudit(c.env, {
    actor: admin,
    action: 'config',
    target: changed.map((x) => x.key).join(','),
    detail: { event: 'patch', changed, failed },
    ip: clientIp(c),
  });

  /* 动过任何 *Enabled 开关就顺手把快照烘进站点的 data/switches.json：
     主题首屏靠它决定区块露不露，不必再等 /api/config（线上实测那次调用串在 LCP 关键路径上 4.8 秒）。
     写不进仓库不影响设置本身已经生效 —— 运行期那一路照旧，所以这里只报状态，绝不把整次保存说成失败。 */
  let switchSnapshot: { written: boolean; path?: string; keys?: number; error?: string } | undefined;
  if (changed.some((x) => /Enabled$/.test(x.key))) switchSnapshot = await writeSwitchSnapshot(c.env);

  /* 动过评论区用哪家、或那家的参数 → 把它的接口域补进 CSP 的那两份文件。
     不补的现场是：切到 waline/artalk/twikoo 后脚本样式都进得来，唯独它们自己的请求被
     connect-src 拦掉，评论区一直转圈而页面照常出（见 services/csp-connect.ts 的说明）。
     写不进仓库不影响「设置已生效」这件事，所以同样只报状态，绝不把整次保存说成失败。 */
  const touchedComment = changed.some((x) => x.key === 'commentProvider' || x.key === 'momentCommentProvider' || x.key === 'commentProviders');
  const cspSync = touchedComment ? await syncCommentCsp(c.env, admin, clientIp(c)) : undefined;

  /* 写失败要说成写失败：以前整批只在最后 ok，中间某条 D1 出错时界面照样显示「已保存」 */
  return ok({ updated: changed.length, keys: changed.map((x) => x.key), changed, failed, switchSnapshot, cspSync });
});

/* ---------------- 评论审核 ---------------- */

app.get('/comments', async (c) => {
  requireAdmin(c);
  const status = c.req.query('status') ?? 'pending';
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const rows = await createDb(c.env)
    .select()
    .from(comments)
    .where(status === 'all' ? undefined : eq(comments.status, status))
    .orderBy(desc(comments.createdAt))
    .limit(500);
  const filtered = q
    ? rows.filter(
        (r) =>
          r.content.toLowerCase().includes(q) ||
          r.authorName.toLowerCase().includes(q) ||
          (r.authorEmail ?? '').toLowerCase().includes(q) ||
          (r.spamReason ?? '').toLowerCase().includes(q),
      )
    : rows;
  /* 顺手把文章标题带上：审核时只看到 `/posts/20261025002/` 认不出是哪篇（站长的文件名就是日期串）。
     标题走 services/content-title 那份 24 小时缓存，认不到留空，界面自己回落到地址。 */
  const titles = await contentTitles(c.env, filtered.map((r) => r.postSlug));
  return ok(filtered.map((r) => ({ ...r, postTitle: titles.get(r.postSlug) ?? '' })));
});

app.post('/comments/:id/moderate', async (c) => {
  const admin = requireAdmin(c);
  const body = (await c.req.json().catch(() => null)) as { action?: string } | null;
  const action = body?.action;
  if (action !== 'approve' && action !== 'reject' && action !== 'spam') fail(400, 'action 需为 approve / reject / spam');
  const db = createDb(c.env);
  const id = c.req.param('id');
  const target = await db.select({ id: comments.id, status: comments.status }).from(comments).where(eq(comments.id, id)).limit(1);
  const row = target[0];
  if (!row) fail(404, '评论不存在');
  if (action === 'reject') {
    const removed = await deleteCommentSubtree(c.env, id);
    await writeAudit(c.env, {
      actor: admin,
      action: 'comment',
      target: id,
      detail: { from: row.status, to: 'deleted', removed },
      ip: clientIp(c),
    });
    return ok({ id, removed: true, deletedCount: removed });
  }
  const next = action === 'approve' ? 'approved' : 'spam';
  await db.update(comments).set({ status: next }).where(eq(comments.id, id));
  await writeAudit(c.env, {
    actor: admin,
    action: 'comment',
    target: id,
    detail: { from: row.status, to: next },
    ip: clientIp(c),
  });
  return ok({ id, status: next });
});

/** 批量处理审核队列，一次点击清掉一天的垃圾评论 */
app.post('/comments/moderate-batch', async (c) => {
  const admin = requireAdmin(c);
  const parsed = z
    .object({ ids: z.array(z.string().max(64)).max(200), action: z.enum(['approve', 'spam']) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '参数有误：action 只能是 approve / spam，一次最多 200 条');
  if (!parsed.data.ids.length) fail(400, '没有要处理的评论');
  const env = c.env;
  const ids = parsed.data.ids;
  const next = parsed.data.action === 'approve' ? 'approved' : 'spam';
  const db = createDb(env);
  /* 一次 UPDATE 而不是一 id 一条：D1 免费写入额度经不起 200 条一次点，而且批量语句的
     meta.changes 才是「真的改了几条」——传进来的 id 里有早已被删掉的，逐条循环时
     接口照样回 handled:200，等于谎报。 */
  const run = await db
    .update(comments)
    .set({ status: next })
    .where(and(inArray(comments.id, ids), ne(comments.status, next)))
    .run();
  const handled = Number((run?.meta as { changes?: number } | undefined)?.changes ?? 0);
  await writeAudit(c.env, {
    actor: admin,
    action: 'comment',
    target: `${ids.length} 条`,
    detail: { action: parsed.data.action, requested: ids.length, handled, ids: ids.slice(0, 50) },
    ip: clientIp(c),
  });
  return ok({ requested: ids.length, handled, status: next });
});

/** 用当前规则试跑一段文本，不入库：后台调阈值时用 */
app.post('/spam/probe', async (c) => {
  requireAdmin(c);
  const parsed = z
    .object({
      content: z.string().min(1).max(5000),
      authorName: z.string().max(64).optional(),
      authorEmail: z.string().max(200).optional(),
      authorLink: z.string().max(300).optional(),
      /** 临时覆盖服务商配置：站主不必先存盘再测 */
      providerKind: z.string().max(32).optional(),
      providerEndpoint: z.string().max(300).optional(),
      providerKeyId: z.string().max(300).optional(),
      providerSecret: z.string().max(300).optional(),
      /** 刚写完仓库规则文件就想立刻看效果 */
      refreshPatterns: z.boolean().optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '请填写要试跑的正文');
  const { content, authorName, authorEmail, authorLink, ...options } = parsed.data;
  const verdict = await inspectComment(
    c.env,
    {
      content,
      authorName: authorName ?? null,
      authorEmail: authorEmail ?? null,
      authorLink: authorLink ?? null,
    },
    options,
  );
  // verdict 自带 rules[]（source/pattern/label/weight）与 provider（kind/ok/label/raw/error）
  return ok(verdict);
});

/** 操作留痕：谁在什么时候改了什么（分页 + 总数，界面在「备份」页下面那一段） */
app.get('/audit', async (c) => {
  requireAdmin(c);
  const { rows, total, limit, offset } = await listAudit(c.env, {
    action: c.req.query('action') || undefined,
    from: Number(c.req.query('from')) || undefined,
    to: Number(c.req.query('to')) || undefined,
    limit: Number(c.req.query('limit')) || 100,
    offset: Number(c.req.query('offset')) || 0,
  });
  return ok({
    total,
    limit,
    offset,
    rows: rows.map((r) => ({
      id: r.id,
      actorName: r.actorName,
      action: r.action,
      target: r.target,
      detail: parseDetail(r.detail),
      ip: r.ip,
      createdAt: r.createdAt,
    })),
  });
});

/** 脏数据不该让整个审计列表 500 */
function parseDetail(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/* ---------------- 站点内容：提交回 Git ---------------- */

/** 群发邮件正文是拼出来的，先转义再进标签 */
function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

/**
 * 发布路径由文件名决定，这里只允许站点内容目录内的安全相对路径，
 * 避免后台被当成任意文件写入器。
 *
 * 中文站的真实文件名带全角标点（「数风流人物，还看今朝.md」）、空格、· 等，
 * 所以这里用黑名单而不是「只准这些字符」的白名单：挡掉目录穿越、控制字符与
 * 各平台保留字符即可，其余原样放行（Hugo 与 Git 都能处理，URL 会自动百分号编码）。
 */
const BAD_PATH_CHARS = /[\u0000-\u001f<>:"|?*]/;

/**
 * 校验并归一内容路径。**不抛**，返回错误说明或归一后的路径。
 * 批量写入必须走这一版：以前只有会抛的 safePath，于是一篇路径不合法就把整批打断，
 * 调用方只拿到一句「路径不合法」，不知道是二十篇里的哪一篇（台架 2026-10-25 F-06）。
 */
function validateContentPath(p: string): { path: string } | { error: string } {
  const clean = String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) return { error: '缺少文件路径' };
  const segs = clean.split('/');
  if (segs.some((seg) => seg === '' || seg === '.' || seg === '..')) return { error: '路径不合法（不许含空段、. 或 ..）' };
  if (segs[0] !== 'content') return { error: '只能写入 content/ 下的 .md 文件' };
  if (!clean.endsWith('.md') || clean === '.md') return { error: '只能写入 content/ 下的 .md 文件' };
  if (BAD_PATH_CHARS.test(clean)) return { error: '文件名含有系统保留字符，请去掉 : " < > | ? * 与控制字符' };
  if (segs[segs.length - 1]!.trim() === '.md') return { error: '文件名不能为空' };
  if (clean.length > 300) return { error: '路径过长（上限 300 字符）' };
  return { path: clean };
}

function safePath(p: string): string {
  const r = validateContentPath(p);
  if ('error' in r) fail(400, r.error);
  return (r as { path: string }).path;
}

/** content/zh/posts/xxx.md 这类才是文章；时刻（content/zh/moments/…）是朋友圈式动态，没有标题 */
function isPostPath(path: string): boolean {
  return /(^|\/)posts\//.test(path);
}

app.get('/content', async (c) => {
  requireAdmin(c);
  const dir = (c.req.query('path') ?? 'content').replace(/^\/+/, '');
  if (!dir.startsWith('content')) fail(400, '只能浏览 content/ 目录');
  const settings = await repoTarget(c.env);
  try {
    return ok(await listDir({ ...settings, path: dir }));
  } catch (e) {
    fail(502, e instanceof Error ? e.message : String(e));
  }
});

app.get('/content/file', async (c) => {
  requireAdmin(c);
  const path = safePath(c.req.query('path') ?? '');
  const settings = await repoTarget(c.env);
  try {
    const file = await readFile({ ...settings, path });
    if (!file) return ok({ exists: false, content: '', sha: '', front: {}, body: '' });
    const { front, body } = parseFrontMatter(file.content);
    return ok({ exists: true, content: file.content, sha: file.sha, front, body });
  } catch (e) {
    fail(502, e instanceof Error ? e.message : String(e));
  }
});

/* ---------------- 内容写回：单文件与批量共用 ---------------- */

interface ContentItem {
  path?: string;
  content?: string;
  front?: Record<string, unknown>;
  body?: string;
  message?: string;
  sha?: string;
  notifySubscribers?: boolean;
}

type ContentOutcome =
  | { ok: true; path: string; sha?: string; bytes: number; notify: NotifyResult; purgedBuild: string[]; futureDraft: string | null }
  | { ok: false; path: string; reason: 'invalid' | 'conflict' | 'failed'; error: string };

type NotifyResult = { jobId?: string; sent?: number; failed?: number; skipped?: string };

/** 将来日期被显式转成草稿后说给站主的那一句（回执与审计都用它） */
function futureDraftNote(from: string): string {
  return `发布时间（${from}）在将来，Hugo 只在构建时比对日期、这类页面不会生成；已按草稿保存，到时间后取消草稿再保存一次即可上线`;
}

/**
 * 这篇在本地构建产物里的位置：kind 是 public/ 下的一级目录，stem 是文件名（去扩展名）。
 * 只有文章与时刻有独立页面，其它 markdown（关于页等）不在清理范围内。
 */
function buildPageRef(path: string): { kind: string; stem: string } | null {
  const kind = /\/posts\//.test(path) ? 'posts' : /\/moments\//.test(path) ? 'moments' : '';
  const stem = (path.match(/([^/]+)\.mdx?$/i) ?? [])[1] ?? '';
  return kind && stem ? { kind, stem } : null;
}

function isDraftFront(front: Record<string, unknown>): boolean {
  return String(front.draft ?? '').toLowerCase() === 'true';
}

/**
 * 文章没写 author 就补上站长的作者标识（config 里的 defaultAuthor）。
 *
 * 为什么要由后端补：主题的顶部署名与底部作者框按这个键去 data/authors.yaml 找条目，
 * 而 `/author/<标识>/` 那一页只有 front matter 里**出现了这个键**才会生成。后台写作页
 * 存出去的稿子以前没有它，于是署名点不进作者页、作者框也只剩一个空壳（联系方式那排
 * 直接不渲染）。标识还没设过时不补，免得凭空造出一个不存在的作者页。
 */
async function withAuthorFallback(env: Env, path: string, front: Front): Promise<Front> {
  if (!isPostPath(path) || String(front.author ?? '').trim()) return front;
  const handle = String((await getConfig(env, 'defaultAuthor')) ?? '').trim();
  return handle ? { ...front, author: handle } : front;
}

/** 校验通过、准备写进仓库的一篇 */
interface PreparedContent {
  path: string;
  content: string;
  bytes: number;
  futureDraft: string | null;
  /** 仓库里已经有一模一样的一份：不参与本次提交，但仍算成功 */
  unchanged: boolean;
  currentSha?: string;
}

type PrepareResult = { ok: true; prepared: PreparedContent } | { ok: false; outcome: ContentOutcome };

/**
 * 第一阶段：路径校验 → 拼 front matter → 读现状做乐观锁检查。**不写盘**。
 *
 * 拆成两阶段是为了「多篇一个提交」：每篇各自校验、各自判冲突，通过的攒成一批一次提交。
 * 以前每篇一次 writeFile = 每篇一个提交 = 每篇触发一次 Pages 构建，
 * 后台那句「攒一批再推」实际省不掉构建次数。
 */
async function prepareContentItem(
  env: Env,
  settings: Awaited<ReturnType<typeof repoTarget>>,
  item: ContentItem,
): Promise<PrepareResult> {
  const asked = String(item.path ?? '');
  const checked = validateContentPath(asked);
  if ('error' in checked) return { ok: false, outcome: { ok: false, path: asked, reason: 'invalid', error: checked.error } };
  const path = checked.path;

  let content: string;
  let futureDraft: string | null = null;
  try {
    if (item.front && typeof item.front === 'object') {
      const front = orderFront(await withAuthorFallback(env, path, item.front as Front));
      // 时刻（朋友圈式动态）没有标题，正文/图/音/视频任一非空即可；标题必填只针对文章
      if (isPostPath(path) && !String(front.title ?? '').trim()) throw new Error('标题不能为空');
      /* 发布时间填在将来 → 落成显式草稿。不转的话保存会「成功」，但 Hugo 到构建时把那页跳过，
         站主看到的就是「后台说发布成功、前台查无此文」。转成草稿后它至少在后台是可见的。 */
      const future = isDraftFront(front) ? null : futureFrontDate(front);
      if (future) futureDraft = future;
      content = buildMarkdown(future ? { ...front, draft: true } : front, (item.body ?? '').trim());
    } else if (typeof item.content === 'string') {
      /* 只给整篇 markdown 的写法没有结构化字段可改，不改人家一个字节，直接拦下来：
         放着不管同样是「写进去了但前台没有」，宁可让调用方当场知道。 */
      const parsed = parseFrontMatter(item.content);
      const future = isDraftFront(parsed.front) ? null : futureFrontDate(parsed.front);
      if (future) {
        /* 这条路径什么都没写，所以不能说「已按草稿保存」—— 那是上面结构化分支才有的事。
           一句话里同时出现「已保存」与「未写入」，读的人只能猜哪个是真的。 */
        throw new Error(
          `发布时间（${future}）在将来，Hugo 只在构建时比对日期、这类页面不会生成。这次提交未写入：请在 front matter 里加上 draft: true，或改用 front 字段提交（那条路会自动转成草稿）。`,
        );
      }
      content = item.content;
    } else {
      throw new Error('缺少正文');
    }
    /** Hugo 的口径在这里统一过一次：两种提交形状（front 与整篇 content）拼完都是同一份 markdown，
        所以只在这一处判，不会再出现「一条路管了、另一条路漏了」。
        日期写成 Hugo 认不了的样子是**整站构建失败**（退出码 1），不是这一篇不生成。 */
    const dateErr = checkHugoDates(parseFrontMatter(content).front);
    if (dateErr) throw new Error(dateErr);
  } catch (e) {
    return { ok: false, outcome: { ok: false, path, reason: 'invalid', error: e instanceof Error ? e.message : String(e) } };
  }

  const current = await readFile({ ...settings, path }).catch(() => null);

  // 带 sha 就是乐观锁：别人在你编辑期间改过就不覆盖（批量时这一条被跳过并单独报出来，其余照常推）
  if (item.sha) {
    if (current && current.sha && current.sha !== item.sha) {
      return { ok: false, outcome: { ok: false, path, reason: 'conflict', error: '这篇在你编辑期间已被改动，未覆盖' } };
    }
  } else if (current) {
    /* 不带 sha 而仓库里已经有这个文件 = 名字被占了。以前直接覆盖：两个人同时新建「今天第一篇」时
       取到同一个号（取号是「列目录数最大序号 +1」，号本身没有锁），后写的那一笔把前一篇整篇盖掉，
       两边都显示「保存成功」，后台毫无痕迹（T3 体检实测）。
       现在按冲突报出去：单写回 409，批量时这一条被跳过并单独列出，其余照推。 */
    return {
      ok: false,
      outcome: {
        ok: false,
        path,
        reason: 'conflict',
        error: `${path} 在仓库里已经存在，而这次提交没带它的版本号，所以没有覆盖。两种可能：另一个人（或另一个标签页）刚用同一个文件名建过；或者你上一次保存其实成功了、只是回执没收到。请先打开这篇确认内容，或换一个文件名再存。`,
      },
    };
  }

  return {
    ok: true,
    prepared: {
      path,
      content,
      bytes: content.length,
      futureDraft,
      unchanged: Boolean(current && current.content === content),
      currentSha: current?.sha,
    },
  };
}

/** 第二阶段：提交成功之后的收尾（草稿摘掉本地产物、按需群发）。 */
async function finishContentItem(
  env: Env,
  adminId: string,
  settings: Awaited<ReturnType<typeof repoTarget>>,
  item: ContentItem,
  prepared: PreparedContent,
  sha: string | undefined,
): Promise<ContentOutcome> {
  const parsed = parseFrontMatter(prepared.content);
  /* 草稿与线上必须一致：Hugo 不带 -D 时根本不渲染 draft，可本地 `hugo server`
     已经把「取消发布」前的那一份写进 public/ 了，不摘掉就会出现「后台标了草稿、
     前台还打得开」。线上 Pages 每次是干净目录，没这一步。 */
  const purgedBuild: string[] = [];
  const ref = buildPageRef(prepared.path);
  if (ref && isDraftFront(parsed.front)) {
    purgedBuild.push(...(await pruneLocalBuild(settings, { ...ref, title: String(parsed.front.title ?? '').trim() })));
  }

  const notify: NotifyResult = item.notifySubscribers ? await notifyPostSubscribers(env, adminId, prepared.path, parsed) : {};
  return {
    ok: true,
    path: prepared.path,
    sha,
    bytes: prepared.bytes,
    notify,
    purgedBuild,
    futureDraft: prepared.futureDraft,
  };
}

/**
 * 一批内容落成**一个**提交，然后逐篇收尾。
 * 不抛 HTTP 异常、不清缓存、不触发构建 —— 这三件由调用方在整批做完后统一做一次。
 */
async function writeContentItems(
  env: Env,
  admin: { id?: string | null },
  items: ContentItem[],
): Promise<ContentOutcome[]> {
  const settings = await repoTarget(env);
  const outcomes: (ContentOutcome | null)[] = items.map(() => null);
  const ready: { idx: number; item: ContentItem; prepared: PreparedContent }[] = [];

  for (let i = 0; i < items.length; i++) {
    const r = await prepareContentItem(env, settings, items[i]);
    if (r.ok) ready.push({ idx: i, item: items[i], prepared: r.prepared });
    else outcomes[i] = r.outcome;
  }

  const changed = ready.filter((x) => !x.prepared.unchanged);
  let shas: Record<string, string> = {};
  let commitError = '';
  if (changed.length) {
    const message =
      items.length === 1
        ? (changed[0].item.message || '').trim() || `content: update ${changed[0].prepared.path}`
        : `zero-cms: 批量更新 ${changed.length} 个文件（${changed.map((x) => x.prepared.path).join('、')}）`;
    const res = await commitRepoFiles(
      env,
      changed.map((x) => ({ path: x.prepared.path, content: x.prepared.content })),
      message,
    );
    if (!res.success) commitError = res.error ?? '提交失败';
    else shas = res.shas;
  }

  for (const { idx, item, prepared } of ready) {
    if (commitError) {
      outcomes[idx] = { ok: false, path: prepared.path, reason: 'failed', error: commitError };
      continue;
    }
    // 成功的那几篇要把新 sha 带回去：前端本地暂存里存的是提交前的 sha，不带回来下次推送必然报冲突
    outcomes[idx] = await finishContentItem(env, admin.id ?? '', settings, item, prepared, shas[prepared.path] ?? prepared.currentSha);
  }

  return outcomes as ContentOutcome[];
}

/** 写一篇：等价于批次里只有一个元素。 */
async function writeContentItem(env: Env, admin: { id?: string | null }, item: ContentItem): Promise<ContentOutcome> {
  return (await writeContentItems(env, admin, [item]))[0];
}

/** 「发布后群发订阅」：只有非草稿的文章能发，草稿只入库不推送 */
async function notifyPostSubscribers(env: Env, adminId: string, path: string, parsed: ParsedMarkdown): Promise<NotifyResult> {
  if (!/\/posts\//.test(path)) return { skipped: '只有文章可以群发' };
  if (isDraftFront(parsed.front)) return { skipped: '草稿不群发' };

  const site = await resolveSiteName(env);
  /* 兜底绝不能是整条仓库路径：那会直接出现在订阅者信的主题与正文 <h2> 里
     （`content/zh/posts/20261025002.md`）。写入侧对文章强制要求标题，所以走到这里
     只可能是 front matter 解析不出来，那就退到文件名，和提醒信一个口径。 */
  const title = String(parsed.front.title ?? '').trim() || path.split('/').pop()!.replace(/\.mdx?$/i, '') || '新文章';
  /* 必须给绝对地址：只写 /posts/xxx/ 的话，邮件客户端会拿「自己的」域名甚至本地路径去解析，
     收件人点「阅读全文」打不开文章。站点域名没配时退化成相对路径，也比拼一个假域名好。 */
  const link = await postEmailUrl(env, postWebPath(path));
  const summary = excerpt(String(parsed.front.summary ?? parsed.front.description ?? ''), 200);
  const html =
    `<h2>${escapeHtml(title)}</h2>` +
    (summary ? `<p>${escapeHtml(summary)}</p>` : '') +
    `<p><a href="${escapeHtml(link)}">阅读全文</a></p>`;
  const jobId = await createBroadcastJob(env, {
    subject: `${site ? site + '：' : ''}${title}`,
    html,
    postPath: postWebPath(path),
    createdBy: adminId,
  });
  const run = await runBroadcastJob(env, jobId);
  return { jobId, sent: run.sent, failed: run.failed };
}

/** 整批写完统一做的一次收尾：清后台文章列表缓存 + 触发一次站点重建 + （本地后端）构建体检。
 *  重建与体检这两件本身已下沉到 services/git.ts 的 finishRepoWrites —— 那是所有写仓库路径共用的收尾，
 *  这里只多做一件文章特有的：清掉后台的文章列表缓存。 */
async function finishContentWrite(
  env: Env,
  changed: number,
  triggerBuild: boolean,
  paths: string[],
): Promise<{ build: { triggered?: boolean; viaCommit?: boolean; error?: string } | null; buildHealth: Awaited<ReturnType<typeof runLocalBuildCheck>> }> {
  if (!changed) return { build: null, buildHealth: null };
  await kvDelete(env, POSTS_CACHE_KEY);
  /* 提醒信里的标题也缓存过，改了这一篇就得连那一格一起清（见 content-title 的 purgeContentTitleCache） */
  await purgeContentTitleCache(env, paths);
  return finishRepoWrites(env, changed, triggerBuild);
}

app.put('/content/file', async (c) => {
  const admin = requireAdmin(c);
  const body = (await c.req.json().catch(() => null)) as (ContentItem & { triggerBuild?: boolean }) | null;
  const outcome = await writeContentItem(c.env, admin, body ?? {});
  if (!outcome.ok) {
    if (outcome.reason === 'conflict') fail(409, outcome.error);
    fail(outcome.reason === 'invalid' ? 400 : 502, outcome.error);
  }
  await writeAudit(c.env, {
    actor: admin,
    action: 'content',
    target: outcome.path,
    detail: {
      event: 'put',
      bytes: outcome.bytes,
      notify: outcome.notify.skipped ?? outcome.notify.jobId ?? null,
      ...(outcome.purgedBuild.length ? { purgedBuild: outcome.purgedBuild } : {}),
      ...(outcome.futureDraft ? { futureDraft: outcome.futureDraft } : {}),
    },
    ip: clientIp(c),
  });
  const { build, buildHealth } = await finishContentWrite(c.env, 1, body?.triggerBuild !== false, [body?.path ?? '']);
  const healthNote = buildHealthReceipt(buildHealth).replace(/^；/, '');
  return ok({
    ...outcome,
    /* 回执里那句话是站主唯一会看的东西：只把 buildHealth 躺在字段上等于没做（后台不一定渲染它）。
       所以体检失败要同时进正文。 */
    note: [outcome.futureDraft ? futureDraftNote(outcome.futureDraft) : null, healthNote || null].filter(Boolean).join('；') || null,
    build,
    buildHealth,
  });
});

/**
 * GET /api/admin/content/next-name —— 问服务端要「今天这篇文章该叫什么」。
 *
 * 口径与投稿那条完全一样（`lib/postName.ts`）：**没填文件名就用「发布那天 + 当天三位序号」**，
 * 填了就用填的。序号是从仓库里那一天已有的文件名数出来的 —— 只有服务端能数，
 * 所以后台「新建文章」面板打开时来问一次，预览与提交都用它给的那个名字，
 * 不再由浏览器自己拼日期（那会跟投稿链路长成两种形状）。
 * 列不到目录（仓库没配好、临时失败）时回 `name: null` 加原因，界面据此要求手填。
 */
app.get('/content/next-name', async (c) => {
  requireAdmin(c);
  /** 可以指定目录（后台新建文章面板上那个目录框可能就是别的目录）；不给就用设置里的文章目录 */
  const asked = (c.req.query('dir') ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const dir = asked || (await postsDir(c.env));
  const segs = dir.split('/');
  if (!dir || segs.some((s) => s === '' || s === '.' || s === '..')) fail(400, '目录不合法');
  const name = await datedSlug(c.env, dir);
  return ok({ name, dir, path: name ? `${dir}/${name}.md` : null });
});

/**
 * POST /api/admin/content/batch —— 后台「保存到 Git」一次推送多篇。
 *
 * 编辑器里的「保存本地」只是把改动存进浏览器，攒够一批再一起推。
 * 某一类失败不拖垮整批：sha 冲突（这篇在别处被改过）只跳过它并单独报出来，
 * 其余照常提交，本地暂存里也只移除推送成功的那几篇。
 * 缓存清理与站点重建整批只做一次。
 */
app.post('/content/batch', async (c) => {
  const admin = requireAdmin(c);
  const input = (await c.req.json().catch(() => null)) as { files?: ContentItem[]; triggerBuild?: boolean } | null;
  const files = Array.isArray(input?.files) ? input.files : [];
  if (!files.length) fail(400, '没有要提交的内容');
  if (files.length > 50) fail(400, '一次最多推送 50 篇，请分几次提交');

  const results: {
    path: string;
    ok: boolean;
    sha?: string;
    bytes?: number;
    reason?: string;
    error?: string;
    notify?: NotifyResult;
    purgedBuild?: string[];
    futureDraft?: string | null;
  }[] = [];
  /* 整批一次提交：校验与冲突检查逐篇做，通过的攒成**一个** Git 提交 ——
     每个提交都会触发一次 Pages 构建，逐个 PUT 等于把「攒一批再推」白做了。 */
  const outcomes = await writeContentItems(c.env, admin, files);
  let done = 0;
  for (const r of outcomes) {
    if (r.ok) done++;
    results.push(
      r.ok
        ? { path: r.path, ok: true, sha: r.sha, bytes: r.bytes, notify: r.notify, purgedBuild: r.purgedBuild, futureDraft: r.futureDraft }
        : { path: r.path, ok: false, reason: r.reason, error: r.error },
    );
  }
  const drafted = results.filter((r) => r.ok && r.futureDraft).map((r) => r.path);

  await writeAudit(c.env, {
    actor: admin,
    action: 'content',
    target: results.map((r) => r.path).join(','),
    detail: {
      event: 'batch',
      total: results.length,
      done,
      drafted,
      failed: results.filter((r) => !r.ok).map((r) => `${r.path}:${r.reason ?? ''}`),
    },
    ip: clientIp(c),
  });
  const { build, buildHealth } = await finishContentWrite(c.env, done, input?.triggerBuild !== false, results.map((r) => r.path));
  return ok({
    total: results.length,
    done,
    results,
    drafted,
    build,
    buildHealth,
    message: (done
      ? buildReceipt(build, `已推送 ${done}/${results.length} 篇`) +
        (drafted.length ? `；其中 ${drafted.length} 篇发布时间填在将来，已按草稿保存（到时间后取消草稿再保存一次才会上线）` : '')
      : '没有推送成功，内容都留在本地暂存里') + buildHealthReceipt(buildHealth),
  });
});

/**
 * DELETE /api/admin/content/file?path=
 *
 * 删掉 markdown 之后还必须做四件事，否则「后端删了文章、前端还能用原链接打开」：
 * 1. 请求站点重新构建 —— 旧的那份 HTML 还在 Pages 上，不重建就一直能访问；
 * 2. 清掉后台的文章列表缓存；
 * 3. 摘掉这篇文章挂在数据库里的数据（评论、点赞/收藏、访问记录），
 *    不然它们会一直留在「热门页面 Top」和统计里，像这个页面还在；
 * 4. 把这条地址从 Cloudflare 边缘缓存里清掉（purge）—— 重建只换源站那一份，
 *    边缘那一层照旧端出旧的 HTML，用户强刷也刷不掉（他请求的是 CDN 命中）。
 */
app.delete('/content/file', async (c) => {
  const admin = requireAdmin(c);
  const env = c.env;
  const path = safePath(c.req.query('path') ?? '');
  const settings = await repoTarget(env);

  /* 本地开发要连构建产物一起清：`hugo server` 是增量渲染，源文件删了它不会回头删
     public/posts/<这篇>/index.html，于是后台删掉的文章在本地还能按老地址打开。
     线上 Pages 每次都是干净目录，不受影响。删之前先读一次拿标题（产物目录名是 Hugo
     按标题 urlize 的，中文标题猜不准，靠 <title> 比对才可靠）。 */
  const ref = buildPageRef(path);
  let purgedBuild: string[] = [];
  /** 「删掉了」与「本来就没有」必须分得开：清理脚本靠 success:true 会以为事情办完了（台架 F-05）。
   *  下面为了取标题本来就要读一次，顺手把它当存在性判据，不多花一次请求。 */
  let existed: boolean | null = null;
  if (ref) {
    const before = await readFile({ ...settings, path }).catch(() => null);
    existed = Boolean(before);
    const title = before ? String(parseFrontMatter(before.content).front.title ?? '').trim() : '';
    purgedBuild = await pruneLocalBuild(settings, { ...ref, title });
  }

  const result = await deleteFile({ ...settings, path, message: `content: delete ${path}` });
  if (!result.success) fail(502, result.error ?? '删除失败');

  let purged: { comments?: number; reactions?: number; visits?: number } = {};
  if (ref) {
    const web = contentWebPath(path);
    const slugs = [...new Set([web, web.replace(/\/+$/, ''), `/${web.replace(/^\/+/, '')}`])];
    const db = createDb(env);
    const rows = await db.delete(comments).where(inArray(comments.postSlug, slugs));
    const reac = await db.delete(reactions).where(inArray(reactions.targetSlug, slugs));
    const vis = await db.delete(visits).where(inArray(visits.path, slugs));
    purged = {
      comments: (rows as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 0,
      reactions: (reac as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 0,
      visits: (vis as unknown as { meta?: { changes?: number } })?.meta?.changes ?? 0,
    };
  }

  await kvDelete(env, POSTS_CACHE_KEY);
  await purgeContentTitleCache(env, [path]);
  const build = c.req.query('build') === '0' ? null : await triggerPagesBuild(env);
  /* 重建之外还要清边缘缓存：重建只换源站那一份，边缘上旧的 HTML 副本还在，
     不清的话「后台删了文章、前端还能打开」会一直复现，而且用户强刷也没用。
     只有 markdown 文章才有站内地址；删别的文件（比如数据文件）不用清。 */
  const purge = ref ? await purgePageUrls(env, [contentWebPath(path)]) : null;
  await writeAudit(env, {
    actor: admin,
    action: 'content',
    target: path,
    detail: { event: 'delete', purged, purgedBuild, purge, existed, build: build ? 'requested' : 'skipped' },
    ip: clientIp(c),
  });
  const kv = await runLocalBuildCheck(c.env);
  const kvNote = buildHealthReceipt(kv).replace(/^；/, '');
  return ok({
    ...result,
    existed,
    purged,
    purgedBuild,
    purge,
    build,
    buildHealth: kv,
    note: [existed === false ? '仓库里本来就没有这个文件，这次没有东西被删除' : null, kvNote || null].filter(Boolean).join('；') || null,
  });
});

/* ---------------- 仓库配置文件：白名单内的整份读写 ---------------- */

/**
 * 站点配置（params.toml 等）与友链数据文件的整份编辑通道。
 *
 * 只放开这几份：它们决定前台的样子，后台「前端管理」的 data/*.json 覆盖不到的部分
 * 只能改源文件。其余路径一律拒绝，尤其不能顺着这条通道写到 .dev.vars、workflow
 * 或任何可执行文件上。文件是带注释的文本文档，因此这里绝不解析重写，
 * 后台提交什么就存什么（sha 乐观锁防并发覆盖）。
 */
const EDITABLE_REPO_FILES = new Set([
  'config/_default/params.toml',
  'config/_default/config.toml',
  'config/_default/menus.zh.toml',
]);

/**
 * 只读也能取的主题那份清单：站点自己的 config/_default/params.toml 往往不存在
 * （大多数站点只在 hugo.toml 里写几行覆盖），后台就会显示「读取不到」。
 * 主题那份是逐键带注释的全量模板，正好当起点 —— 读出来，用户点保存就落成站点自己的文件。
 */
const THEME_READ_ONLY_FILES = new Set([
  'themes/zero/config/_default/params.toml',
  'themes/zero/config/_default/config.toml',
]);

async function repoFilePath(env: Env, input: string, allowThemeRead = false): Promise<string> {
  const clean = String(input ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  // 友链数据文件按设置里的位置认：写死 'data/links.yaml' 会把挪过数据目录的站点挡在门外
  const links = await linksFilePath(env);
  const allowed = new Set([...EDITABLE_REPO_FILES, links]);
  if (!allowed.has(clean) && !(allowThemeRead && THEME_READ_ONLY_FILES.has(clean))) {
    fail(400, `只能编辑这几份文件：${[...allowed].join('、')}`);
  }
  return clean;
}

/**
 * GET /api/admin/repo/files —— 「主题配置文件」下拉该列哪几份。
 * 路径规则只在这里算一次：后台列的和后端放开的必须是同一份，否则挪了数据目录就会出现
 * 「下拉里点得动、保存被拒」或者反过来。
 */
app.get('/repo/files', async (c) => {
  requireAdmin(c);
  const labels: Record<string, string> = {
    'config/_default/params.toml': '（站点覆盖项）',
    'config/_default/config.toml': '（Hugo 基础配置）',
    'config/_default/menus.zh.toml': '（导航菜单）',
  };
  const links = await linksFilePath(c.env);
  return ok([...EDITABLE_REPO_FILES, links].map((path) => ({ path, label: `${path}${labels[path] ?? '（友链数据）'}` })));
});

/** GET /api/admin/repo/file?path=config/_default/params.toml */
app.get('/repo/file', async (c) => {
  requireAdmin(c);
  const path = await repoFilePath(c.env, c.req.query('path') ?? '', true);
  const file = await readRepoFile(c.env, path).catch((e: unknown) => fail(502, e instanceof Error ? e.message : String(e)));
  if (!file) return ok({ exists: false, path, content: '', sha: '' });
  return ok({ exists: true, path, content: file.content, sha: file.sha, bytes: file.content.length });
});

const repoFileSchema = z.object({
  path: z.string().min(1).max(200),
  content: z.string().max(400_000),
  sha: z.string().max(80).optional(),
  message: z.string().max(200).optional(),
  triggerBuild: z.boolean().optional().default(true),
});

/** PUT /api/admin/repo/file —— 整份覆盖白名单文件，sha 不匹配回 409 */
app.put('/repo/file', async (c) => {
  const admin = requireAdmin(c);
  const parsed = repoFileSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '需要 path 与 content');
  const { path: raw, content, sha, message, triggerBuild } = parsed.data;
  const path = await repoFilePath(c.env, raw);

  const current = await readRepoFile(c.env, path).catch(() => null);
  /* 这几份文件写空 = 前台立刻坏（params.toml 空 → apiBaseURL 没了，整站退回纯静态；
     links.yaml 空 → 友链整页没了）。误删全选再保存就是这种后果，所以在入口拦住。 */
  if (!content.trim()) fail(400, `${path} 的内容是空的：这几份文件写空会直接把前台对应的那块弄没，要恢复默认请到仓库里删掉这个文件`);
  /* 语法体检放在 sha 之前：写坏 config/_default/*.toml 是「整站一个页面都不产出」，
     写坏 links.yaml 是「友链整页没了」，而接口当时照样回 200「已保存」—— 表现是站点静默停止更新。
     见 services/repo-syntax.ts 的说明。 */
  const syntax = checkRepoFileSyntax(path, content);
  if (syntax) fail(400, syntax);
  if (sha && current && current.sha !== sha) {
    fail(409, '这份文件在你编辑期间已被改动，请重新读取后再保存，不要直接覆盖');
  }

  const committed = await writeRepoFile(c.env, path, content, message || `zero-cms: 更新 ${path}`, {
    actor: admin,
    ip: clientIp(c),
    action: 'params',
  });
  if (!committed.success) fail(502, committed.error ?? '写入失败');
  const build = triggerBuild ? await triggerPagesBuild(c.env) : null;
  await writeAudit(c.env, {
    actor: admin,
    action: 'params',
    target: path,
    detail: { event: 'repo-file.write', bytesBefore: current?.content.length ?? 0, bytes: content.length, sha: committed.sha, build },
    ip: clientIp(c),
  });
  /* 与文章同一套体检：这条通道写的是 params.toml / data/*.json / 审核规则，
     一个非标量字段（台架 T7-02 的 head_html）同样能让整站构建挂掉，
     而回执只说「已写入仓库」—— 写坏了在界面上和写成功一模一样。 */
  const health = await runLocalBuildCheck(c.env);
  return ok({
    path,
    sha: committed.sha,
    bytes: content.length,
    build,
    buildHealth: health,
    message: buildReceipt(build, `已写入仓库 ${path}`) + buildHealthReceipt(health),
  });
});

/* ---------------- 媒体库：多桶（R2 绑定 + S3 兼容第三方） ---------------- */

/** GET /api/admin/media/buckets —— 脱敏桶列表，密钥绝不回前端 */
app.get('/media/buckets', async (c) => {
  requireAdmin(c);
  const buckets = await listBuckets(c.env);
  return ok(buckets.map(maskBucket));
});

/**
 * 从请求里挑桶：?bucket= 优先，其次 FormData 的 bucket 字段。
 * 都没给就用 mediaBuckets 的第一项（resolveBucket 的默认行为）。
 */
async function bucketFrom(env: Env, url: string, form?: FormData | null): Promise<MediaBucket> {
  const fromQuery = new URL(url).searchParams.get('bucket')?.trim() ?? '';
  const fromForm = form?.get('bucket');
  const wanted = fromQuery || (typeof fromForm === 'string' ? fromForm.trim() : '');
  return resolveBucket(env, wanted);
}

/**
 * 恢复用的键必须是桶里正常那种对象名：不以 / 开头、没有 `..`、没有空段与控制字符。
 * 备份文件是站主手上的一个 JSON，路径穿越这类校验只能在这里做，不能信它。
 */
function isImportableKey(key: string): boolean {
  if (!key || key.length > 600 || key.startsWith('/') || key.includes('\\')) return false;
  return key.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && !/[\u0000-\u001f\u007f]/.test(s));
}

/** POST /api/admin/media —— FormData 的 bucket 字段或 ?bucket= 决定落到哪个桶 */
app.post('/media', async (c) => {
  const admin = requireAdmin(c);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) fail(400, '未收到文件');
  if (file.size > 20 * 1024 * 1024) fail(400, '单个文件不得超过 20MB');

  const bucket = await bucketFrom(c.env, c.req.url, form);
  /* 类型白名单：白名单外一律拒，白名单内以表里的 Content-Type 入库（不信浏览器给的 file.type）。
     图床直链域名不走那条「脚本类型降级」的代理，所以只能在这里拦。 */
  const type = checkUploadType(file.name);
  if (!type.ok) fail(400, type.error);
  /** 白名单只看扩展名，挡不住「改了名的别种文件」：0 字节的件会在前台永远是一张破图，
   *  而 `<html>` 改名 .png 混进图床域名是奔着执行去的。所以这里读真字节再判一次（上限 20MB，
   *  整份进内存换掉流式分叉的那套复杂度；20MB 在 Worker 的额度内）。 */
  const bytes = new Uint8Array(await file.arrayBuffer());
  const byteErr = checkUploadBytes(type.ext, bytes);
  if (byteErr) fail(400, byteErr);
  const key = `uploads/${new Date().toISOString().slice(0, 10)}/${newId()}.${type.ext}`;
  const stored = await putMediaObject(c.env, bucket, {
    key,
    data: bytes,
    contentType: type.contentType,
  });

  // 默认 R2 桶还留着旧行为：配了 mediaBaseUrl 就直接给可外链的地址
  let url = stored.url;
  const configuredBase = (await getConfig(c.env, 'mediaBaseUrl')) ?? '';
  if (configuredBase && (bucket.baseUrl ?? '') === '' && bucket.kind === 'r2') {
    url = `${configuredBase.replace(/\/+$/, '')}/${stored.key}`;
  }

  await writeAudit(c.env, {
    actor: admin,
    action: 'media',
    target: stored.key,
    detail: { event: 'upload', bucket: bucket.id, kind: bucket.kind, size: file.size },
    ip: clientIp(c),
  });
  return ok({ key: stored.key, url, bucket: bucket.id, size: stored.size });
});

/**
 * POST /api/admin/media/import —— 按备份里的**原 key** 写回一张图（FormData：file / key / bucket）。
 *
 * 上面那个上传口只会造新 key（uploads/日期/uuid），可文章 Markdown 里引用的正是当年那个键；
 * 恢复图片必须原样落回，否则媒体清单的「缺 N 张」永远补不完。
 * 本站已有同名对象就跳过、不覆盖：恢复不该把新站这段时间刚传的图打回旧版。
 */
app.post('/media/import', async (c) => {
  const admin = requireAdmin(c);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  const key = String(form?.get('key') ?? '').trim();
  if (!(file instanceof File)) fail(400, '未收到文件');
  if (file.size > 20 * 1024 * 1024) fail(400, '单个文件不得超过 20MB');
  if (!isImportableKey(key)) fail(400, `对象键不合法：${key || '（空）'}`);

  const bucket = await bucketFrom(c.env, c.req.url, form);
  if (await mediaObjectExists(c.env, bucket, key)) {
    await writeAudit(c.env, {
      actor: admin,
      action: 'media',
      target: key,
      detail: { event: 'import-skip', bucket: bucket.id },
      ip: clientIp(c),
    });
    return ok({ key, bucket: bucket.id, skipped: true, reason: '本站已有同名对象，没覆盖' });
  }

  /* 恢复口同样过白名单：备份里若真有 .svg/.html 这类对象，这一条会被跳过并说明原因，
     而不是把它们重新放回一个能在图床域名下执行的键上。 */
  const importType = checkUploadType(key);
  if (!importType.ok) fail(400, importType.error);
  /** 也要过一遍字节真相：备份 JSON 是站主手上的文件，键名与内容对不上的件（0 字节、改了名的
   *  标记语言）恢复进来等于把坏件重新放回能外链的域名上。 */
  const importBytes = new Uint8Array(await file.arrayBuffer());
  const importByteErr = checkUploadBytes(importType.ext, importBytes);
  if (importByteErr) fail(400, `${key}：${importByteErr}`);

  const stored = await putMediaObject(c.env, bucket, {
    key,
    data: importBytes,
    contentType: importType.contentType,
  });
  await writeAudit(c.env, {
    actor: admin,
    action: 'media',
    target: stored.key,
    detail: { event: 'import', bucket: bucket.id, size: file.size },
    ip: clientIp(c),
  });
  return ok({ key: stored.key, url: stored.url, bucket: bucket.id, size: stored.size, skipped: false });
});

/** GET /api/admin/media/list?prefix=&bucket=&limit=&cursor= */
/**
 * 媒体库列表：按类型分类 + 按上传时间倒序（最新在最上）。
 *
 * 以前只按前缀列、顺序完全跟键名（`uploads/日期/uuid`）走：同一天内部是乱序，界面上又只有大小、
 * 没有文件名和时间 —— 站长「刚传的那张在哪」只能靠翻。这里在服务端做分类与排序：
 *   ?kind=all|image|audio|video|doc|other   ?sort=desc|asc（默认 desc）
 * 为了能「先过滤再排序」，列表会把该桶 uploads/ 下的对象按页取全（上限 5000，够一个个人站用很多年），
 * 之后在内存里过滤/排序/截断；返回 total 供界面显示条数。
 */
const MEDIA_KINDS: Record<string, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'],
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf', 'odt'],
};
function mediaKindOf(key: string): string {
  const ext = (key.split('.').pop() ?? '').toLowerCase();
  for (const [kind, list] of Object.entries(MEDIA_KINDS)) if (list.includes(ext)) return kind;
  return 'other';
}

app.get('/media/list', async (c) => {
  requireAdmin(c);
  const bucket = await bucketFrom(c.env, c.req.url);
  const prefix = c.req.query('prefix') ?? 'uploads/';
  const kind = String(c.req.query('kind') ?? 'all').toLowerCase();
  const desc = (c.req.query('sort') ?? 'desc').toLowerCase() !== 'asc';
  const cap = Math.min(Number(c.req.query('limit') ?? '1000') || 1000, 5000);

  const all: { key: string; name: string; size: number; uploaded: string | null; url: string; kind: string }[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const listed = await listMediaObjects(c.env, bucket, { prefix, limit: 1000, cursor: cursor ?? undefined });
    for (const o of listed.objects) all.push({ key: o.key, name: o.name, size: o.size, uploaded: o.lastModified, url: o.url, kind: mediaKindOf(o.key) });
    cursor = listed.truncated ? listed.cursor : null;
    if (!cursor || all.length >= 5000) break;
  }

  const filtered = (kind === 'all' ? all : all.filter((o) => o.kind === kind)).sort((a, b) => {
    const ta = a.uploaded ? Date.parse(a.uploaded) : 0;
    const tb = b.uploaded ? Date.parse(b.uploaded) : 0;
    if (ta !== tb) return desc ? tb - ta : ta - tb;
    return desc ? b.key.localeCompare(a.key) : a.key.localeCompare(b.key);
  });

  return ok({
    bucket: bucket.id,
    kind,
    sort: desc ? 'desc' : 'asc',
    total: filtered.length,
    counts: { all: all.length, ...Object.fromEntries(['image', 'audio', 'video', 'doc', 'other'].map((k) => [k, all.filter((o) => o.kind === k).length])) },
    objects: filtered.slice(0, cap),
  });
});

/**
 * GET /api/admin/media/* —— 媒体读写都用它：
 *   /media/uploads/2026-10-01/a.png?bucket=oss
 *   /media/object/oss/uploads/2026-10-01/a.png（services/media.ts 里 objectUrl 生成的代理地址形状）
 * 私有 S3 桶没有签名直链不能用，走这里由服务端代取；R2 桶没配 baseUrl 时也走这里。
 */
function mediaKeyAndBucket(url: string): { key: string; bucketId: string | null } {
  const path = decodeURIComponent(new URL(url).pathname.replace(/^\/api\/admin\/media\/?/, ''));
  if (!path) fail(400, '缺少对象键');
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'object' && segments.length >= 3) {
    const bucketId = segments[1]!;
    return { key: segments.slice(2).join('/'), bucketId };
  }
  return { key: segments.join('/'), bucketId: null };
}

app.get('/media/*', async (c) => {
  requireAdmin(c);
  const { key, bucketId } = mediaKeyAndBucket(c.req.url);
  /** 键的长度与字符要先判：R2 对超长名回的是运行时错误（实测 1024 字符起），
   *  以前一路冒到 onError 变成 500 还把 trace 号回给对方（台架 F-02）。 */
  const keyErr = checkMediaKey(key);
  if (keyErr) fail(400, `对象键不合法：${keyErr}`);
  const bucket = await resolveBucket(c.env, c.req.query('bucket') || bucketId || '');
  const object = await getMediaObject(c.env, bucket, key);
  if (!object) fail(404, '文件不存在');
  return new Response(object.data as BodyInit, {
    headers: { 'Content-Type': object.contentType, 'Cache-Control': 'private, max-age=300' },
  });
});

/** DELETE /api/admin/media/*?bucket= */
/**
 * POST /api/admin/media/variant —— 上传**一张图片变体**（FormData：file / key / bucket?）。
 *
 * 为什么要单独一个口：普通上传口只会造新键（uploads/日期/uuid），而变体的键必须能从母版键推出来
 * （variants/<母版键去扩展名>/h720.webp），否则构建期对不上号。
 * 变体在浏览器里用 canvas 生成（Worker 没有图像处理能力），所以这里只负责校验与落桶：
 *   · 键必须落在 variants/ 下、且是 .webp（防止拿它往任意位置写）
 *   · 单张 ≤5MB（一档 1080 的 webp 正常 <500KB，给足余量但不让人拿它当通用上传口）
 * 幂等：同一个键重复上传直接覆盖（回填重跑时就是这个行为）。
 */
app.post('/media/variant', async (c) => {
  const admin = requireAdmin(c);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  const key = String(form?.get('key') ?? '').trim();
  if (!(file instanceof File)) fail(400, '未收到变体文件');
  if (!isValidVariantObjectKey(key)) fail(400, '变体键必须形如 variants/<母版键去扩展名>/h720.webp，且不许带 ..');
  const variantKeyErr = checkMediaKey(key);
  if (variantKeyErr) fail(400, `变体键不合法：${variantKeyErr}`);
  if (file.size > 5 * 1024 * 1024) fail(400, '单个变体不得超过 5MB');
  const type = checkUploadType(file.name);
  if (!type.ok || !/webp/i.test(type.contentType)) fail(400, '变体只接受 WebP');
  /** 变体是浏览器 canvas 生成后回传的：读失败、编码不支持时会留下一份 0 字节或不是 webp 的件，
   *  而清单一旦写上这个档，前台就会拿它当可用变体去 srcset 里引用。 */
  const variantBytes = new Uint8Array(await file.arrayBuffer());
  const variantErr = checkUploadBytes('webp', variantBytes);
  if (variantErr) fail(400, `${key}：${variantErr}`);
  const bucket = await bucketFrom(c.env, c.req.url, form);
  const stored = await putMediaObject(c.env, bucket, { key, data: variantBytes, contentType: 'image/webp' });
  await writeAudit(c.env, {
    actor: admin,
    action: 'media',
    target: stored.key,
    detail: { event: 'variant', bucket: bucket.id, size: file.size },
    ip: clientIp(c),
  });
  return ok({ key: stored.key, url: stored.url, bucket: bucket.id, size: stored.size });
});

/** GET /api/admin/media-variants —— 变体清单（回填 UI 用它算「哪些已有、哪些缺」） */
app.get('/media-variants', async (c) => {
  requireAdmin(c);
  const manifest = await readVariantsManifest(c.env);
  return ok({ manifest, count: Object.keys(manifest).length, path: 'data/media-variants.json' });
});

/** POST /api/admin/media-variants —— 合并一条：{ origin: "uploads/…", entry: { a, v } } */
app.post('/media-variants', async (c) => {
  const admin = requireAdmin(c);
  const body = (await c.req.json().catch(() => null)) as { origin?: unknown; entry?: unknown } | null;
  const origin = typeof body?.origin === 'string' ? body.origin : '';
  const raw = body?.entry as { a?: unknown; v?: unknown } | undefined;
  if (!isValidOriginKey(origin)) fail(400, 'origin 必须是 uploads/ 下的母版键，且不许带 ..');
  const originKeyErr = checkMediaKey(origin);
  if (originKeyErr) fail(400, `origin 键不合法：${originKeyErr}`);
  const aspect = Number(raw?.a);
  if (!Number.isFinite(aspect) || aspect <= 0 || aspect > 10) fail(400, 'entry.a 要写成宽/高（正数）');
  const vIn = (raw?.v ?? {}) as Record<string, unknown>;
  const v: Record<string, string> = {};
  for (const h of ['360', '720', '1080']) {
    const u = vIn[h];
    if (typeof u !== 'string' || !u) continue;
    /* 允许 http(s)，也允许以 / 开头的站内地址：本地台架没有给桶配直链域名，objectUrl 会回 /api/media/… */
    if (!/^(https?:\/\/|\/)/i.test(u) || u.length > 500) fail(400, `entry.v.${h} 要写成 http(s) 或 / 开头的地址`);
    v[h] = u;
  }
  if (!Object.keys(v).length) fail(400, 'entry.v 里一档都没有');
  const manifest = await mergeVariantEntry(c.env, origin, { a: Math.round(aspect * 1000) / 1000, v });
  await writeAudit(c.env, {
    actor: admin,
    action: 'media',
    target: origin,
    detail: { event: 'variants-manifest', tiers: Object.keys(v), total: Object.keys(manifest).length },
    ip: clientIp(c),
  });
  return ok({ origin, tiers: Object.keys(v), total: Object.keys(manifest).length });
});

app.delete('/media/*', async (c) => {
  const admin = requireAdmin(c);
  const { key, bucketId } = mediaKeyAndBucket(c.req.url);
  const keyErr = checkMediaKey(key);
  if (keyErr) fail(400, `对象键不合法：${keyErr}`);
  const bucket = await resolveBucket(c.env, c.req.query('bucket') || bucketId || '');
  /** 先确认桶里真有这么个件再删：删除回 `deleted:true` 而不说「本来就没有」，
   *  调用方（清理脚本、后台批量删）会把「什么都没删掉」当成删成功（台架 F-05）。 */
  const existed = await mediaObjectExists(c.env, bucket, key);
  const removed = await deleteMediaObject(c.env, bucket, key);
  /* 母版删了，它的三档变体也要跟着删；否则桶里会慢慢攒一堆没人引用的孤儿 */
  let variantsDeleted = 0;
  if (!isVariantKey(removed.key)) {
    variantsDeleted = await deleteVariantsOf(c.env, bucket, removed.key);
    await removeVariantEntry(c.env, removed.key).catch(() => {});
  }
  await writeAudit(c.env, {
    actor: admin,
    action: 'media',
    target: removed.key,
    detail: { event: 'delete', bucket: bucket.id, via: objectPath(bucket, removed.key), variantsDeleted, existed },
    ip: clientIp(c),
  });
  return ok({
    key: removed.key,
    bucket: bucket.id,
    deleted: true,
    existed,
    variantsDeleted,
    ...(existed ? {} : { note: '桶里本来就没有这个键，这次没有东西被删除' }),
  });
});

/* ---------------- 群发 ---------------- */

const broadcastSchema = z.object({
  subject: z.string().min(1).max(200),
  html: z.string().min(1).max(200_000),
  /** 只发给已确认订阅者。后台下拉里文章的 id 就是仓库路径，上限与 POST /broadcast/jobs 对齐 */
  postId: z.string().max(300).optional(),
  /** 关联文章的仓库路径：靠它才能在信里补出「阅读全文」的绝对链接 */
  postPath: z.string().max(300).optional().nullable(),
});

app.post('/broadcast', async (c) => {
  const admin = requireAdmin(c);
  const parsed = broadcastSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '主题与正文必填');
  /*
   * 与「发布后群发」走同一条路：先建任务、再交给 runBroadcastJob 执行。
   * 以前这里自己 in-request 循环 queueEmail，把后台写的裸 HTML 直接发出去 ——
   * 于是这封信没有外壳（站点名 / Logo / 称呼 / 落款全没有），收件人只看到正文和一行退订；
   * 订阅者一多还会撞请求上限。runBroadcastJob 里统一套外壳、按批回写进度、先过额度闸门。
   */
  const jobId = await createBroadcastJob(c.env, {
    subject: parsed.data.subject,
    html: parsed.data.html,
    postId: parsed.data.postId ?? null,
    postPath: parsed.data.postPath ?? null,
    createdBy: admin.id ?? null,
  });
  const run = await runBroadcastJob(c.env, jobId);
  await writeAudit(c.env, {
    actor: admin,
    action: 'broadcast',
    target: parsed.data.subject,
    detail: { jobId, recipients: run.recipients, sent: run.sent, failed: run.failed, error: run.error ?? null },
    ip: clientIp(c),
  });
  return ok({ recipients: run.recipients, queued: run.sent, failed: run.failed, jobId, status: run.status, error: run.error ?? null });
});

/** 手动跑一次「新文章推送」；reset=true 重新记录基线，不补发历史 */
app.post('/subscribe/push', async (c) => {
  const admin = requireAdmin(c);
  const body = (await c.req.json().catch(() => null)) as { reset?: boolean } | null;
  const outcome = await pushNewPostsToSubscribers(c.env, { reset: Boolean(body?.reset) });
  await writeAudit(c.env, {
    actor: admin,
    action: 'broadcast',
    target: 'subscribe:push',
    detail: outcome,
    ip: clientIp(c),
  });
  return ok(outcome);
});

/**
 * POST /api/admin/email/test { to, kind? }
 * 真发一封测试信：本地没有邮件服务，站主只能这样确认「发信方式」那套配置是否可用。
 * kind 决定发哪一封（默认验证码那封，因为它最短）；返回里带失败原因，不用翻日志。
 */
app.post('/email/test', async (c) => {
  const admin = requireAdmin(c);
  const env = c.env;
  const parsed = z
    .object({
      to: z.string().email().max(200),
      kind: z.enum(['code', 'subscribe', 'comment', 'notice']).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '请填写收件人邮箱（合法地址）');
  const kind = parsed.data.kind ?? 'code';
  const html = await buildEmailPreview(env, kind, (await siteAuthorName(env)) || undefined);
  const site = await resolveSiteName(env);
  const res = await sendEmail(env, { to: parsed.data.to, subject: `【${site}】测试邮件（${kind}）`, html, kind: 'notice' });
  await writeAudit(env, {
    actor: admin,
    action: 'email',
    target: 'email:test',
    detail: { to: parsed.data.to, kind, success: res.success, error: res.error ?? null },
    ip: clientIp(c),
  });
  if (!res.success) {
    /**
     * 失败必须是非 2xx。公开口（注册/找回密码）那侧的防枚举口径是「通道没配」与「15 分钟内坏」
     * 回同一句，那是给外人看的；这一条已经在 `requireAdmin` 之后，返回值是给站长自己看的。
     * 体检实测它回 200 + `sent:false` —— 人在界面上看得见（后台标红），但接 Uptime/脚本测信
     * 只看状态码，永远是绿的。
     */
    fail(502, `发信失败：${res.error ?? '通道没有返回原因'}`);
  }
  return ok({ sent: true, kind, to: parsed.data.to });
});

/**
 * POST /api/admin/email/notify-test { to? }
 * 新评论提醒链路自检：按 notifyNewComment 用的同一套配置与模板各发一封
 * （站长那封 + 用户那封），回里带实际算出的收件人和 SMTP 原文回执。
 * 收件人不填就发给站长自己（adminNotifyEmail → emailFrom → 账号邮箱）。
 */
app.post('/email/notify-test', async (c) => {
  const admin = requireAdmin(c);
  const env = c.env;
  const parsed = z.object({ to: z.string().email().max(200).optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) fail(400, '收件人要填合法邮箱，或者整段留空（发给你自己）');
  const to =
    parsed.data.to ||
    (await getConfig(env, 'adminNotifyEmail'))?.trim() ||
    (await getConfig(env, 'emailFrom'))?.trim() ||
    admin.email ||
    '';
  if (!to) fail(400, '没有可用收件人：请在「设置 → 发信方式」填发件地址，或在这里指定一个邮箱');
  const result = await notifySelfTest(env, to);
  await writeAudit(env, {
    actor: admin,
    action: 'email',
    target: 'email:notify-test',
    detail: { to, rows: result.rows.map((r) => ({ to: r.to, sent: r.sent, error: r.error })) },
    ip: clientIp(c),
  });
  return ok(result);
});

app.get('/email-logs', async (c) => {
  requireAdmin(c);
  const rows = await createDb(c.env).select().from(emailLogs).orderBy(desc(emailLogs.createdAt)).limit(200);
  return ok(rows);
});

/** 四种邮件模板的种类，后台与调用点都用这套名字 */
const EMAIL_KINDS = ['code', 'subscribe', 'comment', 'notice'] as const;
type EmailKind = (typeof EMAIL_KINDS)[number];

function emailKindOf(raw: unknown): EmailKind | null {
  return EMAIL_KINDS.includes(raw as EmailKind) ? (raw as EmailKind) : null;
}

/**
 * 用当前配置的模板与站点信息渲染一封示例信，只回 HTML 不发送。
 * 改完文案先在浏览器里看一眼，比拿真邮箱试快得多。
 */
async function buildEmailPreview(env: Env, kind: EmailKind, nickname?: string): Promise<string> {
  const home = ((await getConfig(env, 'siteUrl')) ?? env.SITE_URL ?? 'https://example.com').replace(/\/+$/, '');
  const site = await resolveSiteName(env);
  const base = { title: `【${site}】示例邮件`, nickname };

  if (kind === 'code') {
    return renderEmail(env, 'code', { code: '246810', minutes: '10' }, base);
  }
  if (kind === 'subscribe') {
    return await renderEmail(
      env,
      'subscribe',
      // 预览要和真发出去的一致：确认链接是接口自己的地址，不是站点域名
      { url: `${await apiBase(env)}/api/subscribe/confirm?token=示例token`, email: 'you@example.com' },
      { ...base, actionNote: '确认链接 24 小时内有效，过期后重新提交一次订阅即可。' },
    );
  }
  if (kind === 'comment') {
    return await renderEmail(
      env,
      'comment',
      {
        author: '访客甲',
        where: `文章「《1984》阅读笔记」`,
        /* 预览做成"回复"那一封的形状：站主在后台改模板时能一次看到「原评论 + 新回复」两段，
           而不是只看到新回复、发出去才发现漏了 {parent} */
        parent: quotedCommentHtml('这是你原来那条评论（示例）。新回复在它下面一段。', home),
        content: '这段是示例正文，用来看引用块与换行在信里的样子。\n第二行。',
        url: `${home}/posts/1984/`,
        title: '《1984》阅读笔记',
      },
      { ...base, rawKeys: ['content', 'parent'] },
    );
  }
  return await renderEmail(
    env,
    'notice',
    {
      intro: '这是「其它通知」的示例：审核结果、新文章推送、群发都走这一封。',
      content: '<ul style="padding-left:18px;margin:16px 0"><li>示例条目一</li><li>示例条目二</li></ul>',
      title: '示例通知',
      url: home,
      action: '回到站点查看',
    },
    { ...base, rawKeys: ['content'] },
  );
}

/** 后台「邮件模板」页要用的元信息：四封正文的默认文本、占位符表与中文名 */
app.get('/email/templates', async (c) => {
  requireAdmin(c);
  return ok({ defaults: DEFAULT_TEMPLATES, labels: TEMPLATE_LABELS, vars: TEMPLATE_VARS });
});

app.get('/email/preview', async (c) => {
  requireAdmin(c);
  const kind = emailKindOf(c.req.query('kind'));
  if (!kind) fail(400, 'kind 只能是 code / subscribe / comment / notice');
  const html = await buildEmailPreview(c.env, kind, c.req.query('nickname') || undefined);
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
});

app.post('/email/preview', async (c) => {
  requireAdmin(c);
  const parsed = z
    .object({ kind: z.enum(EMAIL_KINDS as unknown as [EmailKind, ...EmailKind[]]), nickname: z.string().max(60).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, 'kind 只能是 code / subscribe / comment / notice');
  const { kind, nickname } = parsed.data;
  return ok({ kind, html: await buildEmailPreview(c.env, kind, nickname) });
});

app.get('/subscribers', async (c) => {
  requireAdmin(c);
  const status = c.req.query('status') ?? 'all';
  const limit = Math.min(Number(c.req.query('limit') ?? '500') || 500, 2000);
  const db = createDb(c.env);
  const rows = await db
    .select()
    .from(subscribers)
    .where(status === 'all' ? undefined : eq(subscribers.status, status))
    .orderBy(desc(subscribers.createdAt))
    .limit(limit);
  return ok(rows);
});

/* ---------------- 订阅者管理：确认 / 退订 / 删除 ---------------- */

async function loadSubscriber(env: Env, id: string) {
  const rows = await createDb(env).select().from(subscribers).where(eq(subscribers.id, id)).limit(1);
  const row = rows[0];
  if (!row) fail(404, '订阅记录不存在');
  return row;
}

/**
 * POST /api/admin/subscribers/:id/confirm —— 手工确认（pending → confirmed）。
 * 站主面对面收到的订阅（比如线下活动收的邮箱）不必再逼对方点一次确认邮件。
 * body.sendMail = true 时补发一封「已为你确认」的说明信，默认不发。
 */
app.post('/subscribers/:id/confirm', async (c) => {
  const admin = requireAdmin(c);
  const parsed = z.object({ sendMail: z.boolean().optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) fail(400, '参数有误');
  const db = createDb(c.env);
  const row = await loadSubscriber(c.env, c.req.param('id'));
  if (row.status === 'unsubscribed') fail(400, '该邮箱已退订，请让订阅者重新订阅');
  if (row.status === 'confirmed') return ok({ id: row.id, status: 'confirmed', already: true });

  const now = Math.floor(Date.now() / 1000);
  await db.update(subscribers).set({ status: 'confirmed', confirmedAt: now, unsubscribedAt: null }).where(eq(subscribers.id, row.id));

  let notified = false;
  let notifyError: string | undefined;
  if (parsed.data.sendMail) {
    const siteName = await resolveSiteName(c.env);
    const base = ((await getConfig(c.env, 'siteUrl')) ?? c.env.SITE_URL ?? '').replace(/\/+$/, '');
    const res = await queueEmail(c.env, {
      to: row.email,
      subject: `${siteName} 的订阅已生效`,
      html: `<p>站主已为你的邮箱完成确认，本站有新文章时会发邮件通知。</p><p>不再想收到？可以在邮件底部点击退订，或访问 <a href="${base}/subscribe/">订阅页</a>。</p>`,
      kind: 'confirm',
    });
    notified = res.success;
    if (!res.success) notifyError = res.error ?? '邮件发送失败';
  }

  await writeAudit(c.env, {
    actor: admin,
    action: 'broadcast',
    target: row.email,
    detail: { event: 'subscriber:confirm', from: row.status, to: 'confirmed', notified },
    ip: clientIp(c),
  });
  return ok({ id: row.id, status: 'confirmed', notified, notifyError });
});

/** POST /api/admin/subscribers/:id/unsubscribe —— 后台代客退订，写 unsubscribed_at */
app.post('/subscribers/:id/unsubscribe', async (c) => {
  const admin = requireAdmin(c);
  const db = createDb(c.env);
  const row = await loadSubscriber(c.env, c.req.param('id'));
  if (row.status === 'unsubscribed' && row.unsubscribedAt) return ok({ id: row.id, status: 'unsubscribed', already: true });

  const now = Math.floor(Date.now() / 1000);
  await db.update(subscribers).set({ status: 'unsubscribed', unsubscribedAt: row.unsubscribedAt ?? now }).where(eq(subscribers.id, row.id));
  await writeAudit(c.env, {
    actor: admin,
    action: 'broadcast',
    target: row.email,
    detail: { event: 'subscriber:unsubscribe', from: row.status, to: 'unsubscribed' },
    ip: clientIp(c),
  });
  return ok({ id: row.id, status: 'unsubscribed', unsubscribedAt: row.unsubscribedAt ?? now });
});

/** DELETE /api/admin/subscribers/:id —— 彻底删掉这条订阅记录，对方要重新订阅 */
app.delete('/subscribers/:id', async (c) => {
  const admin = requireAdmin(c);
  const db = createDb(c.env);
  const row = await loadSubscriber(c.env, c.req.param('id'));
  await db.delete(subscribers).where(eq(subscribers.id, row.id));
  await writeAudit(c.env, {
    actor: admin,
    action: 'broadcast',
    target: row.email,
    detail: { event: 'subscriber:delete', status: row.status },
    ip: clientIp(c),
  });
  return ok({ id: row.id, email: row.email, deleted: true });
});

/* ---------------- 已发布文章：群发下拉的数据源 ---------------- */

interface PostOption {
  id: string;
  path: string;
  title: string;
  date: string;
  draft: boolean;
}

const POSTS_CACHE_KEY = 'zero:admin:posts';
const POSTS_CACHE_TTL = 300;


/* 内容仓构建结果的回报口在 routes/build-report.ts（挂在 /api/build-report）。
   它不能挂在这里：index.ts 对 /api/admin/* 有一道统一登录闸，CI 没有会话 Cookie，
   实测挂在 /api/admin 下时直接 401「请先登录」，令牌逻辑根本轮不到执行。 */

/**
 * GET /api/admin/posts —— 群发选文章用的下拉。
 * 逐篇读 front matter 是要命的开销（一次 GitHub 请求一篇），所以结果整份缓存 5 分钟；
 * 仓库压根没配时回空数组 + notice，而不是让后台一个 500 红框。
 */
app.get('/posts', async (c) => {
  requireAdmin(c);
  const env = c.env;

  const cached = (await kvGet(env, POSTS_CACHE_KEY)) as { data?: PostOption[]; notice?: string } | null;
  if (cached && Array.isArray(cached.data)) return Response.json({ data: cached.data, notice: cached.notice ?? null });

  const backend = await repoBackend(env);
  if (backend === 'none') {
    const payload = { data: [] as PostOption[], notice: '未配置内容仓库（githubOwner/githubRepo + GITHUB_TOKEN，或本地 GIT_LOCAL_DIR），文章列表为空' };
    await kvPut(env, POSTS_CACHE_KEY, payload, 60);
    return Response.json(payload);
  }

  const items: PostOption[] = [];
  let notice: string | null = null;
  const dir = await postsDir(env);
  let entries: RepoEntry[] = [];
  try {
    entries = await listRepoDir(env, dir);
  } catch (e) {
    notice = `读取 ${dir} 失败：${e instanceof Error ? e.message : String(e)}`;
  }
  /* 两种布局都要认：扁平 `<名>.md` 与页面包 `<名>/index.md`。
     以前只扫扁平那一种 —— 页面包的文章在群发下拉里根本不出现，统计页也认不出它的标题。 */
  const candidates: { path: string; stem: string }[] = [];
  for (const f of entries) {
    if (/^_index\./i.test(f.name)) continue;
    if (f.type === 'file' && /\.mdx?$/i.test(f.name)) {
      candidates.push({ path: f.path || `${dir}/${f.name}`, stem: f.name.replace(/\.mdx?$/i, '') });
    } else if (f.type === 'dir') {
      const base = f.path || `${dir}/${f.name}`;
      /* 两种扩展名都列上：读到哪个算哪个，另一个自然落空。同一篇文章只留一条（按 stem 去重） */
      candidates.push({ path: `${base}/index.md`, stem: f.name }, { path: `${base}/index.mdx`, stem: f.name });
    }
  }
  const seenStem = new Set<string>();
  for (const { path, stem } of candidates) {
    if (seenStem.has(stem)) continue;
    let file;
    try {
      file = await readRepoFile(env, path);
    } catch {
      continue; // 单篇读失败不影响其它
    }
    if (!file) continue;
    const { front } = parseFrontMatter(file.content);
    if (front.draft === true || String(front.draft).toLowerCase() === 'true') continue;
    seenStem.add(stem);
    items.push({
      id: path,
      path,
      title: frontTitle(front as Record<string, unknown>) || stem,
      date: String(front.date ?? ''),
      draft: false,
    });
  }

  items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.path.localeCompare(b.path)));
  const payload = { data: items, notice };
  await kvPut(env, POSTS_CACHE_KEY, payload, POSTS_CACHE_TTL);
  return Response.json(payload);
});

/* ---------------- 评论审核规则文件：仓库里那份共享清单 ---------------- */

/**
 * POST /api/admin/poststats/export
 * 立刻跑一次文章统计导出（与每天定时那一次同一份实现），改完开关或想马上看到
 * 首页精选换序时点一下，不用等到第二天。
 */
app.post('/poststats/export', async (c) => {
  requireAdmin(c);
  const detail = await exportPostStats(c.env);
  return ok({ detail });
});

/**
 * GET /api/admin/spam/default-patterns
 * 开箱默认规则集原文。「复制到输入框」按钮把它填进 spamCustomRegex，
 * 站主就能在自己的框里逐条删改（删掉的行不会回来，内置那份始终还能靠开关关）。
 */
app.get('/spam/default-patterns', async (c) => {
  requireAdmin(c);
  return ok({ text: DEFAULT_SPAM_PATTERN_TEXT, count: DEFAULT_SPAM_PATTERN_TEXT.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length });
});

/**
 * GET /api/admin/spam/pattern-file
 * 走 repo.ts：GitHub 配好读仓库，否则自动落回 GIT_LOCAL_DIR，两边都没有才报未配置。
 */
app.get('/spam/pattern-file', async (c) => {
  requireAdmin(c);
  const env = c.env;
  const backend = await repoBackend(env);
  if (backend === 'none') {
    return ok({ path: SPAM_PATTERN_FILE, exists: false, content: '', backend, error: '未配置内容仓库，也没有 GIT_LOCAL_DIR 目录' });
  }
  try {
    const file = await readRepoFile(env, SPAM_PATTERN_FILE);
    return ok({
      path: SPAM_PATTERN_FILE,
      exists: Boolean(file),
      content: file?.content ?? '',
      sha: file?.sha ?? '',
      backend,
      error: file ? null : `文件还不存在：${SPAM_PATTERN_FILE}`,
    });
  } catch (e) {
    return ok({ path: SPAM_PATTERN_FILE, exists: false, content: '', backend, error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * PUT /api/admin/spam/pattern-file { content }
 * 写完立刻失效规则缓存（KV + 进程内两份），否则站主改完还要等 5 分钟才见效。
 */
app.put('/spam/pattern-file', async (c) => {
  const admin = requireAdmin(c);
  const env = c.env;
  const parsed = z.object({ content: z.string().max(200_000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '缺少文件内容 content');

  const backend = await repoBackend(env);
  if (backend === 'none') fail(500, '未配置内容仓库，也没有 GIT_LOCAL_DIR 目录，无法写入规则文件');

  const message = `zero-cms: 更新评论审核规则清单 ${SPAM_PATTERN_FILE}`;
  const result = await writeRepoFile(env, SPAM_PATTERN_FILE, parsed.data.content, message, {
    actor: admin,
    ip: clientIp(c),
    action: 'params',
    // repo.ts 在本地后端会自己记一条 content 流水，这里已经记了更详细的，不重复
    audit: false,
  });
  if (!result.success) fail(502, result.error ?? '写入失败');

  await invalidatePatternFile(env);
  resetPatternCache();
  await writeAudit(c.env, {
    actor: admin,
    action: 'params',
    target: SPAM_PATTERN_FILE,
    detail: { event: 'spam-pattern-file', backend, bytes: parsed.data.content.length, sha: result.sha ?? null },
    ip: clientIp(c),
  });
  return ok({ path: SPAM_PATTERN_FILE, sha: result.sha ?? null, backend: result.backend, bytes: parsed.data.content.length });
});

/* ---------------- 作者资料表：data/authors.yaml 的整份读写 ---------------- */

/**
 * GET /api/admin/authors/file —— 后台手工编辑作者表用。
 * 走 repo.ts：GitHub 配好读仓库，否则读 GIT_LOCAL_DIR；两边都没有只回错误说明，不 500。
 */
app.get('/authors/file', async (c) => {
  requireAdmin(c);
  try {
    return ok(await getAuthorsFile(c.env));
  } catch (e) {
    return ok({ path: AUTHORS_FILE_DEFAULT, exists: false, content: '', sha: '', error: errorMessage(e) });
  }
});

/**
 * 站长作者资料的头像兜底：本人上传的图 → 后台配的头像模板（{hash} / {email}）→ 按邮箱算的 Cravatar。
 * 与 account.ts 的 avatarOf 同一条优先级，只是这里必须回一个非空串（作者表头像字段必填）。
 */
async function authorAvatar(env: Env, row: { image: string | null; email: string } | null): Promise<string> {
  if (!row) return '';
  if (row.image) return row.image;
  const template = (await getConfig(env, 'avatarTemplate'))?.trim();
  if (template) return template.replaceAll('{hash}', emailMd5(row.email)).replaceAll('{email}', encodeURIComponent(row.email));
  return avatarForEmail(row.email);
}

/**
 * 会话里的管理员没有 handle，作者表按 handle 建键，所以现查一次账号行。
 * 顺手补齐：管理员这一行的 handle / 权限位 / 用户组如果还是空的（老库、或注册后才加上的这套逻辑），
 * 这里补完再返回，「我的信息 → 站长作者资料」就不会再因为缺标识而保存不了。
 */
async function adminHandle(env: Env, userId: string): Promise<{ handle: string; clash: boolean }> {
  const repair = await ensureAdminAuthorIdentity(env, userId);
  const rows = await createDb(env)
    .select({ handle: users.handle })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return { handle: resolveAuthorHandle(rows[0]?.handle ?? repair.handle), clash: repair.clash };
}

/**
 * GET /api/admin/authors/me —— 后台「我的信息 → 站长作者资料」读自己那一条。
 * 标识就是本人账号的 handle（站长的 handle 同时是 config 里的 defaultAuthor）。
 */
app.get('/authors/me', async (c) => {
  const admin = requireAdmin(c);
  const { handle, clash } = await adminHandle(c.env, admin.id);
  const profile = handle ? await readAuthorProfile(c.env, handle) : null;
  return ok({ handle, profile, clash, defaultAuthor: (await getConfig(c.env, 'defaultAuthor')) ?? '' });
});

/**
 * PUT /api/admin/authors/me { name, avatar, email, bio, website, social }
 * 只改作者身份信息：写 data/authors.yaml 里本人那一条（整份合并，不动别人的条目），
 * 并把 config 与 data/site.json 的 defaultAuthor 都指向本人标识 —— 前者供邮件落款与 SEO，
 * 后者才是主题构建期取署名的地方。两处都同步过一次 Pages 重建才有意义。
 * 账号资料（昵称/头像/简介）在 /api/account/profile 那套里改，两者互不覆盖。
 */
app.put('/authors/me', async (c) => {
  const admin = requireAdmin(c);
  const body = await c.req.json().catch(() => null);
  const parsed = z
    .object({
      name: z.string().max(60),
      avatar: z.string().max(500),
      email: z.string().max(160),
      bio: z.string().max(300).nullable().optional(),
      website: z.string().max(300).nullable().optional(),
      social: z.record(z.string().max(300)).nullable().optional(),
      donate: z.array(z.string().max(500)).max(6).nullable().optional(),
    })
    .safeParse(body);
  if (!parsed.success) fail(400, '作者资料格式不对：昵称、头像、邮箱为必填');
  const { handle, clash } = await adminHandle(c.env, admin.id);
  // 标识按注册信息推出来后基本不会缺；真缺了只可能是推出来的值被别的账号占了（clash），
  // 这时给一个能操作的说明，而不是原来那句把人赶去看不到的那一行的死循环提示。
  if (!handle) fail(400, clash ? '推出来的作者标识已被其它账号占用，请到「用户」页给站长这一行改一个标识' : '这个账号还没有作者标识，请到「用户」页补一个');

  const f = parsed.data;
  /*
   * 作者表要求 name / avatar / email 三项非空（前台卡片与 Gravatar 都靠它们），
   * 而站长的账号资料里 image / bio 经常是空的。这里按「账号资料铺默认值」补：
   * 空着就用账号的昵称 / 头像（没有头像就用后台配的 Gravatar 模板）/ 注册邮箱，
   * 免得第一次保存被「头像必填」挡在门外。
   */
  const accountRow = await createDb(c.env).select().from(users).where(eq(users.id, admin.id)).limit(1);
  const me = accountRow[0] ?? null;
  // 作者表的头像必填（前台卡片与 Gravatar 都靠它），留空时按账号资料逐级兜底
  const fallbackAvatar = await authorAvatar(c.env, me);
  let written;
  try {
    written = await upsertAuthor(
      c.env,
      {
        handle,
        name: f.name.trim() || me?.name || '站长',
        avatar: f.avatar.trim() || fallbackAvatar,
        email: f.email.trim() || me?.email || '',
        bioZh: f.bio ?? me?.bio ?? null,
        website: f.website ?? me?.website ?? null,
        // 站长本来就是认证作者：这一条写进作者表，作者页与署名的身份口径才不会和后台反着来
        verified: true,
        social: f.social ?? null,
        donate: f.donate ?? null,
      },
      { actor: admin, ip: clientIp(c) },
    );
  } catch (e) {
    fail(502, e instanceof Error ? e.message : '作者资料写入失败');
  }
  await setConfig(c.env, 'defaultAuthor', handle);
  // 前台署名是 Hugo 构建期读 data/site.json 的 defaultAuthor，不同步进仓库就一直是主题自带的占位作者
  const siteDefault = await setSiteDefaultAuthor(c.env, handle).catch((e) => ({
    ok: false,
    detail: e instanceof Error ? e.message : '写入失败',
  }));
  /* 这一笔改了两份构建期文件：data/authors.yaml 与 data/site.json（前台署名读它）。
     以前只请了一次重建、不跑体检 —— 写坏了界面也回「已保存」。现在走统一收尾。 */
  const done = await finishRepoWrites(c.env, 1).catch(() => ({ build: null, buildHealth: null }));
  const build = done.build;
  const buildHealth = done.buildHealth;
  await writeAudit(c.env, {
    actor: admin,
    action: 'authorRequest',
    target: handle,
    detail: { event: 'self-author-profile', path: written.path, created: written.created, defaultAuthor: siteDefault, build, buildHealth },
    ip: clientIp(c),
  });
  /* 回执文字用 services/git.ts 的 buildReceipt 拼，别在后台再手抄一遍三档判断：
     后台那份抄本只看 triggered，于是 Git 直连构建的站（大多数站）每次保存都被提示
     「站点重建没触发，请稍后手动重建」—— R37 修接口回执、R61 修 cron 回执，这是第三处。 */
  const receipt = buildReceipt(done.build, `作者资料已写入 ${written.path ?? 'data/authors.yaml'}`);
  return ok({ ...written, handle, defaultAuthor: siteDefault, build, buildHealth, receipt });
});

/**
 * PUT /api/admin/authors/file { content, message } —— 整份覆盖作者表。
 * 先确认文本能被 parseAuthorsYaml 认下来再写：写坏一份 data/authors.yaml，
 * 前台所有作者卡片一起空白，排查成本比这次提交高得多。
 */
app.put('/authors/file', async (c) => {
  const admin = requireAdmin(c);
  const parsed = z
    .object({ content: z.string().max(200_000), message: z.string().max(200).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '缺少作者表内容 content');

  const problem = validateAuthorsYaml(parsed.data.content);
  if (problem) fail(400, `作者表解析失败：${problem}`);
  let table: Record<string, unknown>;
  try {
    table = parseAuthorsYaml(parsed.data.content);
  } catch (e) {
    fail(400, `作者表解析失败：${errorMessage(e)}`);
  }
  /* 手工整份覆盖是「一键清空全站署名」最容易发生的地方（全选再保存就是空文件）：空表直接拒。
     程序内部的合并写入不走这条判断，那类路径不会把整份表抹掉。 */
  if (!Object.keys(table).length) fail(400, '作者表是空的：这样保存会让前台作者页与所有文章署名一起空白。要删某位作者，只删那一段即可');

  const result = await putAuthorsFile(c.env, parsed.data.content, {
    message: parsed.data.message,
    actor: admin,
    ip: clientIp(c),
    action: 'authorRequest',
    // repo.ts 在本地后端会自己记一条流水，这里记更详细的，不重复
    audit: false,
  });
  if (!result.success) fail(502, result.error ?? '作者表写入失败');

  /* 这份文件是我们自己的行扫描解析（parseAuthorsYaml）认下来才写的 —— 但「我们认得」不等于
     go-yaml 认得：整份覆盖口粘来一个 `zhizhi: {`（流式映射没闭合）之类，我们的扫描当它是普通键值，
     Hugo 却是 failed to load data → **整站构建失败**，而接口回的是「已保存」。
     所以这一条必须跑构建体检 —— 闸门只覆盖 links.yaml，这里就是唯一的兜底。 */
  const done = await finishRepoWrites(c.env, 1).catch(() => ({ build: null, buildHealth: null }));

  await writeAudit(c.env, {
    actor: admin,
    action: 'authorRequest',
    target: result.path ?? (await authorsFilePath(c.env)),
    detail: {
      event: 'authors-file',
      backend: result.backend,
      bytes: parsed.data.content.length,
      sha: result.sha ?? null,
      build: done.build,
      buildHealth: done.buildHealth,
    },
    ip: clientIp(c),
  });
  return ok({
    path: result.path,
    sha: result.sha ?? null,
    backend: result.backend,
    bytes: parsed.data.content.length,
    build: done.build,
    buildHealth: done.buildHealth,
  });
});

/* ---------------- 运行状况与数据统计 ---------------- */

app.get('/health-detail', async (c) => {
  requireAdmin(c);
  const env = c.env;
  const db = createDb(env);
  const started = Date.now();

  /*
   * 定时任务：每个任务取最近一次执行，全量返回。
   * 之前是「最近 20 条流水里过滤掉 friends:feed 再截前 6 条」，前端按数组遍历、
   * 这里给的是 { recent: [...] } 对象，结果 {#if health.checks.cron?.length} 永远为假，
   * 表格里明明跑过的任务也一律显示「尚未执行过」。
   */
  const jobsLatest = await db
    .select({
      name: jobRuns.name,
      status: jobRuns.status,
      detail: jobRuns.detail,
      startedAt: jobRuns.startedAt,
      finishedAt: jobRuns.finishedAt,
    })
    .from(jobRuns)
    .where(
      sql`${jobRuns.startedAt} = (select max(j2.started_at) from job_runs j2 where j2.name = ${jobRuns.name})`,
    )
    .orderBy(desc(jobRuns.startedAt));
  /** 显示名由 scheduler 那一份名单给（见 services/scheduler.ts 的 JOB_LABELS）：
   *  以前这份抄在后台里，任务改了名字界面上就退回英文键，10 条里 7 条没人看得懂。 */
  const jobs = jobsLatest.map((j) => ({ ...j, label: JOB_LABELS[j.name] ?? j.name }));

  const checks: Record<string, unknown> = { apiLatencyMs: 0 };
  try {
    const r = await env.DB.prepare('select 1 as ok').first();
    checks.d1 = { ok: Boolean(r), detail: '连接正常' };
  } catch (e) {
    checks.d1 = { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }

  /* R2 / KV 的 list 是分页的：limit 只是单页大小，不是总量。
     以前把「这一页数到几个」当成总量显示（对象 5 个 / 缓存键 100 个），
     现在翻完所有分页；超过 50 页（约 5 万条）就停下来标「50000+」。 */
  const tally = async (kind: 'r2' | 'kv'): Promise<{ ok: boolean; detail: string; count: number; capped: boolean }> => {
    try {
      let count = 0;
      let cursor: string | undefined;
      let capped = false;
      for (let page = 0; page < 50; page++) {
        if (kind === 'r2') {
          const listed = await env.R2.list({ cursor, limit: 1000 });
          count += listed.objects.length;
          capped = listed.truncated;
          cursor = listed.truncated ? listed.cursor : undefined;
        } else {
          const listed = await env.CACHE.list({ cursor, limit: 1000 });
          count += listed.keys.length;
          capped = listed.list_complete === false;
          cursor = listed.list_complete === false ? listed.cursor : undefined;
        }
        if (!cursor) break;
      }
      /* 单位写清楚：以前只回「20 个」，卡片上拼成「对象存储 · 20 个」，
         读起来像「20 个对象存储」。 */
      const unit = kind === 'r2' ? '个对象' : '个键';
      return { ok: true, detail: `${count.toLocaleString('zh-CN')}${capped ? '+' : ''} ${unit}`, count, capped };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), count: 0, capped: false };
    }
  };
  const [r2, kv] = await Promise.all([tally('r2'), tally('kv')]);
  checks.r2 = { ok: r2.ok, detail: r2.detail };
  checks.kv = { ok: kv.ok, detail: kv.detail };

  checks.emailQueue = { ok: Boolean(env.EMAIL_QUEUE), detail: env.EMAIL_QUEUE ? '已绑定' : '未绑定队列' };
  checks.cron = jobs;

  /* 发信凭据：后台填在 D1 里的密码同样算数（邮件发送就是按「D1 优先、其次 wrangler secret」取的），
     只看 env.SMTP_PASSWORD 会让用后台密码的站永远显示红灯。 */
  const provider = (await getConfig(env, 'emailProvider')) ?? 'smtp';
  const credentialSource =
    provider === 'resend'
      ? (await getConfig(env, 'resendApiKey'))
        ? '后台已填'
        : env.RESEND_API_KEY
          ? 'wrangler secret'
          : '未配置'
      : provider === 'cloudflare'
        ? (await getConfig(env, 'cloudflareEmailToken'))
          ? '后台已填'
          : env.CF_EMAIL_API_TOKEN
            ? 'wrangler secret'
            : '未配置'
        : (await getConfig(env, 'smtpPassword'))
          ? '后台已填'
          : env.SMTP_PASSWORD
            ? 'wrangler secret'
            : '未配置';
  checks.email = {
    provider,
    host: (await getConfig(env, 'smtpHost')) || '',
    from: (await getConfig(env, 'emailFrom')) || '',
    secretConfigured: await emailOtpAvailable(env),
    credentialSource,
  };

  /* 近 24 小时的发信结果：以前只看「凭据在不在」，一封封失败都盖在绿灯下面，
     直到收件人自己来问。email_logs 里本来就有每条的状态，这里顺手统计一次。 */
  try {
    const since24 = Math.floor(Date.now() / 1000) - 86400;
    const [day] = await db
      .select({
        sent: sql<number>`sum(case when ${emailLogs.status} = 'sent' then 1 else 0 end)`,
        failed: sql<number>`sum(case when ${emailLogs.status} = 'failed' then 1 else 0 end)`,
        queued: sql<number>`sum(case when ${emailLogs.status} = 'queued' then 1 else 0 end)`,
      })
      .from(emailLogs)
      .where(gte(emailLogs.createdAt, since24));
    const lastFail = await db
      .select({ at: emailLogs.createdAt, error: emailLogs.error })
      .from(emailLogs)
      .where(and(eq(emailLogs.status, 'failed'), gte(emailLogs.createdAt, since24)))
      .orderBy(desc(emailLogs.createdAt))
      .limit(1);
    checks.email = {
      ...(checks.email as Record<string, unknown>),
      last24h: {
        sent: Number(day?.sent ?? 0),
        failed: Number(day?.failed ?? 0),
        queued: Number(day?.queued ?? 0),
        lastError: lastFail[0] ? { at: lastFail[0].at, error: lastFail[0].error ?? '' } : null,
      },
    };
  } catch (e) {
    checks.email = { ...(checks.email as Record<string, unknown>), last24h: { error: errorMessage(e) } };
  }

  /* 边缘缓存清除的配对状态。为什么算进运行状况：这两项没配时**不是报错**，而是删掉的文章
     在 CDN 上继续能访问（边缘那份旧 HTML 还在，强刷也没用），而那只在「删除的回包备注」里说过一次，
     没人删文章就永远看不到。缺配置不该只在出错那一刻才说话。 */
  const purgeZone = ((await getConfig(env, 'cfZoneId')) ?? '').trim();
  const purgeTokenSet = Boolean(((await getConfig(env, 'cfPurgeToken')) ?? '').trim());
  /* 近 3 小时有多少请求没带 cf-connecting-ip（只能按兜底常量分桶）。
     这一项不是错误：绕过 Pages 边缘的入口才会走到，但一旦发生，所有按 IP 的额度会互相顶掉，
     没有这一笔可见性就永远靠猜。 */
  checks.ip = {
    fallbackLast3h: await ipFallbackCount(c.env),
    note: '这些请求没带 cf-connecting-ip，只能按同一个兜底地址分桶；正常经 Cloudflare 边缘来的访客不该计到这里',
  };

  checks.purge = {
    ok: Boolean(purgeZone && purgeTokenSet),
    detail: purgeZone && purgeTokenSet ? `zone ${purgeZone.slice(0, 8)}…` : [!purgeZone && '没填 Zone ID', !purgeTokenSet && '没填令牌'].filter(Boolean).join('、'),
  };

  checks.apiLatencyMs = Date.now() - started;
  return ok({ checks, jobs });
});

app.get('/stats', async (c) => {
  requireAdmin(c);
  const db = createDb(c.env);
  const since7 = Math.floor(Date.now() / 1000) - 7 * 86400;
  /* 排除导入数据：评论导入时写了 is_legacy = true，这里只影响这个视图，
     不动库里任何一条数据。统计页的开关会带 ?excludeLegacy=1。 */
  const q = String(c.req.query('excludeLegacy') ?? '').toLowerCase();
  const clean = q === '1' || q === 'true';
  const notLegacyComment = clean ? eq(comments.isLegacy, false) : undefined;
  const [articleCount] = await db.select({ n: sql<number>`count(*)` }).from(comments).where(gte(comments.createdAt, since7));
  void articleCount;
  const [commentCount] = await db.select({ n: sql<number>`count(*)` }).from(comments).where(notLegacyComment);
  const [pendingCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(comments)
    .where(and(eq(comments.status, 'pending'), notLegacyComment));
  const [subscriberCount] = await db.select({ n: sql<number>`count(*)` }).from(subscribers).where(eq(subscribers.status, 'confirmed'));
  const [userCount] = await db.select({ n: sql<number>`count(*)` }).from(users);
  const emails = await db
    .select({ status: emailLogs.status, n: sql<number>`count(*)` })
    .from(emailLogs)
    .groupBy(emailLogs.status);
  return ok({
    comments: Number(commentCount?.n ?? 0),
    pendingComments: Number(pendingCount?.n ?? 0),
    subscribers: Number(subscriberCount?.n ?? 0),
    users: Number(userCount?.n ?? 0),
    email: Object.fromEntries(emails.map((e) => [e.status, Number(e.n)])),
    excludeLegacy: clean,
  });
});

/**
 * POST /api/admin/stats/recount —— 按明细重算「建站以来累计」（可演习）。
 *
 * 每日对账只抬不降；导入旧站数据/误删明细后，计数器会偏大，只能人工校正。
 * 请求体 { apply?: boolean }：缺省/ false 只回当前值和建议值，true 才写库。
 * 明细有保留期，重算后的累计只等于「还留着的明细」，应用前必须让站长看到这一点。
 */
app.post('/stats/recount', async (c) => {
  const admin = requireAdmin(c);
  const body = (await c.req.json().catch(() => null)) as { apply?: boolean } | null;
  const res = await recountLifetimeCounters(c.env, { apply: body?.apply === true });
  if (res.applied) {
    await writeAudit(c.env, {
      actor: admin,
      action: 'stats',
      target: 'lifetime',
      detail: `累计重算：浏览 ${res.current.views} → ${res.computed.views}，访客 ${res.current.visitors} → ${res.computed.visitors}`,
      ip: clientIp(c),
    });
  }
  return ok(res);
});

/**
 * 文章与时刻的数量：按「设置 → 内容仓库」里的文章目录、时刻目录递归数 .md。
 * 之前只 listDir 一层（githubContentDir，默认 content），而文章实际在 content/posts/ 下，
 * 所以仪表盘那个「文章」卡片数出来的永远是 0（或多语言布局下少算一整层）。
 * 用的就是备份分区同一份递归列举，两处口径不会再分叉。
 *
 * `_index.md` 不算一篇：它是目录说明文件（管列表页要不要生成、栏目描述写在哪），
 * 把它数进去，仪表盘就比真实内容多出一篇「文章」。
 */
app.get('/stats/content', async (c) => {
  requireAdmin(c);
  const postsDir = (await getConfig(c.env, 'githubPostsDir'))?.trim() || 'content/zh/posts';
  const momentsDir = (await getConfig(c.env, 'githubMomentsDir'))?.trim() || 'content/zh/moments';
  const isPage = (p: string) => !(p.split('/').pop() ?? '').startsWith('_');
  try {
    const target = await repoTarget(c.env);
    const [posts, moments] = await Promise.all([
      (await walkFiles(target, postsDir, { exts: ['.md'], cap: CONTENT_COUNT_CAP })).filter(isPage),
      (await walkFiles(target, momentsDir, { exts: ['.md'], cap: CONTENT_COUNT_CAP })).filter(isPage),
    ]);
    return ok({
      postsDir,
      momentsDir,
      posts: posts.length,
      moments: moments.length,
      capped: posts.length >= CONTENT_COUNT_CAP || moments.length >= CONTENT_COUNT_CAP,
    });
  } catch (e) {
    return ok({ postsDir, momentsDir, posts: 0, moments: 0, capped: false, error: errorMessage(e) });
  }
});

/**
 * GET /api/admin/stats/reactions —— 点赞与收藏按页面盘点。
 *
 * 以前后台没有任何地方看得见 reactions 表：匿名赞能不能被刷、哪一页的赞数对不上，
 * 站长只能翻数据库。这里给一个按票数排序的清单（标题由后台拿 /api/admin/posts 自己配）。
 * actors 是「几个不同来源」：票数远大于人数就是刷出来的。
 */
app.get('/stats/reactions', async (c) => {
  requireAdmin(c);
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);
  const q = String(c.req.query('excludeLegacy') ?? '').toLowerCase();
  const clean = q === '1' || q === 'true';
  /* 导入旧站点赞时 fingerprint 写成 legacy:<hash>:like:<序号>；登录用户的 fingerprint 是 NULL，
     coalesce 之后才不会被 NOT LIKE 一并滤掉 */
  const notLegacyReaction = clean ? sql`coalesce(${reactions.fingerprint}, '') not like 'legacy:%'` : undefined;
  const db = createDb(c.env);
  const [rows, total, pages] = await Promise.all([
    db
      .select({
        slug: reactions.targetSlug,
        likes: sql<number>`sum(case when ${reactions.kind} = 'like' then 1 else 0 end)`,
        stars: sql<number>`sum(case when ${reactions.kind} = 'star' then 1 else 0 end)`,
        actors: sql<number>`count(distinct coalesce(${reactions.userId}, ${reactions.fingerprint}))`,
        lastAt: sql<number>`max(${reactions.createdAt})`,
      })
      .from(reactions)
      .where(notLegacyReaction)
      .groupBy(reactions.targetSlug)
      .orderBy(sql`(sum(case when ${reactions.kind} = 'like' then 1 else 0 end) + sum(case when ${reactions.kind} = 'star' then 1 else 0 end)) desc`)
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(reactions).where(notLegacyReaction),
    db.select({ n: sql<number>`count(distinct ${reactions.targetSlug})` }).from(reactions).where(notLegacyReaction),
  ]);
  return ok({
    rows: rows.map((r) => ({ slug: r.slug, likes: Number(r.likes), stars: Number(r.stars), actors: Number(r.actors), lastAt: Number(r.lastAt) })),
    limit,
    offset,
    reactionRows: Number(total[0]?.n ?? 0),
    pages: Number(pages[0]?.n ?? 0),
    excludeLegacy: clean,
  });
});

/**
 * 友链 / 站点联盟管理（挂在 /api/admin/friends）。
 *
 * 旧路径 /api/friends/*（routes/friends.ts）仍可用，两处调的是同一批
 * services/friends-groups.ts 里的函数，所以顺序与分组只有一份实现。
 *
 *   GET    /api/admin/friends                 分组列表（含健康详情）
 *   POST   /api/admin/friends                 新增，kind 缺省 friend，sortOrder 缺省排到组尾
 *   PATCH  /api/admin/friends/:id             改字段；kind=friend|alliance 即在两组间移动，sortOrder 改位置
 *   DELETE /api/admin/friends/:id             删除（连同桌该站聚合的文章）
 *   POST   /api/admin/friends/reorder         整组保存顺序 {items:[{id,kind,sortOrder}]}
 */

app.get('/friends', async (c) => {
  requireAdmin(c);
  return ok(groupFriendsDetail(await loadFriends(c.env)));
});

app.post('/friends', async (c) => {
  const admin = requireAdmin(c);
  /* 原样把 createFriend 的结果回出去：以前这里只挑了 {id, item}，
     于是 linksFile（那份 yaml 有没有写回去 + 构建体检）在新增这一条路上被丢掉 ——
     改 / 删 / 排序都看得见「已同步 / 没同步」，唯独新增看不见，界面只能统一回一句
     「只改了数据库」，而那恰好是错的（文件其实写了）。 */
  return ok(await createFriend(c.env, admin, await c.req.json().catch(() => null), { ip: clientIp(c) }));
});

app.post('/friends/reorder', async (c) => {
  const admin = requireAdmin(c);
  return ok(await reorderFriends(c.env, admin, await c.req.json().catch(() => null), { ip: clientIp(c) }));
});

app.patch('/friends/:id', async (c) => {
  const admin = requireAdmin(c);
  return ok(await updateFriend(c.env, admin, c.req.param('id'), await c.req.json().catch(() => null), { ip: clientIp(c) }));
});

app.delete('/friends/:id', async (c) => {
  const admin = requireAdmin(c);
  return ok(await deleteFriend(c.env, admin, c.req.param('id'), { ip: clientIp(c) }));
});

export default app;
