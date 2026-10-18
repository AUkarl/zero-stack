import { Hono } from 'hono';
import { desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../db/client';
import { comments, emailLogs, jobRuns, reactions, subscribers, users, visits } from '../db/schema';
import { getAllConfig, getConfig, apiBase, isConfigKey, isSecretKey, maskSecrets, setConfig } from '../services/config';
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
import { notifySelfTest } from '../services/comment-notify';
import { linksFilePath } from '../services/friends-file';
import { setSiteDefaultAuthor } from './frontend';
import { purgePageUrls } from '../services/cf-purge';
import { inspectComment, invalidatePatternFile, DEFAULT_SPAM_PATTERN_TEXT, SPAM_PATTERN_FILE, resetPatternCache } from '../services/moderation';
import { clientIp } from '../lib/http';
import { errorMessage, fail, ok } from '../lib/errors';
import { requireAdmin } from '../middleware/auth';
import { deleteFile, listDir, readFile, writeFile } from '../services/git';
import { repoTarget, triggerPagesBuild } from '../services/git';
import { listRepoDir, pruneLocalBuild, readRepoFile, repoBackend, walkFiles, writeRepoFile } from '../services/repo';
import { listBuckets, maskBucket, resolveBucket, putMediaObject, listMediaObjects, getMediaObject, mediaObjectExists, deleteMediaObject, objectPath, type MediaBucket } from '../services/media';
import {
  buildMarkdown,
  contentWebPath,
  excerpt,
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
import { exportPostStats } from '../services/scheduler';
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
  return Response.json({ data, hasSecret });
});

const configWriteSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

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

  const updated: string[] = [];
  for (const [key, value] of Object.entries(parsed.data)) {
    if (!isConfigKey(key)) fail(400, `未知配置项 ${key}`);
    // 密钥字段读取时是空串，后台原样提交回来不能把已存的值抹掉
    if (isSecretKey(key) && value === '') continue;
    const asString = typeof value === 'string' ? value : JSON.stringify(value);
    await setConfig(c.env, key, asString, typeof value === 'string' ? 'string' : typeof value);
    updated.push(key);
  }

  await writeAudit(c.env, {
    actor: admin,
    action: 'config',
    target: updated.join(','),
    detail: { keys: updated },
    ip: clientIp(c),
  });
  return ok({ updated: updated.length, keys: updated });
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
  return ok(filtered);
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
    .object({ ids: z.array(z.string().max(64)).min(1).max(200), action: z.enum(['approve', 'spam']) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '参数有误：一次最多 200 条');
  const db = createDb(c.env);
  for (const id of parsed.data.ids) {
    await db.update(comments).set({ status: parsed.data.action === 'approve' ? 'approved' : 'spam' }).where(eq(comments.id, id));
  }
  await writeAudit(c.env, {
    actor: admin,
    action: 'comment',
    target: `${parsed.data.ids.length} 条`,
    detail: { action: parsed.data.action, ids: parsed.data.ids.slice(0, 50) },
    ip: clientIp(c),
  });
  return ok({ handled: parsed.data.ids.length, status: parsed.data.action === 'approve' ? 'approved' : 'spam' });
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

/** 操作留痕：谁在什么时候改了什么 */
app.get('/audit', async (c) => {
  requireAdmin(c);
  const rows = await listAudit(c.env, {
    action: c.req.query('action') || undefined,
    from: Number(c.req.query('from')) || undefined,
    to: Number(c.req.query('to')) || undefined,
    limit: Number(c.req.query('limit')) || 100,
  });
  return ok(
    rows.map((r) => ({
      id: r.id,
      actorName: r.actorName,
      action: r.action,
      target: r.target,
      detail: parseDetail(r.detail),
      ip: r.ip,
      createdAt: r.createdAt,
    })),
  );
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

function safePath(p: string): string {
  const clean = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean) fail(400, '缺少文件路径');
  const segs = clean.split('/');
  if (segs.some((seg) => seg === '' || seg === '.' || seg === '..')) fail(400, '路径不合法');
  if (segs[0] !== 'content') fail(400, '只能写入 content/ 下的 .md 文件');
  if (!clean.endsWith('.md') || clean === '.md') fail(400, '只能写入 content/ 下的 .md 文件');
  if (BAD_PATH_CHARS.test(clean)) fail(400, '文件名含有系统保留字符，请去掉 : " < > | ? * 与控制字符');
  if (segs[segs.length - 1]!.trim() === '.md') fail(400, '文件名不能为空');
  if (clean.length > 300) fail(400, '路径过长（上限 300 字符）');
  return clean;
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
  | { ok: true; path: string; sha?: string; bytes: number; notify: NotifyResult; purgedBuild: string[] }
  | { ok: false; path: string; reason: 'invalid' | 'conflict' | 'failed'; error: string };

type NotifyResult = { jobId?: string; sent?: number; failed?: number; skipped?: string };

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

/**
 * 写一个内容文件：拼 front matter → sha 乐观锁 → 提交 → 按需群发。
 * 不抛 HTTP 异常、不清缓存、不触发构建，这三件都由调用方在整批做完后统一做一次，
 * 免得一次批量推送把 Pages 构建配额和后台缓存刷爆。
 */
async function writeContentItem(env: Env, admin: { id?: string | null }, item: ContentItem): Promise<ContentOutcome> {
  const path = safePath(item.path ?? '');
  if (!path) return { ok: false, path: String(item.path ?? ''), reason: 'invalid', error: '路径不合法' };
  const settings = await repoTarget(env);

  let content: string;
  try {
    if (item.front && typeof item.front === 'object') {
      const front = orderFront(await withAuthorFallback(env, path, item.front as Front));
      // 时刻（朋友圈式动态）没有标题，正文/图/音/视频任一非空即可；标题必填只针对文章
      if (isPostPath(path) && !String(front.title ?? '').trim()) throw new Error('标题不能为空');
      content = buildMarkdown(front, (item.body ?? '').trim());
    } else if (typeof item.content === 'string') {
      content = item.content;
    } else {
      throw new Error('缺少正文');
    }
  } catch (e) {
    return { ok: false, path, reason: 'invalid', error: e instanceof Error ? e.message : String(e) };
  }

  // 带 sha 就是乐观锁：别人在你编辑期间改过就不覆盖（批量时这一条被跳过，其余照推）
  if (item.sha) {
    const current = await readFile({ ...settings, path }).catch(() => null);
    if (current && current.sha && current.sha !== item.sha) {
      return { ok: false, path, reason: 'conflict', error: '这篇在你编辑期间已被改动，未覆盖' };
    }
  }

  const message = (item.message || '').trim() || `content: update ${path}`;
  const result = await writeFile({ ...settings, path, content, message });
  if (!result.success) return { ok: false, path, reason: 'failed', error: result.error ?? '提交失败' };

  const parsed = parseFrontMatter(content);
  /* 草稿与线上必须一致：Hugo 不带 -D 时根本不渲染 draft，可本地 `hugo server`
     已经把「取消发布」前的那一份写进 public/ 了，不摘掉就会出现「后台标了草稿、
     前台还打得开」。线上 Pages 每次是干净目录，没这一步。 */
  const purgedBuild: string[] = [];
  const ref = buildPageRef(path);
  if (ref && isDraftFront(parsed.front)) {
    purgedBuild.push(...(await pruneLocalBuild(settings, { ...ref, title: String(parsed.front.title ?? '').trim() })));
  }

  const notify: NotifyResult = item.notifySubscribers ? await notifyPostSubscribers(env, admin.id ?? '', path, parsed) : {};
  return { ok: true, path, sha: result.sha, bytes: content.length, notify, purgedBuild };
}

/** 「发布后群发订阅」：只有非草稿的文章能发，草稿只入库不推送 */
async function notifyPostSubscribers(env: Env, adminId: string, path: string, parsed: ParsedMarkdown): Promise<NotifyResult> {
  if (!/\/posts\//.test(path)) return { skipped: '只有文章可以群发' };
  if (isDraftFront(parsed.front)) return { skipped: '草稿不群发' };

  const site = (await getConfig(env, 'siteName')) || '';
  const title = String(parsed.front.title ?? path);
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

/** 整批写完统一做的一次收尾：清后台文章列表缓存 + 触发一次站点重建 */
async function finishContentWrite(env: Env, changed: number, triggerBuild: boolean): Promise<{ triggered?: boolean; error?: string } | null> {
  if (!changed) return null;
  await kvDelete(env, POSTS_CACHE_KEY);
  // 前台是 Hugo 构建出来的静态页：不触发重建，新文章不会出现在列表里，改过的正文也不会变
  return triggerBuild ? await triggerPagesBuild(env) : null;
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
    },
    ip: clientIp(c),
  });
  const build = await finishContentWrite(c.env, 1, body?.triggerBuild !== false);
  return ok({ ...outcome, build });
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
  }[] = [];
  let done = 0;
  for (const item of files) {
    const r = await writeContentItem(c.env, admin, item);
    // 成功的那几篇要把新 sha 带回去：前端本地暂存里存的是提交前的 sha，不带回来下次推送必然报冲突
    if (r.ok) done++;
    results.push(
      r.ok
        ? { path: r.path, ok: true, sha: r.sha, bytes: r.bytes, notify: r.notify, purgedBuild: r.purgedBuild }
        : { path: r.path, ok: false, reason: r.reason, error: r.error },
    );
  }

  await writeAudit(c.env, {
    actor: admin,
    action: 'content',
    target: results.map((r) => r.path).join(','),
    detail: { event: 'batch', total: results.length, done, failed: results.filter((r) => !r.ok).map((r) => `${r.path}:${r.reason ?? ''}`) },
    ip: clientIp(c),
  });
  const build = await finishContentWrite(c.env, done, input?.triggerBuild !== false);
  return ok({
    total: results.length,
    done,
    results,
    build,
    message: done ? `已推送 ${done}/${results.length} 篇${build?.triggered ? '，已请求站点重建' : ''}` : '没有推送成功，内容都留在本地暂存里',
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
 *    边缘按 7 天 max-age 还会继续端出旧页面，用户强刷也刷不掉。
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
  if (ref) {
    const before = await readFile({ ...settings, path }).catch(() => null);
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
  const build = c.req.query('build') === '0' ? null : await triggerPagesBuild(env);
  /* 重建之外还要清边缘缓存：Pages 的 HTML 在 CDN 上是 7 天 max-age，
     不清的话「后台删了文章、前端还能打开」会一直复现，而且用户强刷也没用。
     只有 markdown 文章才有站内地址；删别的文件（比如数据文件）不用清。 */
  const purge = ref ? await purgePageUrls(env, [contentWebPath(path)]) : null;
  await writeAudit(env, {
    actor: admin,
    action: 'content',
    target: path,
    detail: { event: 'delete', purged, purgedBuild, purge, build: build ? 'requested' : 'skipped' },
    ip: clientIp(c),
  });
  return ok({ ...result, purged, purgedBuild, purge, build });
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
  if (sha && current && current.sha !== sha) {
    fail(409, '这份文件在你编辑期间已被改动，请重新读取后再保存，不要直接覆盖');
  }

  const committed = await writeRepoFile(c.env, path, content, message || `zero-cms: 更新 ${path}`, {
    actor: admin,
    ip: clientIp(c),
    action: 'config',
  });
  if (!committed.success) fail(502, committed.error ?? '写入失败');
  const build = triggerBuild ? await triggerPagesBuild(c.env) : null;
  await writeAudit(c.env, {
    actor: admin,
    action: 'config',
    target: path,
    detail: { event: 'repo-file.write', bytes: content.length, sha: committed.sha },
    ip: clientIp(c),
  });
  return ok({ path, sha: committed.sha, bytes: content.length, build, message: '已写入仓库，站点构建已请求' });
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
  const ext = (file.name.split('.').pop() ?? 'bin').toLowerCase();
  const key = `uploads/${new Date().toISOString().slice(0, 10)}/${newId()}.${ext}`;
  const stored = await putMediaObject(c.env, bucket, {
    key,
    data: file.stream(),
    contentType: file.type || 'application/octet-stream',
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

  const stored = await putMediaObject(c.env, bucket, {
    key,
    data: file.stream(),
    contentType: file.type || 'application/octet-stream',
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
app.get('/media/list', async (c) => {
  requireAdmin(c);
  const bucket = await bucketFrom(c.env, c.req.url);
  const prefix = c.req.query('prefix') ?? 'uploads/';
  const limit = Math.min(Number(c.req.query('limit') ?? '200') || 200, 1000);
  const listed = await listMediaObjects(c.env, bucket, { prefix, limit, cursor: c.req.query('cursor') });
  return ok({
    bucket: bucket.id,
    truncated: listed.truncated,
    cursor: listed.truncated ? (listed.cursor ?? null) : null,
    // 字段名沿用旧接口（uploaded），后台列表就按这个渲染
    objects: listed.objects.map((o) => ({ key: o.key, name: o.name, size: o.size, uploaded: o.lastModified, url: o.url })),
  });
});

/**
 * GET /api/admin/media/* —— 两种写法都认：
 *   /media/uploads/2026-10-01/a.png?bucket=oss
 *   /media/object/oss/uploads/2026-10-01/a.png（services/media.ts 的 objectUrl 生成的是这个）
 * 私有 S3 桶没有签名直连拿不到对象，所以没配 baseUrl 时全靠这里代理。
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
  const bucket = await resolveBucket(c.env, c.req.query('bucket') || bucketId || '');
  const object = await getMediaObject(c.env, bucket, key);
  if (!object) fail(404, '文件不存在');
  return new Response(object.data as BodyInit, {
    headers: { 'Content-Type': object.contentType, 'Cache-Control': 'private, max-age=300' },
  });
});

/** DELETE /api/admin/media/*?bucket= */
app.delete('/media/*', async (c) => {
  const admin = requireAdmin(c);
  const { key, bucketId } = mediaKeyAndBucket(c.req.url);
  const bucket = await resolveBucket(c.env, c.req.query('bucket') || bucketId || '');
  const removed = await deleteMediaObject(c.env, bucket, key);
  await writeAudit(c.env, {
    actor: admin,
    action: 'media',
    target: removed.key,
    detail: { event: 'delete', bucket: bucket.id, via: objectPath(bucket, removed.key) },
    ip: clientIp(c),
  });
  return ok({ key: removed.key, bucket: bucket.id, deleted: true });
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
  const site = (await getConfig(env, 'siteName')) ?? '本站';
  const res = await sendEmail(env, { to: parsed.data.to, subject: `【${site}】测试邮件（${kind}）`, html, kind: 'notice' });
  await writeAudit(env, {
    actor: admin,
    action: 'config',
    target: 'email:test',
    detail: { to: parsed.data.to, kind, success: res.success, error: res.error ?? null },
    ip: clientIp(c),
  });
  return ok({ sent: res.success, error: res.error ?? null, kind, to: parsed.data.to });
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
    action: 'config',
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
  const site = (await getConfig(env, 'siteName')) ?? '本站';
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
        content: '这段是示例正文，用来看引用块与换行在信里的样子。\n第二行。',
        url: `${home}/posts/1984/`,
        title: '《1984》阅读笔记',
      },
      base,
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
    const siteName = (await getConfig(c.env, 'siteName')) ?? 'Zero';
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

/** 缓存读写都不能把主流程带崩：KV 在本地 dev 偶尔会抽风 */
async function kvGet(env: Env, key: string): Promise<unknown | null> {
  try {
    return await env.CACHE.get(key, 'json');
  } catch {
    return null;
  }
}

/** 内容写回仓库后清掉文章列表缓存，后台下一次读到的就是刚改过的 */
async function kvDelete(env: Env, key: string): Promise<void> {
  try {
    await env.CACHE.delete(key);
  } catch {
    /* 清不掉就等 TTL 过期，不影响写入本身 */
  }
}

async function kvPut(env: Env, key: string, value: unknown, ttl: number): Promise<void> {
  try {
    await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
    /* 下次再缓存 */
  }
}

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
  const files = entries.filter((f) => f.type === 'file' && /\.mdx?$/i.test(f.name) && !/^_index\./i.test(f.name));
  for (const f of files) {
    const path = f.path || `${dir}/${f.name}`;
    let file;
    try {
      file = await readRepoFile(env, path);
    } catch {
      continue; // 单篇读失败不影响其它
    }
    if (!file) continue;
    const { front } = parseFrontMatter(file.content);
    if (front.draft === true || String(front.draft).toLowerCase() === 'true') continue;
    items.push({
      id: path,
      path,
      title: String(front.title ?? '') || path.split('/').pop()!.replace(/\.mdx?$/i, ''),
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
    action: 'config',
    // repo.ts 在本地后端会自己记一条 content 流水，这里已经记了更详细的，不重复
    audit: false,
  });
  if (!result.success) fail(502, result.error ?? '写入失败');

  await invalidatePatternFile(env);
  resetPatternCache();
  await writeAudit(c.env, {
    actor: admin,
    action: 'config',
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
  const build = await triggerPagesBuild(c.env).catch((e) => ({
    triggered: false,
    error: e instanceof Error ? e.message : '触发失败',
  }));
  await writeAudit(c.env, {
    actor: admin,
    action: 'authorRequest',
    target: handle,
    detail: { event: 'self-author-profile', path: written.path, created: written.created, defaultAuthor: siteDefault, build },
    ip: clientIp(c),
  });
  return ok({ ...written, handle, defaultAuthor: siteDefault, build });
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
  try {
    parseAuthorsYaml(parsed.data.content);
  } catch (e) {
    fail(400, `作者表解析失败：${errorMessage(e)}`);
  }

  const result = await putAuthorsFile(c.env, parsed.data.content, {
    message: parsed.data.message,
    actor: admin,
    ip: clientIp(c),
    action: 'authorRequest',
    // repo.ts 在本地后端会自己记一条流水，这里记更详细的，不重复
    audit: false,
  });
  if (!result.success) fail(502, result.error ?? '作者表写入失败');

  await writeAudit(c.env, {
    actor: admin,
    action: 'authorRequest',
    target: result.path ?? (await authorsFilePath(c.env)),
    detail: { event: 'authors-file', backend: result.backend, bytes: parsed.data.content.length, sha: result.sha ?? null },
    ip: clientIp(c),
  });
  return ok({ path: result.path, sha: result.sha ?? null, backend: result.backend, bytes: parsed.data.content.length });
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
  const jobs = await db
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
      return { ok: true, detail: `${count.toLocaleString('zh-CN')}${capped ? '+' : ''} 个`, count, capped };
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

  checks.apiLatencyMs = Date.now() - started;
  return ok({ checks, jobs });
});

app.get('/stats', async (c) => {
  requireAdmin(c);
  const db = createDb(c.env);
  const since7 = Math.floor(Date.now() / 1000) - 7 * 86400;
  const [articleCount] = await db.select({ n: sql<number>`count(*)` }).from(comments).where(gte(comments.createdAt, since7));
  void articleCount;
  const [commentCount] = await db.select({ n: sql<number>`count(*)` }).from(comments);
  const [pendingCount] = await db.select({ n: sql<number>`count(*)` }).from(comments).where(eq(comments.status, 'pending'));
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
  });
});

/**
 * 文章与时刻的数量：按「设置 → 内容仓库」里的文章目录、时刻目录递归数 .md。
 * 之前只 listDir 一层（githubContentDir，默认 content），而文章实际在 content/posts/ 下，
 * 所以仪表盘那个「文章」卡片数出来的永远是 0（或多语言布局下少算一整层）。
 * 用的就是备份分区同一份递归列举，两处口径不会再分叉。
 */
app.get('/stats/content', async (c) => {
  requireAdmin(c);
  const postsDir = (await getConfig(c.env, 'githubPostsDir'))?.trim() || 'content/zh/posts';
  const momentsDir = (await getConfig(c.env, 'githubMomentsDir'))?.trim() || 'content/zh/moments';
  try {
    const target = await repoTarget(c.env);
    const [posts, moments] = await Promise.all([
      walkFiles(target, postsDir, { exts: ['.md'], cap: CONTENT_COUNT_CAP }),
      walkFiles(target, momentsDir, { exts: ['.md'], cap: CONTENT_COUNT_CAP }),
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
  const { id, item } = await createFriend(c.env, admin, await c.req.json().catch(() => null), { ip: clientIp(c) });
  return ok({ id, item });
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
