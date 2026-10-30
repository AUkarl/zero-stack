/**
 * 后台的机器翻译口子：把原文译成**选定的目标语言**（默认简体中文），
 * 结果先作为草稿回给编辑，确认后才写进 content/<语言>/posts 并触发重建。
 * 确认后才写进 content/zh/posts 并触发重建。
 *
 * 端点：
 *   GET  /status      → 当前 provider、是否就绪、可选 provider 清单（含是否需要 key）、编辑器仍在用的语言表
 *   POST /            → 试译任意文本（文章编辑器的写作工具），target 选目标语言（默认 zh）
 *   GET  /documents   → 列出 content/zh/posts 里已发布文章（缓存 5 分钟），不再有语言参数
 *   POST /document    → {path,target} 把某篇文章按段落译成目标语言，返回可编辑草稿，不写盘
 *   POST /publish     → {path,front,body,target,message,overwrite} 写进 content/<target>/posts/<源文件名>.md 并触发重建
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { clientIp } from '../lib/http';
import { fail, ok } from '../lib/errors';
import { requireAdmin } from '../middleware/auth';
import { writeAudit } from '../services/audit';
import { TRANSLATE_TARGETS, isTranslateTarget, providerCatalog, targetLabel, translateStatus, translateText } from '../services/translate';
import { rateLimit } from '../lib/rate-limit';
import { listRepoDir, readRepoFile, writeRepoFile } from '../services/repo';
import { purgeContentTitleCache } from '../services/content-title';
import { buildMarkdown, parseFrontMatter, postsDir, slugFromPath, type Front } from '../services/frontmatter';
import { finishRepoWrites } from '../services/git';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

/** 纯中文站唯一的内容语言目录短码 */
const ZH = 'zh';

const normPath = (p: string): string => String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '');

app.get('/status', async (c) => {
  requireAdmin(c);
  const status = await translateStatus(c.env);
  return ok({ ...status, providers: providerCatalog(), targets: TRANSLATE_TARGETS, defaultTarget: 'zh' });
});

const requestSchema = z.object({
  /** 单段或一次多段（标题 + 摘要 + 正文一起送） */
  text: z.string().max(40_000).optional(),
  texts: z.array(z.string().max(40_000)).max(20).optional(),
  source: z.string().min(2).max(12).optional(),
  /** 目标语言：zh / en / ru / fr / de / es / ar / ja / ko，默认 zh */
  target: z.string().min(2).max(8).optional(),
});

app.post('/', async (c) => {
  const admin = requireAdmin(c);
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    // 原来无论哪种不合法都回同一句「请给出要翻译的文本」，粘一篇长文（>4 万字）的人
    // 看到的第一反应是「我明明给了」。把 zod 的真实原因带出来，一句话就能自解释。
    const issue = parsed.error.issues[0];
    if (issue?.code === 'too_big') {
      fail(400, `内容太长了：${issue.path.join('.') || 'text'} 单段上限 ${String(issue.maximum ?? 40_000)} 字，请分成几段（texts 一次最多 20 段）再翻`);
    }
    fail(400, '请给出要翻译的文本 text / texts（单段上限 4 万字，一次最多 20 段）');
  }
  const { text, texts, source, target: rawTarget } = parsed.data;
  const target = isTranslateTarget(rawTarget) ? rawTarget : 'zh';

  const inputs = texts?.length ? texts : text ? [text] : [];
  if (!inputs.length) fail(400, '没有要翻译的内容');
  // 一次后台翻译最多 20 段，长文自己会分片，避免被当免费翻译接口刷
  await rateLimit(c, 'translate', 20, 60);

  const results = [];
  for (const input of inputs) {
    results.push(await translateText(c.env, { text: input, source, target }));
  }
  const failed = results.filter((r) => !r.ok);

  await writeAudit(c.env, {
    actor: admin,
    action: 'translate',
    target: `${inputs.length} 段 → ${targetLabel(target)}`,
    detail: { provider: results[0]?.provider, errors: failed.map((f) => f.error).filter(Boolean).slice(0, 3) },
    ip: clientIp(c),
  });

  if (failed.length === results.length) fail(502, failed[0]?.error ?? '翻译失败');
  return ok({ results, partial: failed.length > 0 });
});

/* ------------------------------------------------------------------ 文档列表缓存（只列 content/zh/posts） */

interface DocItem {
  id: string;
  path: string;
  title: string;
  date: string;
}

const DOC_CACHE = new Map<string, { stamp: number; data: DocItem[] }>();
const DOC_TTL = 5 * 60 * 1000;

function isDraftTrue(v: Front[string] | undefined): boolean {
  if (v === true) return true;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  if (typeof v === 'number') return v === 1;
  return false;
}

app.get('/documents', async (c) => {
  requireAdmin(c);

  const hit = DOC_CACHE.get(ZH);
  if (hit && Date.now() - hit.stamp < DOC_TTL) return ok({ dir: '', documents: hit.data, cached: true });

  const dir = await postsDir(c.env);
  let entries: Awaited<ReturnType<typeof listRepoDir>> = [];
  try {
    entries = await listRepoDir(c.env, dir);
  } catch {
    entries = [];
  }
  const files = entries.filter((e) => e.type === 'file' && /\.mdx?$/i.test(e.name) && !/^_index\./i.test(e.name));

  const docs: DocItem[] = [];
  for (const f of files.slice(0, 300)) {
    const path = f.path || `${dir}/${f.name}`;
    let file: Awaited<ReturnType<typeof readRepoFile>> = null;
    try {
      file = await readRepoFile(c.env, path);
    } catch {
      continue;
    }
    if (!file) continue;
    const { front } = parseFrontMatter(file.content);
    if (isDraftTrue(front.draft)) continue;
    docs.push({
      id: path,
      path,
      title: String(front.title ?? f.name.replace(/\.mdx?$/i, '')),
      date: String(front.date ?? ''),
    });
  }
  docs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)));

  DOC_CACHE.set(ZH, { stamp: Date.now(), data: docs });
  return ok({ dir, documents: docs, cached: false });
});

/* ------------------------------------------------------------------ 单篇译成中文（不写盘） */

const documentSchema = z.object({
  path: z.string().min(1),
  /** 目标语言，默认 zh */
  target: z.string().min(2).max(8).optional(),
});

function splitParagraphs(body: string): string[] {
  const parts = String(body ?? '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** 翻译一段纯文本/短字段，失败直接 fail 带出明确原因 */
async function translateTo(env: Env, text: string, target: string): Promise<{ text: string; provider: string; retries: number; usage: string }> {
  const r = await translateText(env, { text, target });
  if (!r.ok) fail(502, r.error ?? '翻译失败');
  return { text: r.text, provider: String(r.provider), retries: r.retries ?? 0, usage: r.usage ?? '' };
}

app.post('/document', async (c) => {
  const admin = requireAdmin(c);
  const parsed = documentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '请给出文章路径 path');
  const { path } = parsed.data;
  const target = isTranslateTarget(parsed.data.target) ? parsed.data.target : 'zh';
  await rateLimit(c, 'translate', 12, 60);

  const file = await readRepoFile(c.env, path).catch(() => null);
  if (!file) fail(404, `读不到源文章：${path}`);

  const { front, body } = parseFrontMatter(file!.content);
  const title = String(front.title ?? '');
  const description = String(front.description ?? '');
  const summary = String(front.summary ?? '');

  // 正文按段落分片翻译（原文可为任意语言，译文写进选定的目标语言）
  const paragraphs = splitParagraphs(body);
  const translatedParagraphs: string[] = [];
  let provider = '';
  let segments = 0;
  let retries = 0;
  let usage = '';
  for (const p of paragraphs) {
    const r = await translateTo(c.env, p, target);
    translatedParagraphs.push(r.text);
    provider = provider || r.provider;
    segments++;
    retries += r.retries;
    if (r.usage) usage = r.usage;
  }

  // 短字段：标题 / 摘要 / 描述，逐个翻译，缺省字段不无中生有；front matter 字段名不译
  const outFront: Front = { ...front };
  if (title.trim()) {
    const r = await translateTo(c.env, title, target);
    outFront.title = r.text;
    provider = provider || r.provider;
    retries += r.retries;
  }
  if (description.trim()) {
    const r = await translateTo(c.env, description, target);
    outFront.description = r.text;
    retries += r.retries;
  }
  if (summary.trim()) {
    const r = await translateTo(c.env, summary, target);
    outFront.summary = r.text;
    retries += r.retries;
  }
  // date 保持、slug/author/comments 等原字段不变；中文稿以非草稿返回，供编辑确认后发布
  outFront.draft = false;

  const outBody = translatedParagraphs.join('\n\n');

  await writeAudit(c.env, {
    actor: admin,
    action: 'translate',
    target: `${path} → ${targetLabel(target)}`,
    detail: { provider, segments, retries, usage },
    ip: clientIp(c),
  });

  return ok({
    source: { path, front, title },
    target,
    result: {
      front: outFront,
      body: outBody,
      translatedWith: { provider: provider || 'unknown', segments, retries },
    },
  });
});

/* ------------------------------------------------------------------ 发布（固定写回 content/zh/posts） */

const publishSchema = z.object({
  path: z.string().min(1),
  front: z.any(),
  body: z.string().max(200_000),
  message: z.string().max(200).optional(),
  overwrite: z.boolean().optional(),
  /** 目标语言，默认 zh */
  target: z.string().min(2).max(8).optional(),
});

app.post('/publish', async (c) => {
  const admin = requireAdmin(c);
  const parsed = publishSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '发布请求缺少 path / front / body');
  const { path, front, body, message, overwrite } = parsed.data;
  const target = isTranslateTarget(parsed.data.target) ? parsed.data.target : 'zh';

  const dir = await postsDir(c.env);
  const langRoot = dir.replace(/\/posts$/, ''); // 例如 content/zh
  const defaultLang = langRoot.split('/').pop() || 'zh';
  /* 目标语言就是站点默认语言时写原来的目录；其它语言写 content/<lang>/posts */
  const base = langRoot.replace(/\/[^/]+$/, '');
  const destLangRoot = target === defaultLang ? langRoot : `${base}/${target}`;
  const destDir = `${destLangRoot}/posts`;
  /* 非默认语言要先确认站点真配了这门语言，否则写进去 Hugo 也不生成页面 */
  if (target !== defaultLang) {
    const hugo = await readRepoFile(c.env, 'hugo.toml').catch(() => null);
    const hugoLines = String(hugo?.content ?? '').split(/\r?\n/);
    /* 只认真正的表头（行首、非注释），别把注释里提到的 [languages.en] 当成已配置 */
    const configured = hugoLines.some((line) => {
      const m = /^\s*\[languages\.([a-z-]+)(?:\]|\.)/.exec(line);
      return Boolean(m && m[1].toLowerCase() === target);
    });
    if (!configured) {
      fail(
        400,
        `站点还没配置「${targetLabel(target)}」这门语言：写进 content/${target}/posts 也不会出现在前台。先在 hugo.toml 加上 [languages.${target}] 再发布；只想留译文的话用「复制译文」。`,
      );
    }
  }

  const srcPath = normPath(path);
  const filename = `${slugFromPath(path) || 'untitled'}.md`;
  const newPath = `${destDir}/${filename}`;

  // 源文件已经在目标语言目录里：再发布等于自己译自己并覆盖原文，明确拒绝
  if (srcPath === newPath || srcPath.startsWith(`${destLangRoot}/`)) {
    fail(
      400,
      `源文件本身就在${targetLabel(target)}目录（${destLangRoot}/）里：${srcPath}。同一语言不能再「译自己覆盖自己」；要修改这篇请直接去「文章」编辑器编辑原文。`,
    );
  }

  // 冲突：目标同名文件已存在且未勾选覆盖 → 409，绝不静默覆盖
  let existing: Awaited<ReturnType<typeof readRepoFile>> = null;
  try {
    existing = await readRepoFile(c.env, newPath);
  } catch {
    existing = null;
  }
  if (existing && !overwrite) {
    fail(409, `${targetLabel(target)}稿目标文件已存在：${newPath}。要覆盖请勾选「覆盖已存在文件」。`);
  }

  const md = buildMarkdown((front ?? {}) as Front, String(body ?? ''));
  const write = await writeRepoFile(c.env, newPath, md, message || `发布${targetLabel(target)}稿 ${filename}`, {
    actor: admin,
    ip: clientIp(c),
    action: 'translate',
    audit: false,
  });
  if (!write.success) fail(502, write.error ?? '写入仓库失败');
  /* 勾了「覆盖已存在文件」时这一笔换掉的是同一路径的文章：标题可能变了，提醒信那格的缓存要跟着清 */
  await purgeContentTitleCache(c.env, [newPath]);

  /* 翻译写出的是整篇新文章（新路径、新 front matter），与后台存稿一样能让 Hugo 整站失败，
     所以走同一个收尾：请求重建 + 本地跑一次构建体检。以前这里只 triggerPagesBuild，
     翻译失败在界面上完全看不出来。 */
  const { build, buildHealth } = await finishRepoWrites(c.env, 1);

  await writeAudit(c.env, {
    actor: admin,
    action: 'translate',
    target: newPath,
    detail: {
      from: path,
      lang: target,
      backend: write.backend,
      overwritten: Boolean(existing),
      committedAt: write.committedAt ?? null,
      build,
      buildHealth,
    },
    ip: clientIp(c),
  });

  return ok({
    path: newPath,
    target,
    backend: write.backend,
    committedAt: write.committedAt ?? null,
    overwritten: Boolean(existing),
    build,
    buildHealth,
  });
});

export default app;