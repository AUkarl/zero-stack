import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/* --------------------------- R2：私有桶 + 公开桶 --------------------------- */

/**
 * 上传用的两个桶：
 *   zero-media         私有，只有 Worker 读得到（走 /api/media/<桶>/<键> 代读）
 *   zero-media-public  公开，绑上一个自定义域名后图片就是直链 —— 不占 Worker 的请求数与
 *                      CPU 时间，RSS、阅读器、外链都能直接取，加载最快
 * 这里只建「缺的那个」，已存在的桶和桶里的文件一个都不动。
 */
export const R2_PUBLIC_DEFAULT = 'zero-media-public';
export const R2_PUBLIC_BINDING = 'R2_PUBLIC';

/** wrangler 调用可以整体换成假的，好在没登录时也能自测这套判定 */
export type WranglerRun = (args: string) => string | null;

/**
 * 常见「二级后缀」：遇到这些要往后多取一段，否则 blog.demo.co.uk 会算出 co.uk，
 * 给的默认域名直接是错的（只是建议值，改起来一下回车，但别一上来就误导）。
 */
const TWO_LEVEL = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'me.uk',
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'com.hk',
  'com.tw',
  'com.au',
  'net.au',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.kr',
  'com.br',
  'com.sg',
  'com.my',
  'co.in',
  'com.mx',
  'co.za',
  'com.ru',
]);

/** https://blog.example.com/x → example.com；认不出裸域就回空串（改问用户） */
export function apexOf(url: string): string {
  const host = (url ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .split(':')[0];
  if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return '';
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.').toLowerCase();
  return TWO_LEVEL.has(last2) ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

/** 建桶：同名就跳过。返回是否新建，绝不删除或清空已有桶 */
export function ensureBucket(name: string, exec: WranglerRun = wranglerTry): { name: string; created: boolean } {
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(name)) {
    throw new Error(`R2 桶名不合规则：${name}（只能用小写字母、数字、点、下划线、连字符，长度 3~63，首尾必须是字母或数字）`);
  }
  const listed = exec('r2 bucket list');
  if (listed && listed.split('\n').some((line) => line.includes(name))) {
    info(`R2 ${name} 已存在，跳过创建（桶里的文件一个不动）`);
    return { name, created: false };
  }
  if (exec(`r2 bucket create ${name}`) === null) {
    die(`R2 ${name} 创建失败。手动执行看具体报错：npx wrangler r2 bucket create ${name}`);
  }
  good(`R2 ${name} 已创建`);
  return { name, created: true };
}

export interface DomainBind {
  /** 域名最终是否可用（已绑上或本来就绑着） */
  ok: boolean;
  /** 这次有没有真发过绑定命令 */
  attempted: boolean;
  hostname: string;
  detail: string;
}

/**
 * 给公开桶绑自定义域名。
 *
 * `wrangler r2 bucket domain add` 一定要 zone-id，而只有「这个域名的 DNS 托管在当前 Cloudflare
 * 账户」时才有 zone-id —— 这正好就是「同账户自动绑、不同账户手工填」的判定：
 * 填了且绑成功 → 全自动；没填或绑不上 → 把要做什么原样打出来，不假装成功。
 */
export function bindBucketDomain(bucket: string, hostname: string, zoneId: string, exec: WranglerRun = wranglerTry): DomainBind {
  const host = hostname.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!host) return { ok: false, attempted: false, hostname: '', detail: '没填域名，公开桶先用内部地址，之后可以在控制台绑域名' };
  const zone = zoneId.trim();
  if (!zone) {
    return {
      ok: false,
      attempted: false,
      hostname: host,
      detail: `没填 Zone ID（域名的 DNS 不在这个 Cloudflare 账户时就是这样）。请自己到控制台「R2 → ${bucket} → 设置 → 自定义域名」里绑 ${host}，绑完去 DNS 那边把 CNAME 验证过`,
    };
  }
  const listed = exec(`r2 bucket domain list ${bucket}`);
  if (listed && listed.includes(host)) return { ok: true, attempted: false, hostname: host, detail: '这个域名已经绑在桶上，不重复绑' };

  const out = exec(`r2 bucket domain add ${bucket} --domain ${host} --zone-id ${zone} --force`);
  if (out === null) {
    return {
      ok: false,
      attempted: true,
      hostname: host,
      detail: `wrangler 没能绑上（多半是这个 zone 不在当前账户、或令牌没有 Zone 权限）。请手工到「R2 → ${bucket} → 设置 → 自定义域名」里加 ${host}，然后在 DNS 里确认那条记录`,
    };
  }
  return { ok: true, attempted: true, hostname: host, detail: '已自动绑定' };
}

/**
 * 后台「媒体库 → 存储桶」那份 mediaBuckets（site_config 里的 JSON 数组）：
 * 把公开桶追加进去，已有条目一个不改（站长自己加的 S3 桶也原样留着），按 binding 去重。
 */
export function mergePublicBucketEntry(
  existing: string,
  entry: Record<string, unknown>,
): { json: string; changed: boolean } {
  let list: unknown[] = [];
  const raw = (existing ?? '').trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      /* 原来那份坏了就按空的来：这里跟着抛错的话，整体会死在一步合并配置上，
         而桶其实已经建好了 —— 宁可重写一份好的 */
    }
  }
  const binding = String(entry.binding ?? '');
  const has = list.some((x) => !!x && typeof x === 'object' && String((x as Record<string, unknown>).binding ?? '') === binding);
  if (has) return { json: JSON.stringify(list), changed: false };
  return { json: JSON.stringify([...list, entry]), changed: true };
}

/**
 * 写进 D1 的 site_config。走 --file 而不是 --command：JSON 里全是双引号，
 * 拼在命令行上要穿过 cmd.exe 这一层，转义出错的报错长得很像「SQL 语法错误」，很难查。
 */
export function upsertConfigValue(
  dbName: string,
  key: string,
  value: string,
  valueType: string,
  runCmd: (args: string) => string | null = wranglerTry,
): boolean {
  const file = resolve(tmpdir(), `zero-media-buckets-${process.pid}.sql`);
  const sqlText = [
    'begin;',
    `insert into site_config (key, value, value_type, updated_at) values ('${key}', '${value.replace(/'/g, "''")}', '${valueType}', strftime('%s','now'))`,
    `on conflict (key) do update set value = '${value.replace(/'/g, "''")}', value_type = '${valueType}', updated_at = strftime('%s','now');`,
    'commit;',
  ].join('\n');
  try {
    writeFileSync(file, sqlText, 'utf-8');
    return runCmd(`d1 execute ${dbName} --remote --file ${quote(file)}`) !== null;
  } finally {
    try {
      rmSync(file, { force: true });
    } catch {
      /* 临时 SQL 删不掉不影响部署结果 */
    }
  }
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
