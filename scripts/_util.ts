import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const API_DIR = resolve(ROOT, 'packages/api');
export const CMS_DIR = resolve(ROOT, 'packages/cms');
export const COMMENT_DIR = resolve(ROOT, 'packages/comment');

/** 资源名写死，与各包 package.json 里的 wrangler 命令保持一致 */
export const D1_NAME = 'zero-db';
export const R2_NAME = 'zero-media';
export const QUEUE_NAME = 'zero-email';
export const KV_CACHE = 'CACHE';
export const KV_SESSION = 'SESSION';
export const WORKER_NAME = 'zero-api';
export const PAGES_PROJECT = 'zero-cms';

const BIN = resolve(ROOT, 'node_modules/.bin/wrangler' + (process.platform === 'win32' ? '.cmd' : ''));

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

export interface RunOptions {
  cwd?: string;
  /** 通过 stdin 送入的内容（用于 wrangler secret put，绝不拼进命令行） */
  input?: string;
  /** 静默执行并返回输出，失败时抛出 */
  capture?: boolean;
  /** 追加/覆盖的环境变量（vite 的 VITE_* 就在这儿传，不进命令行参数） */
  env?: Record<string, string>;
}

/** shell: true —— Windows 需要 cmd 来执行 .cmd 包装脚本 */
export function run(command: string, opts: RunOptions = {}): string {
  const res = spawnSync(command, {
    cwd: opts.cwd ?? ROOT,
    shell: true,
    encoding: 'utf-8',
    input: opts.input,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: [opts.input ? 'pipe' : 'inherit', opts.capture ? 'pipe' : 'inherit', opts.capture ? 'pipe' : 'inherit'],
  });
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  if (res.error) throw new Error(`${command} 执行失败：${res.error.message}`);
  if (res.status !== 0) throw new Error(`${command} 退出码 ${res.status}\n${(stderr + stdout).trim()}`);
  return (stdout + stderr).trim();
}

export function tryRun(command: string, opts: RunOptions = {}): string | null {
  try {
    return run(command, { ...opts, capture: true });
  } catch {
    return null;
  }
}

export function wrangler(args: string, opts: RunOptions = {}): string {
  if (!existsSync(BIN)) die('找不到本地 wrangler，请先在仓库根目录执行 pnpm install');
  return run(`${quote(BIN)} ${args}`, opts);
}

export function wranglerTry(args: string, opts: RunOptions = {}): string | null {
  if (!existsSync(BIN)) return null;
  return tryRun(`${quote(BIN)} ${args}`, opts);
}

/** wrangler 的 JSON 输出前后可能夹着 banner 行，从第一个 { 或 [ 起截取 */
export function parseJson<T = unknown>(raw: string): T | null {
  const start = raw.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start)) as T;
  } catch {
    return null;
  }
}

export function step(message: string): void {
  console.log(`\n\x1b[36m▶ ${message}\x1b[0m`);
}

export function info(message: string): void {
  console.log(`  ${message}`);
}

export function good(message: string): void {
  console.log(`\x1b[32m✓ ${message}\x1b[0m`);
}

export function warn(message: string): void {
  console.log(`\x1b[33m! ${message}\x1b[0m`);
}

export function die(message: string): never {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`);
  process.exit(1);
}

/** 中日韩与全角标点占两列，其余按一列 */
const WIDE = /[ᄀ-⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓿가-힣豈-﫿︰-＀-｠￠-￦]/;
export function columns(s: string): number {
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
}

/**
 * 提问文案的宽度兜底。
 *
 * prompts 每敲一个字符就把当前这一问整行重画一次，而 PowerShell 的 conhost
 * 擦不掉换行后的残留：文案 + 输入值一旦超过终端宽度，屏幕上就会留下一串重复行。
 * 所以 message 只留短标签，解释文字在提问前单独 console.log 一行。
 * 这里在模块加载时就把超长的问出来，免得等到部署到一半才发现。
 */
export function assertShortMessages(questions: { name?: unknown; message?: unknown }[], maxColumns = 24): void {
  for (const q of questions) {
    const width = columns(typeof q.message === 'string' ? q.message : '');
    if (width > maxColumns) {
      throw new Error(
        `脚本自身的提问过长：${String(q.name)} 的 message 占 ${width} 列（上限 ${maxColumns}），会让终端刷屏。把说明挪到提问前的一行 console.log 里`,
      );
    }
  }
}

/** Cloudflare 各资源的 id 形状不同：D1 是带连字符的 UUID，KV 是 32 位十六进制 */
const ID_PATTERNS = [
  /"database_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i,
  /database_id\s*=\s*"([0-9a-f-]{36})"/i,
  /"id"\s*:\s*"([0-9a-f]{32})"/i,
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  /\b([0-9a-f]{32})\b/i,
];

export function extractId(output: string): string | null {
  for (const re of ID_PATTERNS) {
    const m = output.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function hasWranglerConfig(): boolean {
  return existsSync(resolve(API_DIR, 'wrangler.jsonc'));
}

/* --------------------------- Cloudflare Pages 项目 --------------------------- */

/** 表格输出（`│ zero-cms │ …`）拆成单元格：边框字符不是空白，不能用 \b 切词 */
function tableCells(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .flatMap((line) => line.split(/[│|]/).map((cell) => cell.trim()))
    .filter(Boolean);
}

export function pagesProjectExists(name: string): boolean {
  const raw = wranglerTry('pages project list', { cwd: ROOT });
  return !!raw && tableCells(raw).includes(name);
}

/**
 * 先把 Pages 项目建出来，pages deploy 只推产物。
 *
 * pages deploy 遇到不存在的项目会弹「要不要创建」，而非交互上下文里它直接报
 * 「This command cannot be run in a non-interactive context」—— CI 必然踩到，
 * 本地也躲不掉：脚本为了从输出里取 pages.dev 地址会把 stdout 接成管道，
 * wrangler 就此判定为非交互。所以这一步必须显式做，不能指望它问。
 */
export function ensurePagesProject(name: string, productionBranch = 'main'): boolean {
  if (pagesProjectExists(name)) return false;
  wranglerTry(`pages project create ${name} --production-branch ${productionBranch}`, { cwd: ROOT });
  if (!pagesProjectExists(name)) {
    die(
      `创建 Pages 项目 ${name} 失败。手动执行看具体报错：\n` +
        `  cd packages/cms && npx wrangler pages project create ${name} --production-branch ${productionBranch}`,
    );
  }
  return true;
}

/* --------------------------- Cloudflare 登录态 --------------------------- */

interface WhoamiRaw {
  loggedIn?: boolean;
  authType?: string;
  email?: string;
  accounts?: { id?: string; name?: string }[];
  /** 更早的 wrangler 把身份放在 auth 里 */
  auth?: { email?: string; accounts?: { id?: string; name?: string }[] };
  /** 更早的 wrangler 把整包结果塞在 result 里 */
  result?: WhoamiRaw;
}

export interface Whoami {
  /** 展示用标识：OAuth 登录是邮箱；API Token 登录没有邮箱，退到账户名 */
  label: string;
  accountId: string | null;
}

/**
 * 纯解析 wrangler 的 whoami 输出。
 *
 * 4.x 是平铺的 {loggedIn, authType, email, accounts}，3.x 之前包一层 result，
 * 更早是 {auth:{email}} —— 只认其中一种就会出现「明明已登录却判成未登录」，
 * 向导会白跑一遍浏览器授权然后死在「登录未完成」。三种都读，全认不出才算未登录。
 */
export function parseWhoami(raw: string): Whoami | null {
  const json = parseJson<WhoamiRaw>(raw);
  if (!json) return null;
  const flat: WhoamiRaw = { ...json, ...(json.result ?? {}), ...(json.auth ?? {}) };
  if (flat.loggedIn === false) return null;
  const accounts = Array.isArray(flat.accounts) ? flat.accounts : [];
  const email = typeof flat.email === 'string' ? flat.email.trim() : '';
  const accountId = accounts.find((a) => a && typeof a.id === 'string')?.id ?? null;
  const accountName = accounts.find((a) => a && typeof a.name === 'string')?.name ?? '';
  const label = email || accountName || (flat.authType ? `${flat.authType}（无邮箱）` : '');
  if (!label && !accountId) return null;
  return { label: label || (accountId as string), accountId };
}

/**
 * 当前 Cloudflare 登录身份，附带「读不出来」时的原始报错。
 *
 * 必须从仓库根目录跑：wrangler 会向上找最近的 wrangler.jsonc 并先解析它，
 * 一旦 packages/api/wrangler.jsonc 是坏的（比如向导把 undefined 写了进去），
 * 在 packages/api 里连 whoami 都会以「配置读不懂」失败退出，
 * 上层只看返回值就会误判成「你没登录」，然后反复弹浏览器授权。
 */
export function whoamiDetail(): { me: Whoami | null; error: string | null } {
  try {
    const raw = wrangler('whoami --json', { cwd: ROOT, capture: true });
    const me = parseWhoami(raw);
    return { me, error: me ? null : `wrangler whoami --json 的输出读不出身份：\n${raw.slice(0, 400)}` };
  } catch (e) {
    return { me: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 未登录、或输出/配置认不出时返回 null */
export function whoami(): Whoami | null {
  return whoamiDetail().me;
}

/** 打开浏览器完成 OAuth 授权；同样从根目录跑，绕开可能损坏的 worker 配置 */
export function wranglerLogin(): void {
  wrangler('login', { cwd: ROOT });
}

export function requireWranglerConfig(): void {
  if (hasWranglerConfig()) return;
  die('packages/api/wrangler.jsonc 不存在。请先运行 pnpm setup 创建 Cloudflare 资源并生成配置。');
}

/** 上次部署后台时用的 API 地址，存在本机（不入库），下次部署不用再问 */
const API_BASE_FILE = resolve(CMS_DIR, '.zero-api-base');

export function readSavedApiBase(): string {
  try {
    return readFileSync(API_BASE_FILE, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function saveApiBase(url: string): void {
  try {
    writeFileSync(API_BASE_FILE, url.trim() + '\n');
  } catch {
    warn(`没能记住 API 地址（${API_BASE_FILE} 写不进去），下次部署要重新填`);
  }
}
