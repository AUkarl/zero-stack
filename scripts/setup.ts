import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import prompts, { type PromptObject } from 'prompts';
import {
  API_DIR,
  CMS_DIR,
  COMMENT_DIR,
  D1_NAME,
  KV_CACHE,
  KV_SESSION,
  PAGES_PROJECT,
  QUEUE_NAME,
  R2_NAME,
  R2_PUBLIC_BINDING,
  R2_PUBLIC_DEFAULT,
  WORKER_NAME,
  apexOf,
  bindBucketDomain,
  die,
  ensureBucket,
  ensurePagesProject,
  extractId,
  good,
  info,
  mergePublicBucketEntry,
  parseJson,
  pickProdUrl,
  probeUrl,
  run,
  readSavedApiBase,
  saveApiBase,
  saveCmsUrl,
  step,
  assertShortMessages,
  upsertConfigValue,
  warn,
  whoamiDetail,
  wrangler,
  wranglerLogin,
  wranglerTry,
} from './_util.js';

type EmailProvider = 'smtp' | 'resend' | 'cloudflare' | 'none';

interface Answers {
  siteName: string;
  siteUrl: string;
  cmsUrl: string;
  apiUrl?: string;
  /** 公开桶：名字 + 要绑的域名 + 该域名的 Zone ID（同账户才填得出来） */
  publicBucket: string;
  publicDomain: string;
  publicZoneId?: string;
  emailProvider: EmailProvider;
  smtpHost?: string;
  smtpPort?: string;
  smtpUser?: string;
  smtpPassword?: string;
  resendApiKey?: string;
  cfAccountId?: string;
  cfEmailToken?: string;
  useGithub: boolean;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  githubToken?: string;
}

interface ResourceIds {
  dbId: string;
  cacheId: string;
  sessionId: string;
}

async function ask(questions: PromptObject[]): Promise<Answers> {
  const answers = await prompts(questions, {
    onCancel: () => {
      console.log('\n已取消，未对 Cloudflare 做任何改动。');
      process.exit(0);
    },
  });
  return answers as Answers;
}

async function confirm(message: string, initial = true): Promise<boolean> {
  const { go } = await prompts({ type: 'confirm', name: 'go', message, initial });
  return Boolean(go);
}

/* --------------------------- Cloudflare 资源 --------------------------- */

/** ensureLogin 认出来的账户 id：后面「Cloudflare 邮件通道」那一问拿它当默认值 */
let loginAccountId: string | null = null;

function ensureLogin(): void {
  let detail = whoamiDetail();
  if (!detail.me) {
    info('尚未登录（或 wrangler 的登录态读不出来），将打开浏览器完成授权');
    /** 不把真实报错打出来，「配置坏了」就会被当成「我没登录」反复重跑授权 */
    if (detail.error) info(detail.error.split('\n').slice(0, 8).join('\n'));
    wranglerLogin();
    detail = whoamiDetail();
    if (!detail.me) {
      die(
        '登录未完成：wrangler whoami 仍读不到身份。\n' +
          (detail.error ? `  它的原始报错：\n${detail.error.split('\n').slice(0, 8).join('\n')}\n` : '') +
          '  也可以在环境变量里给 CLOUDFLARE_API_TOKEN 后重跑 pnpm setup',
      );
    }
  }
  loginAccountId = detail.me.accountId;
  good(`已登录 Cloudflare：${detail.me.label}${detail.me.accountId ? `（账户 ${detail.me.accountId}）` : ''}`);
}

/** D1 的 list 支持 --json，可精确定位同名库 */
function findD1Id(): string | null {
  const raw = wranglerTry('d1 list --json', { cwd: API_DIR });
  const list = raw ? parseJson<Array<{ name: string; uuid: string }>>(raw) : null;
  return list?.find((d) => d.name === D1_NAME)?.uuid ?? null;
}

/** KV 的 list 只有表格输出，按「同一行里既有 32 位 id 又有命名空间标题」匹配 */
function findKvId(title: string): string | null {
  const raw = wranglerTry('kv namespace list', { cwd: API_DIR });
  if (!raw) return null;
  for (const line of raw.split('\n')) {
    const id = line.match(/\b[0-9a-f]{32}\b/i)?.[0];
    if (id && new RegExp(`\\b${title}\\b`).test(line)) return id;
  }
  return null;
}

function resourceExists(name: string, listCmd: string): boolean {
  const raw = wranglerTry(listCmd, { cwd: API_DIR });
  return !!raw && raw.includes(name);
}

function idFrom(label: string, find: () => string | null, createCmd: string): string {
  const existing = find();
  if (existing) {
    info(`${label} 已存在，复用 id ${existing}`);
    return existing;
  }
  const out = wrangler(createCmd, { cwd: API_DIR, capture: true });
  const id = find() ?? extractId(out);
  if (!id) throw new Error(`${label} 已创建，但没能解析出 id。请把真实 id 写入 packages/api/wrangler.jsonc 后重试`);
  good(`${label} 已创建：${id}`);
  return id;
}

function nameOnly(label: string, name: string, listCmd: string, createCmd: string): void {
  if (resourceExists(name, listCmd)) {
    info(`${label} 已存在，跳过创建`);
    return;
  }
  wrangler(createCmd, { cwd: API_DIR, capture: true });
  good(`${label} 已创建`);
}

function createResources(): ResourceIds {
  const dbId = idFrom(`D1 ${D1_NAME}`, findD1Id, `d1 create ${D1_NAME}`);
  nameOnly(`R2 ${R2_NAME}`, R2_NAME, 'r2 bucket list', `r2 bucket create ${R2_NAME}`);
  nameOnly(`Queue ${QUEUE_NAME}`, QUEUE_NAME, 'queues list', `queues create ${QUEUE_NAME}`);
  const cacheId = idFrom(`KV ${KV_CACHE}`, () => findKvId(KV_CACHE), `kv namespace create ${KV_CACHE}`);
  const sessionId = idFrom(`KV ${KV_SESSION}`, () => findKvId(KV_SESSION), `kv namespace create ${KV_SESSION}`);
  return { dbId, cacheId, sessionId };
}

/* ---------------- 公开桶：建桶 + 绑域名 + 登记进后台 ---------------- */

interface PublicBucketPlan {
  name: string;
  /** 要绑（或已绑）的域名，没填就空串 */
  hostname: string;
  /** 域名确实可用时的直链前缀，进 mediaBuckets 的 baseUrl */
  baseUrl: string;
  bound: boolean;
  note: string;
}

/**
 * 域名真绑上才有直链：没绑成就把 baseUrl 写进配置，图片地址会全部指向一个还不存在的
 * 域名，表现是后台上传成功、前台一片裂图 —— 比不配还难查。
 * 但「域名没绑」不该连累桶本身登记进后台：没直链时图片走 Worker 读取（站内路径）照样能用，
 * 站主之后把域名绑上、回这个桶填一次直链前缀就升级成直链。
 */
function preparePublicBucket(a: Answers): PublicBucketPlan {
  const name = (a.publicBucket ?? '').trim() || R2_PUBLIC_DEFAULT;
  ensureBucket(name);
  const bind = bindBucketDomain(name, a.publicDomain ?? '', a.publicZoneId ?? '');
  if (bind.ok) good(`${name} → ${bind.hostname ? `https://${bind.hostname}` : '（无域名）'}：${bind.detail}`);
  else warn(`${name}：${bind.detail}`);
  return { name, hostname: bind.hostname, baseUrl: bind.ok && bind.hostname ? `https://${bind.hostname}` : '', bound: bind.ok, note: bind.detail };
}

/** 读 D1 里现成的那条配置（这里是 mediaBuckets），没有就空串 */
function readRemoteConfig(key: string): string {
  const raw = wranglerTry(`d1 execute ${D1_NAME} --remote --command "select value from site_config where key='${key}'" --json`, { cwd: API_DIR });
  const parsed = raw ? parseJson<Array<{ results?: { value?: string }[] }>>(raw) : null;
  return parsed?.[0]?.results?.[0]?.value ?? '';
}

/** 后台那两个默认桶：私有桶是这个 Worker 唯一确定可读的桶，公开桶负责直链 */
const PRIVATE_BUCKET_ENTRY = { id: 'r2', label: '私有桶（走后台读取）', kind: 'r2', binding: 'R2', baseUrl: '' };
const PUBLIC_BUCKET_ENTRY = (baseUrl: string): Record<string, unknown> => ({ id: 'public', label: '公开桶（直链）', kind: 'r2', binding: R2_PUBLIC_BINDING, baseUrl });

/**
 * 把两个桶都登记进后台的 mediaBuckets（已有的条目一个不改，站长自己加的 S3 桶原样留着）。
 *
 * 以前只登记公开桶、且域名没绑成就一条都不写：前者让默认桶从列表里消失
 * （配置一有值就不再兜底），后者让后台只看到一个桶 —— 站主要「要紧的放私有、
 * 不重要的放公开」，两个都得先出现在上传下拉里。
 */
function seedPublicBucketConfig(pub: PublicBucketPlan): void {
  const withPrivate = mergePublicBucketEntry(readRemoteConfig('mediaBuckets'), PRIVATE_BUCKET_ENTRY);
  const merged = mergePublicBucketEntry(withPrivate.json, PUBLIC_BUCKET_ENTRY(pub.baseUrl));
  if (!merged.changed) {
    good('后台「媒体库 → 存储桶」里私有桶与公开桶都在，不重复写');
    return;
  }
  if (upsertConfigValue(D1_NAME, 'mediaBuckets', merged.json, 'json')) {
    if (pub.baseUrl) good(`两个桶都已登记进后台，上传时可选：私有桶走 Worker 读取，公开桶 ${pub.baseUrl} 是直链`);
    else good('两个桶都已登记进后台，上传时可选；公开桶还没有可用的直链域名，它的图片先走 Worker 读取，绑好域名后在该桶填「直链前缀」即可');
  } else {
    warn(`桶建好了，但没能自动写进 D1。在后台「媒体库 → 存储桶」手工加这两条：\n  ${merged.json}`);
  }
}

/**
 * 向导问过的项直接写进 site_config。
 *
 * 以前 SITE_URL / SITE_NAME 只进 wrangler vars、SMTP 只存了密码，于是后台「设置」里
 * 那些框还是空的，汇总又让站主去填第二遍 —— 而 vars 那份后台根本看不见，
 * 站主改在后台的值也不会回头影响 vars。写进库里才是后台显示与修改的那一份。
 */
function seedSiteConfig(a: Answers): string[] {
  const user = (a.smtpUser ?? '').trim();
  const want: [string, string][] = [
    ['siteName', (a.siteName ?? '').trim()],
    ['siteUrl', (a.siteUrl ?? '').trim().replace(/\/+$/, '')],
    ['cmsAdminUrl', (a.cmsUrl ?? '').trim()],
    ['githubOwner', (a.githubOwner ?? '').trim()],
    ['githubRepo', (a.githubRepo ?? '').trim()],
    ['githubBranch', (a.githubBranch ?? '').trim()],
  ];
  if (a.emailProvider === 'smtp') want.push(['smtpHost', (a.smtpHost ?? '').trim()], ['smtpPort', (a.smtpPort ?? '').trim()], ['smtpUser', user], ['emailFrom', user]);
  if (a.emailProvider === 'cloudflare') want.push(['cloudflareAccountId', (a.cfAccountId ?? '').trim()]);

  const written: string[] = [];
  for (const [key, value] of want) {
    if (!value) continue;
    if (upsertConfigValue(D1_NAME, key, value, 'string')) written.push(key);
    else warn(`「${key}」没能自动写进 D1（值：${value}），到后台「设置」里补一下`);
  }
  return written;
}

/** 向导拿不到、必须站主自己去后台补的东西；空数组就意味着配置已经齐了 */
function stillMissing(a: Answers): string[] {
  const missing: string[] = [];
  if (a.emailProvider === 'none') missing.push('发信方式（SMTP 主机 / 账号 / 授权码，或 Resend key）');
  if (a.emailProvider === 'resend' || a.emailProvider === 'cloudflare') missing.push('发件人地址 emailFrom');
  if (a.useGithub && !(a.githubToken ?? '').trim()) missing.push('内容仓库的 GitHub token（后台「设置 → 内容仓库」）');
  return missing;
}

/** 已配置过的仓库重复运行 setup 时，直接沿用旧 id，避免再次占用同名资源 */function readExistingIds(): ResourceIds | null {
  const file = resolve(API_DIR, 'wrangler.jsonc');
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf-8');
  const dbId = raw.match(/"database_id"\s*:\s*"([^"]+)"/)?.[1];
  const cacheId = raw.match(/"binding"\s*:\s*"CACHE"\s*,\s*"id"\s*:\s*"([^"]+)"/)?.[1];
  const sessionId = raw.match(/"binding"\s*:\s*"SESSION"\s*,\s*"id"\s*:\s*"([^"]+)"/)?.[1];
  if (!dbId || !cacheId || !sessionId) return null;
  if (/[<>]/.test(dbId + cacheId + sessionId)) return null;
  return { dbId, cacheId, sessionId };
}

/**
 * 重跑 setup 时读回现有地址。这三问的答案会整段覆盖 wrangler.jsonc 里的
 * SITE_URL / ALLOWED_ORIGINS —— 不读回来，手改的值（尤其是给 Worker 绑的自定义域名）
 * 就会被占位默认值无声冲掉，表现为后台突然 Failed to fetch。
 */
function readExistingUrls(): { siteUrl: string; cmsUrl: string; apiUrl: string; origins: string[] } {
  const empty = { siteUrl: '', cmsUrl: '', apiUrl: '', origins: [] as string[] };
  const file = resolve(API_DIR, 'wrangler.jsonc');
  if (!existsSync(file)) return empty;
  const raw = readFileSync(file, 'utf-8');
  const clean = (v: string | undefined): string => {
    const s = (v ?? '').trim();
    return !s || s.includes('example.com') || s.includes('<') ? '' : s;
  };
  const origins = clean(raw.match(/"ALLOWED_ORIGINS"\s*:\s*"([^"]*)"/)?.[1])
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hostname = raw.match(/"custom_domains"\s*:\s*\[[^\]]*"hostname"\s*:\s*"([^"]+)"/)?.[1];
  // 控制台绑的自定义域名不会写进 wrangler.jsonc，退而用 deploy:cms 记下的上次地址
  const saved = readSavedApiBase();
  return {
    siteUrl: clean(raw.match(/"SITE_URL"\s*:\s*"([^"]*)"/)?.[1]) || origins[1] || '',
    cmsUrl: origins[0] || '',
    apiUrl: hostname ? `https://${hostname}` : clean(saved),
    origins,
  };
}

/* --------------------------- 配置与密钥 --------------------------- */

function writeWranglerConfig(a: Answers, ids: ResourceIds): void {
  const publicBucketName = (a.publicBucket ?? '').trim() || R2_PUBLIC_DEFAULT;
  const example = readFileSync(resolve(API_DIR, 'wrangler.jsonc.example'), 'utf-8');
  /** JSON.stringify(undefined) 返回 undefined 本身，拼进模板就成了配置里的裸字面量 undefined，
      整份文件不再是合法 JSONC，之后 wrangler 在这个目录里连 whoami 都跑不动 */
  const jstr = (v: string | undefined): string => JSON.stringify(v ?? '');
  const vars = [`"SITE_URL": ${jstr(a.siteUrl)}`, `"SITE_NAME": ${jstr(a.siteName)}`];
  if (a.useGithub) {
    if (!a.githubOwner?.trim() || !a.githubRepo?.trim()) {
      die('勾了「文章提交回 Git」但没拿到 GitHub 用户名 / 仓库名，配置不能这么留空。重跑向导并把这两问填上');
    }
    vars.push(`"GITHUB_OWNER": ${jstr(a.githubOwner)}`);
    vars.push(`"GITHUB_REPO": ${jstr(a.githubRepo)}`);
    vars.push(`"GITHUB_BRANCH": ${jstr(a.githubBranch ?? 'main')}`);
  }

  /** String.replace 不匹配时原样返回，等于什么都没写却不报错：
      占位符或示例默认值一旦被改动，这里会静默产出一份缺 ID / 缺白名单的配置，
      部署照样"成功"，跑起来才表现为 worker 起不来或后台 Failed to fetch。 */
  const sub = (text: string, from: string, to: string): string => {
    if (!text.includes(from)) die(`wrangler.jsonc.example 里找不到「${from}」，示例文件与向导对不上了，请把这两处一起改`);
    return text.replace(from, to);
  };

  let cfg = example;
  cfg = sub(cfg, '<从 wrangler d1 create 获取>', ids.dbId);
  cfg = sub(cfg, '<CACHE KV ID>', ids.cacheId);
  cfg = sub(cfg, '<SESSION KV ID>', ids.sessionId);
  /** 公开桶作为第二个绑定加进去：media 那边按 binding 名找桶（services/media.ts 的 r2Bucket），
      绑定名固定 R2_PUBLIC，后台「媒体库 → 存储桶」那条配置也按这个名字认它 */
  cfg = sub(
    cfg,
    '"bucket_name": "zero-media"',
    `"bucket_name": "zero-media"\n    },\n    {\n      "binding": "${R2_PUBLIC_BINDING}",\n      "bucket_name": ${JSON.stringify(publicBucketName)}`,
  );
  cfg = sub(cfg, '"SITE_NAME": "Zero Site"', vars.join(',\n    '));
  cfg = sub(
    cfg,
    '"ALLOWED_ORIGINS": "https://zero-cms.pages.dev,https://zero-site.pages.dev"',
    `"ALLOWED_ORIGINS": ${JSON.stringify([a.cmsUrl, a.siteUrl].join(','))}`,
  );

  if (/"<[^>]+>"/.test(cfg)) die('wrangler.jsonc.example 中仍有未替换的占位符，请核对占位符文本');
  const badKey = cfg.match(/"([A-Z_]+)"\s*:\s*(undefined|NaN|null)\s*,?/);
  if (badKey) die(`生成的 wrangler.jsonc 里 ${badKey[1]} 的值是 ${badKey[2]}，这份配置 wrangler 读不了。请把这一行贴出来反馈`);
  writeFileSync(resolve(API_DIR, 'wrangler.jsonc'), cfg);
  good(`已生成 packages/api/wrangler.jsonc（worker：${WORKER_NAME}）`);
}

/** 密钥只通过 stdin 送入，不拼进命令行，避免留在 shell 历史或进程列表 */
function putSecret(name: string, value: string): boolean {
  try {
    wrangler(`secret put ${name}`, { cwd: API_DIR, input: value, capture: true });
    good(`密钥 ${name} 已写入`);
    return true;
  } catch (e) {
    /** 吞掉报错只会让人以为配好了：worker 不存在、token 权限不够都是这一步的常见死法 */
    const detail = e instanceof Error ? e.message.split('\n').slice(0, 4).join('\n') : String(e);
    warn(`${name} 自动写入失败：\n${detail}\n  手动补一次：cd packages/api && npx wrangler secret put ${name}`);
    return false;
  }
}

/**
 * 写密钥。必须在 wrangler deploy 之后：secret put 的对象是「已存在的 worker」，
 * 首次部署时它还不存在，每一条都会以 Worker not found 失败 —— 表现就是
 * 向导跑完说「密钥已写入」，而后台注册/登录全都 500。
 */
function configureSecrets(a: Answers): void {
  step('配置密钥');
  putSecret('AUTH_SECRET', randomBytes(32).toString('hex'));
  putSecret('SESSION_SECRET', randomBytes(32).toString('hex'));
  if (a.emailProvider === 'smtp' && a.smtpPassword) putSecret('SMTP_PASSWORD', a.smtpPassword);
  if (a.emailProvider === 'resend' && a.resendApiKey) putSecret('RESEND_API_KEY', a.resendApiKey);
  if (a.emailProvider === 'cloudflare') {
    if (a.cfAccountId) putSecret('CF_ACCOUNT_ID', a.cfAccountId);
    if (a.cfEmailToken) putSecret('CF_EMAIL_API_TOKEN', a.cfEmailToken);
  }
  if (a.useGithub) {
    if (a.githubToken) putSecret('GITHUB_TOKEN', a.githubToken);
    else warn('没填 GitHub Token：配置里有了仓库坐标，但后台写回仓库会一直报缺凭据。补一次：cd packages/api && npx wrangler secret put GITHUB_TOKEN');
  }
  info('AUTH_SECRET / SESSION_SECRET 为本次随机生成；重复运行 setup 会重置它们并使已登录会话失效。');
}

/* --------------------------- 构建与部署 --------------------------- */

function deployWorker(): string | null {
  step(`部署 ${WORKER_NAME}`);
  const out = wrangler('deploy', { cwd: API_DIR, capture: true });
  console.log(out);
  return out.match(/https:\/\/[a-z0-9.-]*workers\.dev/i)?.[0] ?? null;
}

function deployCms(apiBase: string | null): string | null {
  step('构建评论组件包（主题引用产物）');
  run('npm run build', { cwd: COMMENT_DIR });
  step(apiBase ? `构建 ${PAGES_PROJECT}（内置 API 地址 ${apiBase}）` : `构建 ${PAGES_PROJECT}`);
  run('npm run build', { cwd: CMS_DIR, env: { VITE_API_BASE: apiBase ?? '' } });
  if (apiBase) saveApiBase(apiBase);
  step(`准备 Pages 项目 ${PAGES_PROJECT}`);
  good(ensurePagesProject(PAGES_PROJECT) ? `Pages 项目 ${PAGES_PROJECT} 已创建（生产分支 main）` : `Pages 项目 ${PAGES_PROJECT} 已存在，沿用`);
  step(`部署 ${PAGES_PROJECT} 到 Cloudflare Pages`);
  const out = wrangler(`pages deploy .svelte-kit/cloudflare --project-name=${PAGES_PROJECT}`, { cwd: CMS_DIR, capture: true });
  console.log(out);
  return out.match(/https:\/\/[a-z0-9.-]*pages\.dev/i)?.[0] ?? null;
}

/* --------------------------- 交互 --------------------------- */

/** 模块加载时读一次：这时 wrangler.jsonc 还没被本次运行改写，拿到的就是上一版的地址 */
const prev = readExistingUrls();

/**
 * 条件追问的判定。
 *
 * prompts 给 type 回调的第一个参数是「上一题的答案值」，不是已答集合：
 * 写成 (p) => p.useGithub 时 p 是布尔 true，true.useGithub 永远 undefined，
 * 于是所有追问一次都不会问 —— 选了 SMTP 不问端口账号，勾了回 Git 不问仓库，
 * 答案缺失又被 JSON.stringify 拼成字面量 undefined 写进 wrangler.jsonc，
 * 之后每条 wrangler 命令都读不懂那份配置（表现为「明明登录了却说没登录」）。
 * 已答集合是第二个参数，判定一律走它。
 */
type Condition = (all: Partial<Answers>) => boolean;
type PromptKind = Extract<PromptObject['type'], string>;

/**
 * 提问文案只留短标签，解释文字单独打一行。
 *
 * prompts 每敲一个字符就把当前这一问整行重画一次，而 PowerShell 的 conhost
 * 擦不掉换行后的残留：文案和输入值加起来一旦超过终端宽度，屏幕上就会出现一串
 * 重复行（长提示语 + 40 位 GitHub Token 就是这么刷屏的）。
 * type 回调在每一问渲染前恰好执行一次（返回值会被缓存回 question.type），
 * 借它把说明先打出来最合适。
 */
function hint(text: string): void {
  console.log(`  \x1b[2m${text}\x1b[0m`);
}

const when =
  (cond: Condition, kind: PromptKind, note?: string) =>
  (_prev: unknown, all: Partial<Answers>): PromptKind | null => {
    if (!cond(all)) return null;
    if (note) hint(note);
    return kind;
  };
const always =
  (kind: PromptKind, note?: string) =>
  (): PromptKind => {
    if (note) hint(note);
    return kind;
  };

const isSmtp = (a: Partial<Answers>): boolean => a.emailProvider === 'smtp';
const isResend = (a: Partial<Answers>): boolean => a.emailProvider === 'resend';
const isCloudflareMail = (a: Partial<Answers>): boolean => a.emailProvider === 'cloudflare';
const usesGithub = (a: Partial<Answers>): boolean => a.useGithub === true;

const QUESTIONS: PromptObject[] = [
  { type: always('text'), name: 'siteName', message: '站点名称', initial: 'My Zero Site' },
  {
    type: always('text', 'Hugo 站点地址，带 https://。它与后台地址一起构成 CORS 白名单，白名单是精确匹配'),
    name: 'siteUrl',
    message: '前台地址',
    initial: () => prev.siteUrl || 'https://example.com',
  },
  {
    type: always('text', 'zero-cms 后台地址：绑了自定义域名就填它，否则填 Pages 给的 *.pages.dev'),
    name: 'cmsUrl',
    message: '后台地址',
    initial: () => prev.cmsUrl || `https://${PAGES_PROJECT}.pages.dev`,
  },
  {
    type: always('text', '给 Worker 绑的自定义域名；留空就用刚部署出的 *.workers.dev（该域名在你所在网络可能不通）'),
    name: 'apiUrl',
    message: 'API 地址',
    initial: () => prev.apiUrl,
  },
  {
    type: always('text', '上传用的公开桶：私有桶 zero-media 只有 Worker 读得到，公开桶绑上域名后图片是直链，\n      不占 Worker 请求数，RSS 与外链也能直接取。已存在就跳过，桶里的文件一个不动'),
    name: 'publicBucket',
    message: '公开桶名',
    initial: () => R2_PUBLIC_DEFAULT,
  },
  {
    type: always('text', '指向公开桶的完整域名。DNS 托管在当前 Cloudflare 账户时，下一问填 Zone ID 就自动绑好；\n      不在同一账户就留空 Zone ID，向导结束时按这里给的地址自己去控制台绑并验证'),
    name: 'publicDomain',
    message: '公开桶域名',
    initial: (_prev: unknown, all: Partial<Answers>) => {
      const apex = apexOf(all.siteUrl ?? '');
      return apex ? `${R2_PUBLIC_DEFAULT}.${apex}` : '';
    },
  },
  {
    type: always('text', 'Cloudflare 控制台「该域名的 Zone 主页」右侧的 Zone ID；域名不在当前账户时留空'),
    name: 'publicZoneId',
    message: 'Zone ID',
    initial: '',
  },
  {
    type: always('select', '这一步只把凭据写进 wrangler secret，之后随时能在后台「设置 → 发信方式」改'),
    name: 'emailProvider',
    message: '邮件通道',
    choices: [
      { title: 'SMTP（通用，所有邮箱服务商）', value: 'smtp' },
      { title: 'Resend', value: 'resend' },
      { title: 'Cloudflare Email Sending API', value: 'cloudflare' },
      { title: '暂不配置，之后在后台填写', value: 'none' },
    ],
    initial: 0,
  },
  { type: when(isSmtp, 'text', '例如 smtp.qq.com'), name: 'smtpHost', message: 'SMTP 服务器' },
  { type: when(isSmtp, 'text'), name: 'smtpPort', message: 'SMTP 端口', initial: '465' },
  { type: when(isSmtp, 'text', '完整邮箱地址'), name: 'smtpUser', message: 'SMTP 用户名' },
  {
    type: when(isSmtp, 'password', 'QQ / 163 邮箱要填「授权码」而不是登录密码；只写入 secret'),
    name: 'smtpPassword',
    message: 'SMTP 密码/授权码',
  },
  { type: when(isResend, 'password', '只写入 secret'), name: 'resendApiKey', message: 'Resend API Key' },
  {
    type: when(isCloudflareMail, 'text', '回车用上面 whoami 认出来的账户'),
    name: 'cfAccountId',
    message: 'Cloudflare 账户 ID',
    initial: () => loginAccountId ?? '',
  },
  { type: when(isCloudflareMail, 'password', '只写入 secret'), name: 'cfEmailToken', message: 'Email 发送 Token' },
  {
    type: always('confirm', '后台发布与编辑文章都要写回这个仓库；关掉的话只有数据库那条路'),
    name: 'useGithub',
    message: '启用文章提交回 Git？',
    initial: false,
  },
  { type: when(usesGithub, 'text'), name: 'githubOwner', message: 'GitHub 用户名' },
  { type: when(usesGithub, 'text', '放 Hugo 内容与主题的那个仓库，只写仓库名'), name: 'githubRepo', message: '内容仓库名', initial: 'zero-site' },
  { type: when(usesGithub, 'text'), name: 'githubBranch', message: '内容仓库分支', initial: 'main' },
  {
    type: when(usesGithub, 'password', '需要 contents:write 权限；只写入 secret，不进配置文件也不进命令行'),
    name: 'githubToken',
    message: 'GitHub Token',
  },
];

assertShortMessages(QUESTIONS);

async function summary(a: Answers, apiUrl: string | null, pagesUrl: string | null, apiUrlNote: string, seeded: string[], pub: PublicBucketPlan): Promise<void> {
  console.log('\n\x1b[32m✅ 部署完成\x1b[0m\n');
  /** 站主填的自定义域名要探一次才算数：控制台没绑、DNS 没生效时浏览器是 530，
      而按输出直接打印出来看着就像已经可用了（后台与前台都会连不上，很难往这上面想）。 */
  let apiNote = apiUrl ? apiUrlNote : '';
  if (apiUrl) {
    const p = await probeUrl(`${apiUrl.replace(/\/+$/, '')}/api/config`);
    apiNote = p.ok
      ? `${apiUrlNote}，已探通（${p.detail}）`
      : `${apiUrlNote}，但还没探通（${p.detail}）：到控制台 Workers & Pages → ${WORKER_NAME} → 域名 里确认它真绑上了`;
  }
  const prod = await pickProdUrl({ domain: a.cmsUrl ?? '', pages: pagesUrl ?? '', project: PAGES_PROJECT });
  if (a.cmsUrl) saveCmsUrl(a.cmsUrl);
  console.log(`  API  ：${apiUrl ?? '见上方 wrangler deploy 输出'}${apiNote}`);
  console.log(`  后台 ：${prod.url || '（没拿到）'}`);
  console.log(`        ${prod.note}`);
  console.log('\n后续步骤：');
  console.log(`  1. 打开后台：库里还没有账号时，登录页会自己变成「建为站长并登录」表单，填邮箱 + 两遍密码即可（第一个账号自动是 admin，跳过邮箱验证）${apiUrl ? '（API 地址已内置在产物里）' : '（先在登录页填 API 地址）'}`);
  const missing = stillMissing(a);
  console.log('  2. 站点与发信配置：向导问过的那些已经写进数据库，打开后台「设置」核对就行（要改也在那里改）');
  if (seeded.length) console.log(`     已写好：${seeded.join('、')}`);
  if (a.emailProvider === 'smtp') console.log(`     （SMTP：${a.smtpHost ?? '待填'}:${a.smtpPort ?? '待填'}，账号 ${a.smtpUser ?? '待填'}；发件人默认取这个账号，密码已存为 secret）`);
  console.log(missing.length ? `     还需要你补：${missing.join('；')}` : '     没有需要额外补的项');
  console.log(`  3. pnpm create:site 生成私密内容仓库，然后在「设置 → 内容仓库」填 owner / repo / token`);
  console.log(`  4. 主题侧 hugo.toml 设置 params.apiBaseURL = ${apiUrl ?? 'https://<worker>.workers.dev'}（前台与后台都走这一个地址，CORS 已放行 ${a.siteUrl}）`);
  console.log('  5. 迁移旧评论：pnpm migrate:waline（详见 docs/DEPLOYMENT.md）');
  console.log('  6. 图片两个桶都已建好并登记进后台「媒体库」，上传时在桶下拉里任选：');
  console.log(`     · 私有 ${R2_NAME}：走 Worker 读取，不对外直链（原图与要紧的图放这里）`);
  console.log(
    `     · 公开 ${a.publicBucket || R2_PUBLIC_DEFAULT}：${
      pub.baseUrl ? `${pub.baseUrl} 直链，不占 Worker 请求数（不重要的图放这里）` : '还没有可用的直链域名，图片先走 Worker 读取；到控制台 R2 → 该桶 → 自定义域名 绑好后，在后台该桶填「直链前缀」即成直链'
    }`,
  );
}

/** 少写协议头的地址只会让浏览器报 Failed to fetch，而那时候人只会去查后端 */
function assertHttpUrl(label: string, url: string): void {
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(url)) {
    die(`${label}不像完整 URL：${url}\n要形如 https://blog.example.com（协议 + 域名都写全）`);
  }
}

async function main(): Promise<void> {
  const noDeploy = process.argv.includes('--no-deploy');
  console.log('\n🚀 Zero Stack 部署向导\n');

  step('检查 Cloudflare 登录状态');
  ensureLogin();

  const existing = readExistingIds();
  const reuse = existing ? await confirm('检测到 packages/api/wrangler.jsonc，复用其中的资源 ID？') : false;

  const a = await ask(QUESTIONS);
  if (!a.siteName || !a.siteUrl || !a.cmsUrl) die('站点名称与两个地址均为必填项');
  assertHttpUrl('站点前台地址', a.siteUrl);
  assertHttpUrl('后台地址', a.cmsUrl);
  const apiUrl = (a.apiUrl ?? '').trim().replace(/\/+$/, '');
  if (apiUrl) assertHttpUrl('API 地址', apiUrl);
  for (const [name, value] of [['站点前台地址', a.siteUrl], ['后台地址', a.cmsUrl], ['API 地址', apiUrl]] as const) {
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value)) die(`${name} 还是本地地址：线上 CORS 按精确字符串匹配，浏览器一访问就会被拒`);
  }
  const dropped = prev.origins.filter((o) => o && o !== a.cmsUrl && o !== a.siteUrl);
  if (dropped.length) {
    warn(`wrangler.jsonc 里原有这些来源不在本次两答里，会被覆盖掉：${dropped.join(' / ')}`);
    info('CORS 是精确匹配，少一个就等于那个站点全挂；要保留就把它填进上面两问之一。');
  }

  if (!(await confirm(`即将在 Cloudflare 上创建/复用资源并${noDeploy ? '写入配置' : '部署 worker 与页面'}，继续？`))) {
    die('已取消，未做任何改动');
  }

  step('准备 Cloudflare 资源');
  const ids = existing && reuse ? existing : createResources();
  /** 公开桶是「增量」：老的 zero-media 与里面已有文件一律不动，只补一个桶并按需要绑域名 */
  const pub = preparePublicBucket(a);

  writeWranglerConfig(a, ids);

  if (noDeploy) {
    info('没写密钥：wrangler secret put 的对象是已存在的 worker，这一步留到真正部署时做。');
    console.log('\n✅ 资源与配置已就绪。之后运行 pnpm deploy:api 与 pnpm deploy:cms 完成部署。');
    return;
  }

  step('应用数据库迁移');
  wrangler(`d1 migrations apply ${D1_NAME} --remote`, { cwd: API_DIR });
  good('D1 表结构已同步');

  step('登记公开桶');
  seedPublicBucketConfig(pub);
  if (pub.hostname && !pub.bound) {
    warn(`最后一步还没完：把 ${pub.hostname} 绑到 ${pub.name} 并验证 DNS（控制台 R2 → ${pub.name} → 设置 → 自定义域名），\n      绑好后域名才真的能取图`);
  }

  step('写入站点与发信配置');
  const seeded = seedSiteConfig(a);
  if (seeded.length) good(`已写进 site_config，后台「设置」直接显示这些值：${seeded.join('、')}`);

  const workerUrl = deployWorker();
  /** 密钥必须排在 worker 部署之后：首次运行时 worker 还不存在，先写就全以 Worker not found 失败 */
  configureSecrets(a);
  if (apiUrl) {
    info(`你填的 API 地址是 ${apiUrl}：确认它已在 Cloudflare 控制台绑到 worker ${WORKER_NAME}（Workers & Pages → 该 worker → 域名），没绑的话后台与前台都会连不上。`);
  }
  /** 绑了自定义域名就用它编进后台产物：*.workers.dev 在很多网络根本连不通 */
  const finalApiUrl = apiUrl || workerUrl;
  const pagesUrl = deployCms(finalApiUrl);
  await summary(a, finalApiUrl, pagesUrl, apiUrl ? '（你填的自定义域名）' : '（取自 wrangler deploy 输出）', seeded, pub);
}

main().catch((e: unknown) => {
  die(e instanceof Error ? e.message : String(e));
});
