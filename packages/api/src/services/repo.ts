/**
 * 站点仓库读写：一套 API，两种后端。
 *
 *   github  —— Contents API（site_config 的 githubOwner/githubRepo + GITHUB_TOKEN 密钥）
 *   local   —— GIT_LOCAL_DIR 指向的本地检出目录，直接把文件写进去
 *
 * local 后端是给本地开发用的：GitHub 还没配（或不想拿真实仓库做实验）时，
 * 把 GIT_LOCAL_DIR 指到 zero-site 的目录，发布链路照样能跑通、能验收产物。
 * 本地写入没有 Git 历史可查，所以每次写/删都往 audit_logs 记一条留痕。
 */

import { getConfig } from './config';
import { fail } from '../lib/errors';
import { writeAudit, type AuditAction } from './audit';
import * as gh from '../adapters/github';

export type RepoBackend = 'github' | 'local';

export interface RepoTarget {
  backend: RepoBackend;
  /** github 用；local 下是配置里残留的原值，仅作展示 */
  owner: string;
  repo: string;
  branch: string;
  /** github 用；local 下恒为空串 */
  token: string;
  /** local 用：站点仓库的本地检出根目录 */
  dir: string;
  /** 解析时用到的 env，带回来是为了兼容 git.ts 那套 {...settings} 的调用形状 */
  env?: Env;
}

export interface RepoFile {
  content: string;
  sha: string;
}

export interface RepoFileResult {
  success: boolean;
  sha?: string;
  path?: string;
  committedAt?: string;
  error?: string;
  backend: RepoBackend;
  /** 内容与仓库里现有的一份完全相同，这次没有产生提交 */
  unchanged?: boolean;
}

export interface RepoEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
}

export interface RepoWriteOptions {
  /** 留痕用：谁干的。local 后端一定要传，不然审计里只剩一个匿名动作 */
  actor?: { id?: string | null; name?: string | null } | null;
  ip?: string;
  /** 审计动作分类，默认 content */
  action?: AuditAction;
  /** 传 false 时不写审计（调用方自己已经记了更详细的流水） */
  audit?: boolean;
}

/* ------------------------------------------------------------------
 * 后端选择
 * ----------------------------------------------------------------*/

/** GIT_LOCAL_DIR 只走环境变量，不放进 site_config：它指向的是机器上的目录，换个环境就没意义 */
function localRootDir(env: Env): string {
  const fromBinding = (env as unknown as { GIT_LOCAL_DIR?: string }).GIT_LOCAL_DIR;
  if (fromBinding && fromBinding.trim()) return fromBinding.trim();
  // wrangler dev 下 process.env 也在，方便 .env / 命令行直接 export 而不改 wrangler.jsonc
  try {
    const p = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = p?.env?.GIT_LOCAL_DIR;
    if (v && v.trim()) return v.trim();
  } catch {
    /* Worker 运行时没有 process，忽略 */
  }
  return '';
}

export function githubConfigured(env: Env, owner?: string | null, repo?: string | null): boolean {
  return Boolean(owner && repo && env.GITHUB_TOKEN);
}

/**
 * 解析出这次读写该走哪个后端。
 * 显式配了 GIT_LOCAL_DIR 就优先本地目录：那是开发者主动要求「别碰远端，写我本地的站点」，
 * 此时即使仓库配置齐全、令牌已失效或没有写权限，也不该把 502 抛给后台。
 * 其次是 GitHub，两者都没有才报错，报错文案把两条路都写清楚。
 */
export async function resolveRepoTarget(env: Env): Promise<RepoTarget> {
  const owner = await getConfig(env, 'githubOwner');
  const repo = await getConfig(env, 'githubRepo');
  const branch = (await getConfig(env, 'githubBranch')) ?? 'main';
  const token = env.GITHUB_TOKEN;

  const dir = localRootDir(env);
  if (dir) {
    return { backend: 'local', owner: owner ?? '', repo: repo ?? '', branch, token: '', dir, env };
  }
  if (githubConfigured(env, owner, repo)) {
    return { backend: 'github', owner: owner!, repo: repo!, branch, token: token!, dir: '', env };
  }
  fail(
    500,
    token
      ? `内容仓库无法写入：缺少 githubOwner / githubRepo，本地也没有 GIT_LOCAL_DIR 目录可写`
      : `内容仓库未配置（缺 githubOwner / githubRepo 或 GITHUB_TOKEN），本地也没有 GIT_LOCAL_DIR 目录可写`,
  );
}

/** 只想知道当前会走哪条路，不想知道报错：状态接口用 */
export async function repoBackend(env: Env): Promise<RepoBackend | 'none'> {
  if (localRootDir(env)) return 'local';
  const owner = await getConfig(env, 'githubOwner');
  const repo = await getConfig(env, 'githubRepo');
  if (githubConfigured(env, owner, repo)) return 'github';
  return 'none';
}

/** git.ts 的旧调用形状（{...settings, path, content, message}）也认，便于其它路由不改写法 */
export function targetFromInput(input: Partial<RepoTarget> & { env?: Env }): RepoTarget {
  const backend: RepoBackend = input.backend ?? (input.token ? 'github' : input.dir ? 'local' : 'github');
  return {
    backend,
    owner: input.owner ?? '',
    repo: input.repo ?? '',
    branch: input.branch ?? 'main',
    token: input.token ?? '',
    dir: input.dir ?? '',
    env: input.env,
  };
}

/* ------------------------------------------------------------------
 * 对外四个动作：读、写、删、列目录
 * ----------------------------------------------------------------*/

export async function readRepoFile(env: Env, path: string): Promise<RepoFile | null> {
  return readFileFrom(await resolveRepoTarget(env), path);
}

export async function writeRepoFile(
  env: Env,
  path: string,
  content: string,
  message: string,
  opts: RepoWriteOptions = {},
): Promise<RepoFileResult> {
  return writeViaTarget(await resolveRepoTarget(env), path, content, message, opts);
}

export async function deleteRepoFile(env: Env, path: string, message: string, opts: RepoWriteOptions = {}): Promise<RepoFileResult> {
  return deleteViaTarget(await resolveRepoTarget(env), path, message, opts);
}

export async function listRepoDir(env: Env, dir: string): Promise<RepoEntry[]> {
  return listDirViaTarget(await resolveRepoTarget(env), dir);
}

/* ------------------------------------------------------------------
 * 已经拿到 target 的调用方走这组，省一次配置查询
 * ----------------------------------------------------------------*/

export async function readFileFrom(target: RepoTarget, path: string): Promise<RepoFile | null> {
  if (target.backend === 'local') return localRead(target, path);
  return gh.readFile({ owner: target.owner, repo: target.repo, branch: target.branch, token: target.token, path });
}

export async function writeViaTarget(
  target: RepoTarget,
  path: string,
  content: string,
  message: string,
  opts: RepoWriteOptions = {},
): Promise<RepoFileResult> {
  if (target.backend === 'local') {
    const result = await localWrite(target, path, content);
    await auditLocal(target, 'write', path, message, opts, result);
    return result;
  }
  const res = await gh.writeFile({ owner: target.owner, repo: target.repo, branch: target.branch, token: target.token, path, content, message });
  return { ...res, backend: 'github' };
}

export async function deleteViaTarget(target: RepoTarget, path: string, message: string, opts: RepoWriteOptions = {}): Promise<RepoFileResult> {
  if (target.backend === 'local') {
    const result = await localDelete(target, path);
    await auditLocal(target, 'delete', path, message, opts, result);
    return result;
  }
  const res = await gh.deleteFile({ owner: target.owner, repo: target.repo, branch: target.branch, token: target.token, path, message });
  return { ...res, backend: 'github' };
}

export async function listDirViaTarget(target: RepoTarget, dir: string): Promise<RepoEntry[]> {
  if (target.backend === 'local') return localList(target, dir);
  return gh.listDir({ owner: target.owner, repo: target.repo, branch: target.branch, token: target.token, path: dir });
}

export interface RepoCommitResult {
  success: boolean;
  /** 每个路径对应的新 blob 号（前端拿它当下一次乐观锁的基准） */
  shas: Record<string, string>;
  commit?: string;
  /** 这批内容与仓库现状完全一致，没有产生提交 */
  unchanged?: boolean;
  error?: string;
  backend: RepoBackend;
}

/**
 * 一次提交写多个文件。
 *
 * github 后端走 Git Data API，整批落成**一个**提交 —— 每个提交都会触发一次 Pages 构建，
 * 所以「批量推送 3 篇」必须是 1 次构建而不是 3 次。本地后端没有提交概念，逐个落盘。
 */
export async function commitViaTarget(
  target: RepoTarget,
  files: { path: string; content: string }[],
  message: string,
  opts: RepoWriteOptions & { deletes?: string[] } = {},
): Promise<RepoCommitResult> {
  if (target.backend === 'local') {
    const shas: Record<string, string> = {};
    for (const f of files) {
      const result = await localWrite(target, f.path, f.content);
      await auditLocal(target, 'write', f.path, message, opts, result);
      if (!result.success) return { success: false, shas, backend: 'local', error: result.error ?? '写入失败' };
      if (result.sha) shas[f.path] = result.sha;
    }
    for (const p of opts.deletes ?? []) {
      const result = await localDelete(target, p);
      await auditLocal(target, 'delete', p, message, opts, result);
      if (!result.success) return { success: false, shas, backend: 'local', error: result.error ?? '删除失败' };
    }
    return { success: true, shas, backend: 'local' };
  }
  const res = await gh.commitFiles({
    owner: target.owner,
    repo: target.repo,
    branch: target.branch,
    token: target.token,
    message,
    files,
    deletes: opts.deletes,
  });
  return { ...res, shas: res.shas ?? {}, backend: 'github' };
}

export async function commitRepoFiles(
  env: Env,
  files: { path: string; content: string }[],
  message: string,
  opts: RepoWriteOptions & { deletes?: string[] } = {},
): Promise<RepoCommitResult> {
  return commitViaTarget(await resolveRepoTarget(env), files, message, opts);
}

/**
 * 递归列目录，只回文件路径。
 * 备份与仪表盘的「文章数 / 时刻数」共用这一份：单层 listDir 在多语言或
 * 页面包（post/index.md）布局下会把文章数成 0，两处都错过一次。
 * 目录不存在时回空数组而不是抛：新装的站 moments 目录可能就是空的。
 */
export async function walkFiles(
  target: RepoTarget,
  dir: string,
  opts: { exts?: string[]; cap?: number; maxDepth?: number } = {},
): Promise<string[]> {
  const exts = opts.exts ?? [];
  const cap = opts.cap ?? 600;
  const maxDepth = opts.maxDepth ?? 4;
  const out: string[] = [];

  const step = async (current: string, depth: number): Promise<void> => {
    if (depth > maxDepth || out.length >= cap) return;
    let entries: RepoEntry[];
    try {
      entries = await listDirViaTarget(target, current);
    } catch {
      return; // 目录不存在或读不到：当作没有内容，交给调用方按 0 处理
    }
    const subDirs: string[] = [];
    for (const e of entries) {
      if (out.length >= cap) break;
      if (e.type === 'dir') subDirs.push(e.path);
      else if (!exts.length || exts.some((x) => e.path.toLowerCase().endsWith(x))) out.push(e.path);
    }
    for (const d of subDirs) await step(d, depth + 1);
  };

  await step(dir.replace(/^\/+|\/+$/g, ''), 0);
  return out;
}

/* ------------------------------------------------------------------
 * 本地目录后端
 * ----------------------------------------------------------------*/

type FsModule = typeof import('node:fs/promises');
type PathModule = typeof import('node:path');

let fsLoader: Promise<FsModule> | null = null;
function loadFs(): Promise<FsModule> {
  // 只在 local 分支里 import，部署到 Worker 后这条路径不会执行，打包器也就不会把 node:fs 拽进产物
  fsLoader ??= import('node:fs/promises');
  return fsLoader;
}

/**
 * 本地开发的文件读写通道。
 * workerd 里 node:fs 是 unenv 的空壳（fs.readdir is not implemented），
 * 所以配了 GIT_LOCAL_HTTP 就走桥接进程，由它真正读写 GIT_LOCAL_DIR 指向的站点目录；
 * 没配就直接用 fs —— Node 侧脚本与单测走这条。
 */
function localHttp(env: Env | undefined): string {
  const fromBinding = (env as unknown as { GIT_LOCAL_HTTP?: string } | undefined)?.GIT_LOCAL_HTTP;
  if (fromBinding && fromBinding.trim()) return fromBinding.trim().replace(/\/+$/, '');
  try {
    const p = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process;
    const v = p?.env?.GIT_LOCAL_HTTP;
    if (v && v.trim()) return v.trim().replace(/\/+$/, '');
  } catch {
    /* Worker 运行时没有 process */
  }
  return '';
}

async function bridge<T>(env: Env | undefined, op: string, payload: Record<string, unknown>): Promise<T> {
  const base = localHttp(env);
  const res = await fetch(`${base}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error ?? `本地桥接 ${op} 失败（HTTP ${res.status}）`);
  return data;
}

/** 构建体检的结果：`ran:false` 表示这次没能跑起来（桥没起、没装 hugo、超时），不代表站点有问题 */
export interface BuildHealth {
  ran: boolean;
  ok: boolean;
  exit?: number;
  errors?: string[];
  note?: string;
}

/**
 * 本地后端专属的「构建体检」：让桥接进程真跑一次 `hugo --minify`，把退出码与 ERROR 行带回来。
 *
 * 为什么要这么绕：workerd 里起不了子进程，而**内容仓的构建失败在后台是看不见的** ——
 * 一篇 front matter 日期写坏了（Hugo 对它是整站失败，不是跳过这一篇），后台每笔保存都回「已保存」，
 * 站主只在很久之后发现站点停在旧版。闸门（services/hugo-guard.ts）挡掉已知形状，这一条兜住没挡到的。
 *
 * 只在配了 GIT_LOCAL_HTTP 时有意义：线上（GitHub + Pages）的构建结果在 Cloudflare/GitHub 那一侧，
 * Worker 够不着，返回 null 让调用方不发这个字段。
 * 任何失败都只降级为 `ran:false`，体检本身绝不能把保存带崩。
 */
export async function runLocalBuildCheck(env: Env): Promise<BuildHealth | null> {
  const base = localHttp(env);
  if (!base) return null;
  const token = (env as unknown as { REPO_BRIDGE_TOKEN?: string }).REPO_BRIDGE_TOKEN || '';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-repo-bridge'] = token;
  try {
    const res = await fetch(`${base}/doctor`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => null)) as Partial<BuildHealth> | null;
    if (!res.ok || !data) return { ran: false, ok: false, note: `桥接体检没答上来（HTTP ${res.status}）` };
    return {
      ran: data.ran === true,
      ok: data.ok === true,
      exit: typeof data.exit === 'number' ? data.exit : undefined,
      errors: Array.isArray(data.errors) ? data.errors.slice(0, 3) : [],
      note: data.note ?? '',
    };
  } catch (e) {
    return { ran: false, ok: false, note: `桥接体检没跑成：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 把体检结果写成一句给人看的话，拼进保存回执。
 *
 * 这一句是「静默失败」唯一的出口：内容仓构建失败时后台每笔保存都回「已保存」，
 * 站主要等到很久以后才发现前台停在旧版。所以 ok:false 必须出现在回执正文里，
 * 而不是只躺在那个 JSON 字段上等有人去读它。
 * `ran:false` 与 null 都不加话 —— 线上跑不到体检（Worker 起不了子进程），
 * 每次都补一句「本地没体检」只会让人以为坏了。
 */
export function buildHealthReceipt(h: BuildHealth | null | undefined): string {
  if (!h || !h.ran) return '';
  if (h.ok) return '；构建体检通过（本地实跑了一次 hugo）';
  const first = (h.errors ?? [])[0] ?? h.note ?? '';
  return `；⚠ 站点构建失败，前台会停在上一版${first ? `：${first}` : ''}`;
}

/** 仓库内的相对路径 → 本地绝对路径；越界（.. / 绝对路径）直接拒绝 */
async function localPath(target: RepoTarget, rel: string): Promise<string> {
  const clean = normalizeRelPath(rel);
  if (!clean) fail(400, '缺少文件路径');
  const { join, resolve, sep } = (await import('node:path')) as PathModule;
  const root = resolve(target.dir);
  const abs = resolve(join(root, clean.split('/').join(sep)));
  if (abs !== root && !abs.startsWith(root.endsWith(sep) ? root : root + sep)) fail(400, '路径越界，只能写站点目录内');
  return abs;
}

export function normalizeRelPath(rel: string): string {
  const clean = (rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some((seg) => seg === '..' || seg === '')) return '';
  return clean;
}

/**
 * 本地后端的「版本号」= 内容指纹（sha1 前 12 位），与桥接进程算法一致。
 * 读与写必须产出同一种 sha：之前写操作返回 `local:<sha>`、读操作返回裸 `<sha>`，
 * 后台带着写回来的 sha 再提交时与读到的永远不相等，第二次保存必被乐观锁判 409。
 */
async function contentSha(content: string): Promise<string> {
  const { createHash } = (await import('node:crypto')) as typeof import('node:crypto');
  return createHash('sha1').update(content).digest('hex').slice(0, 12);
}

async function localRead(target: RepoTarget, path: string): Promise<RepoFile | null> {
  if (localHttp(target.env)) {
    const r = await bridge<{ exists: boolean; content: string; sha: string }>(target.env, 'read', { path });
    return r.exists ? { content: r.content, sha: r.sha } : null;
  }
  const abs = await localPath(target, path);
  try {
    const fs = await loadFs();
    const content = await fs.readFile(abs, 'utf8');
    // 本地后端没有 git 的概念，用内容指纹顶上：后台的乐观锁比对它
    return { content, sha: await contentSha(content) };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') return null;
    throw new Error(explainLocalFsError(e));
  }
}

async function localWrite(target: RepoTarget, path: string, content: string): Promise<RepoFileResult> {
  try {
    // 与 GitHub 后端同一条规则：内容没变就不算一次写入，
    // 免得定时任务天天导出同一份统计时留下空提交和空审计
    const before = await localRead(target, path);
    if (before && before.content === content) {
      return { success: true, path, backend: 'local', sha: before.sha, unchanged: true };
    }
    if (localHttp(target.env)) {
      const r = await bridge<{ ok: boolean; sha: string }>(target.env, 'write', { path, content });
      return { success: true, path, backend: 'local', sha: r.sha, committedAt: new Date().toISOString() };
    }
    const abs = await localPath(target, path);
    const fs = await loadFs();
    const { dirname } = (await import('node:path')) as PathModule;
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return { success: true, path, backend: 'local', sha: await contentSha(content), committedAt: new Date().toISOString() };
  } catch (e) {
    return { success: false, path, backend: 'local', error: explainLocalFsError(e) };
  }
}

/**
 * workerd 里没有真实文件系统：`node:fs` 被 unenv 打成空壳，一调用就报英文的
 * `[unenv] fs.readFile is not implemented yet!`。这句对使用者毫无意义
 * （看着像「代码坏了」，其实是少起了一个本地进程，而且失败是静默的），所以翻译成人话再回出去。
 * 只有本地这条分支会走到这里 —— 线上走 GitHub 后端，不经过这段。
 */
function explainLocalFsError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  /** 本地写之前会先读一遍（比内容有没有变），读那步翻过一次的话这里不能再套第二层 */
  if (raw.includes(LOCAL_FS_HINT)) return raw;
  if (!/not implemented/i.test(raw)) return raw;
  return `${LOCAL_FS_HINT}（原文：${raw}）。原因：只配了 GIT_LOCAL_DIR、没起桥接进程，回写会静默失败。解法：把 \`pnpm repo:bridge\` 起着，并在 packages/api/.dev.vars 里同时设 GIT_LOCAL_DIR 与 GIT_LOCAL_HTTP`;
}

const LOCAL_FS_HINT = '本地 Worker 里没有文件系统';

/**
 * 本地开发专用：把这篇在构建产物里的那一份删掉（public/<分类>/<目录>）。
 *
 * `hugo server` 默认是增量渲染 + 产物落盘：源文件删了，它不会回头删已经生成的
 * `public/posts/xxx/index.html`，于是后台删掉的文章在本地还能按老地址打开。
 * 线上 Pages 每次都是干净目录，没有这个问题。
 *
 * 产物目录名是 Hugo 按标题 urlize 出来的（中文标题会去掉标点），从 Worker 侧猜不准，
 * 所以让桥接进程扫一遍：目录名等于文件名，或那页 `<title>` 里有这个标题，就算它。
 * 清不掉不算失败（下一次全量构建自然没有它），因此不抛错，只回报清掉了哪些。
 */
export async function pruneLocalBuild(
  target: RepoTarget,
  page: { kind: string; stem: string; title?: string },
): Promise<string[]> {
  if (target.backend !== 'local') return [];
  const kind = normalizeRelPath(page.kind);
  const stem = (page.stem ?? '').trim();
  if (!kind || !stem) return [];
  try {
    if (localHttp(target.env)) {
      const r = await bridge<{ removed?: string[] }>(target.env, 'purge-page', {
        kind,
        stem,
        title: (page.title ?? '').trim(),
      });
      return Array.isArray(r?.removed) ? r.removed : [];
    }
    const { join } = (await import('node:path')) as PathModule;
    const fs = await loadFs();
    const base = join(target.dir, 'public', kind);
    const names = await fs.readdir(base).catch(() => [] as string[]);
    const titleOf = (html: string) => (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1]?.trim() ?? '';
    const removed: string[] = [];
    for (const name of names) {
      let hit = name === stem;
      if (!hit && page.title) {
        const html = await fs.readFile(join(base, name, 'index.html'), 'utf8').catch(() => '');
        const t = titleOf(html);
        hit = Boolean(t) && (t === page.title || t.startsWith(page.title) || t.endsWith(page.title));
      }
      if (!hit) continue;
      await fs.rm(join(base, name), { recursive: true, force: true });
      removed.push(`public/${kind}/${name}`);
    }
    return removed;
  } catch {
    return [];
  }
}

async function localDelete(target: RepoTarget, path: string): Promise<RepoFileResult> {
  try {
    if (localHttp(target.env)) {
      await bridge(target.env, 'delete', { path });
    } else {
      const abs = await localPath(target, path);
      const fs = await loadFs();
      await fs.rm(abs, { force: true });
    }
    return { success: true, path, backend: 'local' };
  } catch (e) {
    return { success: false, path, backend: 'local', error: explainLocalFsError(e) };
  }
}

async function localList(target: RepoTarget, dir: string): Promise<RepoEntry[]> {
  const rel = normalizeRelPath(dir) || '.';
  if (localHttp(target.env)) {
    const r = await bridge<{ entries: RepoEntry[] }>(target.env, 'list', { dir: rel });
    return (r.entries ?? []).sort((a, b) => a.name.localeCompare(b.name));
  }
  const abs = await localPath(target, rel);
  try {
    const fs = await loadFs();
    const dirents = await fs.readdir(abs, { withFileTypes: true });
    const base = rel === '.' ? '' : rel.replace(/\/+$/, '') + '/';
    return dirents
      .map((d) => ({ name: d.name, path: base + d.name, type: d.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') return [];
    throw e;
  }
}
/** 本地写入没有 commit 可回溯，审计就是唯一的凭据 */
async function auditLocal(
  target: RepoTarget,
  event: 'write' | 'delete',
  path: string,
  message: string,
  opts: RepoWriteOptions,
  result: RepoFileResult,
): Promise<void> {
  if (opts.audit === false || !target.env || result.unchanged) return;
  await writeAudit(target.env, {
    actor: opts.actor ?? null,
    action: opts.action ?? 'content',
    target: path,
    detail: {
      event,
      backend: 'local-dir',
      dir: target.dir,
      message,
      success: result.success,
      error: result.error ?? null,
    },
    ip: opts.ip,
  });
}
