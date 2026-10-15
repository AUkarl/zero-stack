/**
 * 内容层：Hugo 的 md = front matter + 正文。
 *
 * 后台的结构化编辑器只应该操作「字段 + 正文」，所以这里实现了一个够用的
 * YAML 子集（标量 / 字符串数组 / 行内数组 / 一层嵌套映射）的解析与序列化，
 * 零依赖，Workers 直接能跑。序列化按 FIELD_ORDER 固定字段顺序输出，
 * 保证同一篇文章在后台存盘两次不会产生无意义的 diff。
 *
 * 顺带承担内容仓库的读写：路由层只关心 path/content/message，
 * GitHub Contents API 的细节（sha 乐观锁、逐段编码路径）都收在这里。
 * 刻意不依赖其它模块的仓库封装，方便本地与 Workers 行为一致。
 */

import { deleteFile, listDir, readFile, writeFile } from '../services/git';
import { getConfig } from './config';
import { repoTarget } from './git';
import { fail } from '../lib/errors';

/* ------------------------------------------------------------------ 字段模型 */

/** front matter 里一个值可能长什么样 */
export type FrontValue = string | number | boolean | null | string[] | Record<string, string>;

export type Front = Record<string, FrontValue>;

export interface ParsedMarkdown {
  front: Front;
  body: string;
}

/**
 * 序列化时的字段顺序：与站点现有文章一致，Hugo 侧的展示优先级也按这个来。
 * 未知字段按名字母序补在后面，绝不被吞掉。
 */
export const FIELD_ORDER = [
  'title',
  'subtitle',
  'date',
  /** Hugo 只按 lastmod 算 .Lastmod，后台「修改时间」写的是它；updated 是老写法，留着只为排序兼容 */
  'updated',
  'lastmod',
  'description',
  'summary',
  'categories',
  'tags',
  'image',
  'cover',
  'draft',
  'weight',
  /** 首页精选的置顶标记（主题按它排在热度分前面），与 Hugo 的 weight 互不影响 */
  'pinned',
  'author',
  'toc',
  'math',
  'comments',
] as const;

function isPlainObject(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ------------------------------------------------------------------ 解析 */

/** 解析 `---\n...\n---\n正文`；没有 front matter 时 front 为空对象 */
export function parseFrontMatter(md: string): ParsedMarkdown {
  const src = String(md ?? '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { front: {}, body: src };
  return { front: parseYaml(m[1] ?? ''), body: src.slice(m[0].length) };
}

/** YAML 子集：顶层标量 / 块数组 / 行内数组 / 一层映射 */
function parseYaml(raw: string): Front {
  const data: Front = {};
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      i++;
      continue;
    }

    const top = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!top) {
      i++;
      continue;
    }

    const key = top[1] as string;
    const rest = (top[2] ?? '').trim();

    // 值在下面的缩进块里：块数组或一层映射
    if (rest === '') {
      const block: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j] ?? '';
        if (!l.trim() || l.trim().startsWith('#')) {
          block.push(l);
          j++;
          continue;
        }
        if (/^\s+\S/.test(l)) {
          block.push(l);
          j++;
          continue;
        }
        break;
      }
      fillBlock(data, key, block);
      i = j;
      continue;
    }

    if (/^\[.*\]$/.test(rest)) {
      data[key] = rest
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
      i++;
      continue;
    }

    data[key] = parseScalar(rest);
    i++;
  }

  return data;
}

function fillBlock(data: Front, key: string, children: string[]): void {
  const meaningful = children.filter((l) => l.trim() && !l.trim().startsWith('#'));

  if (meaningful.length && meaningful.every((l) => /^\s*-\s+/.test(l))) {
    data[key] = meaningful.map((l) => unquote(l.replace(/^\s*-\s+/, '').trim()));
    return;
  }

  if (meaningful.length && meaningful.every((l) => /^\s+[A-Za-z0-9_-]+\s*:/.test(l))) {
    const obj: Record<string, string> = {};
    for (const l of meaningful) {
      const mm = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(l);
      if (!mm) continue;
      const v = unquote((mm[2] ?? '').trim());
      if (v !== '') obj[mm[1] as string] = v;
    }
    data[key] = obj;
    return;
  }

  data[key] = [];
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

function parseScalar(s: string): string | number | boolean | null {
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^(null|~)$/i.test(s)) return null;
  return unquote(s);
}

/* ------------------------------------------------------------------ 序列化 */

/** 需要加引号的值：含 YAML 特殊字符或首尾空格 */
function needsQuote(s: string): boolean {
  return /[:#\[\]{}&*!|>'"%@`]/.test(s) || /^\s|\s$/.test(s) || /^-$/.test(s) || /[\n\r]/.test(s);
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function scalarToLine(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  return needsQuote(s) ? quote(s) : s;
}

/** 按 FIELD_ORDER 排：已知字段在前，未知字段按字母序在后，空值直接不写 */
export function orderFront(front: Front): Front {
  const ordered: Front = {};
  for (const key of FIELD_ORDER) {
    if (key in front) ordered[key] = front[key] as FrontValue;
  }
  for (const key of Object.keys(front).sort()) {
    if (!(key in ordered)) ordered[key] = front[key] as FrontValue;
  }
  return ordered;
}

/** front matter → YAML 文本（不含正文） */
export function serializeFrontMatter(front: Front): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(orderFront(front ?? {}))) {
    if (v === undefined || v === null || v === '') continue;

    if (Array.isArray(v)) {
      const items = v.map((x) => String(x)).filter((x) => x !== '');
      if (!items.length) {
        lines.push(`${k}: []`);
        continue;
      }
      lines.push(`${k}:`);
      for (const item of items) lines.push(`  - ${needsQuote(item) ? quote(item) : item}`);
      continue;
    }

    if (isPlainObject(v)) {
      const entries = Object.entries(v).filter(([, vv]) => vv != null && String(vv) !== '');
      if (!entries.length) continue;
      lines.push(`${k}:`);
      for (const [sk, sv] of entries) lines.push(`  ${sk}: ${needsQuote(sv) ? quote(sv) : sv}`);
      continue;
    }

    lines.push(`${k}: ${scalarToLine(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** front + body 拼成要写进仓库的 md */
export function buildMarkdown(front: Front, body: string): string {
  const head = serializeFrontMatter(front);
  const text = String(body ?? '').replace(/^\n+/, '');
  return `${head}\n\n${text}${text.endsWith('\n') || text === '' ? '' : '\n'}`;
}

/* ------------------------------------------------------------------ 文章语义 */



/** 标题 → 文件名 slug：只保留 ASCII 字母数字与短横线，取不出就返回空串 */

/** 正文摘要兜底：没有 summary/description 时截第一段纯文本 */
export function excerpt(mdOrBody: string, len = 160): string {
  const { body } = parseFrontMatter(mdOrBody);
  const s = String(body ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/^\s*#[^\n]*$/gm, ' ')
    .replace(/[*_>`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

/** 文件名即 slug：content/zh/posts/abc.md → abc */
export function slugFromPath(path: string): string {
  const name = String(path ?? '').split('/').pop() ?? '';
  return name.replace(/\.mdx?$/i, '');
}

/**
 * 站点 URL 路径：defaultContentLanguageInSubdir = false，
 * 所以 content/zh/posts/abc.md 落在 /posts/abc/。
 */
export function postWebPath(path: string): string {
  const segs = String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  const at = segs.indexOf('posts');
  if (at < 0) return `/${segs.slice(1).join('/')}`;
  const slug = (segs[segs.length - 1] ?? '').replace(/\.mdx?$/i, '');
  return `/posts/${slug}/`;
}

/* ------------------------------------------------------------------ 内容目录 */

/** 内容目录（后台可配），去掉首尾斜杠 */
export async function contentRoot(env: Env): Promise<string> {
  const dir = (await getConfig(env, 'githubContentDir')) ?? 'content';
  return dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') || 'content';
}

/** 文章目录：站点只有中文，语言段写死 zh */
export async function postsDir(env: Env): Promise<string> {
  return `${await contentRoot(env)}/zh/posts`;
}

/* ------------------------------------------------------------------ 仓库读写 */

export interface RepoFileResult {
  content: string;
  sha: string;
}

export interface CommitOutcome {
  sha: string;
  path: string;
}

/** 读仓库里的文本文件；不存在返回 null，配置缺失/网络失败会抛（调用方按场景决定忽略还是 fail） */
export async function readRepoFile(env: Env, path: string): Promise<RepoFileResult | null> {
  const settings = await repoTarget(env);
  return (await readFile({ ...settings, path })) ?? null;
}

/** 读不到就返回 null：评论审核规则文件这类「可选资源」不该把主流程带崩 */
export async function readRepoFileQuiet(env: Env, path: string): Promise<RepoFileResult | null> {
  try {
    return await readRepoFile(env, path);
  } catch {
    return null;
  }
}

/**
 * 写文件。传了 sha 就做乐观锁：文件在别处改过直接 409，避免后台把别人的提交覆盖掉。
 * 不传 sha 则沿用 Contents API 的「先探测再提交」行为（新建或覆盖）。
 */
export async function writeRepoFile(
  env: Env,
  input: { path: string; content: string; message: string; sha?: string },
): Promise<CommitOutcome> {
  const settings = await repoTarget(env);
  if (input.sha) {
    const current = await readFile({ ...settings, path: input.path }).catch((e: unknown) => {
      fail(502, e instanceof Error ? e.message : String(e));
    });
    if (current && current.sha !== input.sha) fail(409, '文件在别处改动过，请刷新后重试');
  }
  const result = await writeFile({ ...settings, path: input.path, content: input.content, message: input.message });
  if (!result.success) fail(502, result.error ?? '提交失败');
  return { sha: result.sha ?? '', path: result.path ?? input.path };
}

/** 只在文件确实存在时才删：GitHub 对不存在的路径回 404，后台把它当「已经没了」 */
export async function deleteRepoFile(env: Env, input: { path: string; message: string }): Promise<{ deleted: boolean; reason?: string }> {
  const settings = await repoTarget(env);
  const result = await deleteFile({ ...settings, path: input.path, message: input.message });
  if (!result.success) {
    if (result.error === '文件不存在') return { deleted: false, reason: result.error };
    fail(502, result.error ?? '删除失败');
  }
  return { deleted: true };
}

export interface RepoEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
}

export async function listRepoDir(env: Env, path: string): Promise<RepoEntry[]> {
  const settings = await repoTarget(env);
  return (await listDir({ ...settings, path })) as RepoEntry[];
}

