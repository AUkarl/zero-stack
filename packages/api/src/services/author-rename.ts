/**
 * services/author-rename.ts —— 改「作者标识」时，把内容仓里那些旧标识一起搬走。
 *
 * 为什么必须一起搬：前台署名是 Hugo 在**构建期**拿 front matter 的 `author:` 去
 * `data/authors.yaml` 里查同一个键。只改数据库的话，老文章里写的还是旧串 ——
 * 同一个人会裂成两个作者页（旧文章那一半还查不到资料），站主点名的就是这件事。
 *
 * 一次改动的范围：
 *   ① 文章与时刻的 front matter `author:`（只动等于旧串的那些文件）；
 *   ② `data/authors.yaml` 里的那个键（值原样搬过去，两边都有就把旧的并进新的）；
 *   ③ `defaultAuthor` 配置与 `data/site.json` 里的默认作者（旧串正是默认作者时）。
 * 全部文件走**同一个提交**，提交后照旧请求一次 Pages 重建并跑构建体检。
 */
import { authorsFilePath, parseAuthorsYaml, serializeAuthorsYaml, validateAuthorsYaml } from './authors';
import { getConfig, setConfig } from './config';
import { finishRepoWrites } from './git';
import { checkRepoWrite } from './hugo-guard';
import { commitRepoFiles, readRepoFile, resolveRepoTarget, walkFiles, type RepoCommitResult } from './repo';
import { buildMarkdown, parseFrontMatter } from './frontmatter';
import { setSiteDefaultAuthor } from '../routes/frontend';

export interface HandleRenameInput {
  from: string;
  to: string;
  actor: { id?: string | null; name?: string | null } | null;
  ip?: string;
}

export interface HandleRenameResult {
  from: string;
  to: string;
  /** 改动的仓库文件路径（含作者表与 site.json） */
  changed: string[];
  /** 单个文件被闸门挡下的原因（正文里有会让 Hugo 报错的东西），这些文件保持原样 */
  skipped: { path: string; error: string }[];
  /** 作者表里那一条有没有搬 */
  authorMoved: boolean;
  /** 默认作者（config + site.json）有没有跟着改 */
  defaultMoved: boolean;
  committed: boolean;
  error?: string;
  build?: { triggered?: boolean; error?: string } | null;
  buildHealth?: unknown;
}

/** 只认 front matter 里 author 是**一个字符串**的情况；列表形式（多作者）原样不动并说明 */
function singleAuthor(front: Record<string, unknown> | undefined): string | null {
  const raw = front?.author;
  if (typeof raw !== 'string') return null;
  return raw.trim();
}

export async function renameAuthorHandle(env: Env, input: HandleRenameInput): Promise<HandleRenameResult> {
  const from = String(input.from ?? '').trim();
  const to = String(input.to ?? '').trim();
  const out: HandleRenameResult = { from, to, changed: [], skipped: [], authorMoved: false, defaultMoved: false, committed: true };
  if (!from || !to || from === to) return out;

  const target = await resolveRepoTarget(env);
  /** 文章目录 + 时刻目录；多语言站在目录里带语言前缀，walkFiles 会递归到页面包 */
  const dirs = [
    (await getConfig(env, 'githubPostsDir'))?.trim() || 'content/posts',
    (await getConfig(env, 'githubMomentsDir'))?.trim() || 'content/moments',
  ];
  const groups = await Promise.all(dirs.map((d) => walkFiles(target, d, { exts: ['.md'] })));
  const paths = [...new Set(groups.flat())];

  /** 逐篇读：8 个一批，免得几十个文件把 GitHub API 打成串行 */
  const writes: { path: string; content: string }[] = [];
  for (let i = 0; i < paths.length; i += 8) {
    const batch = paths.slice(i, i + 8);
    const texts = await Promise.all(batch.map((p) => readRepoFile(env, p).catch(() => null)));
    batch.forEach((path, n) => {
      const file = texts[n];
      if (!file?.content) return;
      const { front, body } = parseFrontMatter(file.content);
      if (!front || singleAuthor(front) !== from) return;
      const next = buildMarkdown({ ...front, author: to }, body);
      const bad = checkRepoWrite(path, next);
      if (bad) {
        out.skipped.push({ path, error: bad });
        return;
      }
      writes.push({ path, content: next });
    });
  }

  /* ---- 作者表：键从旧串搬到新串 ---- */
  const yamlPath = await authorsFilePath(env);
  const yamlFile = await readRepoFile(env, yamlPath).catch(() => null);
  let yamlNext = '';
  if (yamlFile?.content) {
    const map = parseAuthorsYaml(yamlFile.content) as Record<string, Record<string, unknown>>;
    if (map[from]) {
      const merged = { ...map[from], ...(map[to] ?? {}) };
      // 标识本身以键为准，条目里再存一份的话容易和键不一致
      delete merged.handle;
      delete map[from];
      map[to] = merged;
      yamlNext = serializeAuthorsYaml(map as never);
      const invalid = validateAuthorsYaml(yamlNext);
      if (invalid) {
        out.committed = false;
        out.error = `作者表改完过不了校验，整批已放弃：${invalid}`;
        return out;
      }
      out.authorMoved = true;
    }
  }

  /* ---- 默认作者：config 与 data/site.json 两处 ---- */
  const def = ((await getConfig(env, 'defaultAuthor')) ?? '').trim();
  let siteChange: { path: string; content: string } | null = null;
  if (def === from) {
    await setConfig(env, 'defaultAuthor', to);
    const site = await setSiteDefaultAuthor(env, to).catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : '写入失败' }));
    out.defaultMoved = Boolean(site?.ok);
    if (!site?.ok) out.skipped.push({ path: 'data/site.json', error: site?.detail || '写入失败' });
  }

  if (out.authorMoved) writes.push({ path: yamlPath, content: yamlNext });
  if (siteChange) writes.push(siteChange);
  if (!writes.length) {
    const done = await finishRepoWrites(env, 0).catch(() => ({ build: null, buildHealth: null }));
    out.build = done.build;
    out.buildHealth = done.buildHealth;
    return out;
  }

  const message = `zero-cms: 作者标识 ${from} → ${to}（连带 ${writes.length} 个文件）`;
  try {
    const res = (await commitRepoFiles(env, writes, message, { actor: input.actor, ip: input.ip, action: 'user' })) as RepoCommitResult;
    out.changed = writes.map((w) => w.path);
    if (res && res.success === false) {
      out.committed = false;
      out.error = res.error || '仓库提交失败';
    }
  } catch (e) {
    out.committed = false;
    out.error = e instanceof Error ? e.message : '仓库写入失败';
    return out;
  }

  const done = await finishRepoWrites(env, out.changed.length).catch(() => ({ build: null, buildHealth: null }));
  out.build = done.build;
  out.buildHealth = done.buildHealth;
  return out;
}
