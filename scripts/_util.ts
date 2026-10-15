import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
}

/** shell: true —— Windows 需要 cmd 来执行 .cmd 包装脚本 */
export function run(command: string, opts: RunOptions = {}): string {
  const res = spawnSync(command, {
    cwd: opts.cwd ?? ROOT,
    shell: true,
    encoding: 'utf-8',
    input: opts.input,
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

/** 当前 Cloudflare 登录身份；未登录或输出认不出时返回 null */
export function whoami(): Whoami | null {
  const raw = wranglerTry('whoami --json', { cwd: API_DIR });
  return raw ? parseWhoami(raw) : null;
}

export function requireWranglerConfig(): void {
  if (hasWranglerConfig()) return;
  die('packages/api/wrangler.jsonc 不存在。请先运行 pnpm setup 创建 Cloudflare 资源并生成配置。');
}
