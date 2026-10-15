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
  WORKER_NAME,
  die,
  ensurePagesProject,
  extractId,
  good,
  info,
  parseJson,
  run,
  saveApiBase,
  step,
  warn,
  whoami,
  wrangler,
  wranglerTry,
} from './_util.js';

type EmailProvider = 'smtp' | 'resend' | 'cloudflare' | 'none';

interface Answers {
  siteName: string;
  siteUrl: string;
  cmsUrl: string;
  apiUrl?: string;
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
  let me = whoami();
  if (!me) {
    info('尚未登录（或 wrangler 的登录态读不出来），将打开浏览器完成授权');
    wrangler('login', { cwd: API_DIR });
    me = whoami();
    if (!me) die('登录未完成：wrangler whoami 仍读不到身份。也可以在环境变量里给 CLOUDFLARE_API_TOKEN 后重跑 pnpm setup');
  }
  loginAccountId = me.accountId;
  good(`已登录 Cloudflare：${me.label}${me.accountId ? `（账户 ${me.accountId}）` : ''}`);
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

/** 已配置过的仓库重复运行 setup 时，直接沿用旧 id，避免再次占用同名资源 */
function readExistingIds(): ResourceIds | null {
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
  return {
    siteUrl: clean(raw.match(/"SITE_URL"\s*:\s*"([^"]*)"/)?.[1]) || origins[1] || '',
    cmsUrl: origins[0] || '',
    apiUrl: hostname ? `https://${hostname}` : '',
    origins,
  };
}

/* --------------------------- 配置与密钥 --------------------------- */

function writeWranglerConfig(a: Answers, ids: ResourceIds): void {
  const example = readFileSync(resolve(API_DIR, 'wrangler.jsonc.example'), 'utf-8');
  const vars = [`"SITE_URL": ${JSON.stringify(a.siteUrl)}`, `"SITE_NAME": ${JSON.stringify(a.siteName)}`];
  if (a.useGithub) {
    vars.push(`"GITHUB_OWNER": ${JSON.stringify(a.githubOwner)}`);
    vars.push(`"GITHUB_REPO": ${JSON.stringify(a.githubRepo)}`);
    vars.push(`"GITHUB_BRANCH": ${JSON.stringify(a.githubBranch)}`);
  }

  const cfg = example
    .replace('<从 wrangler d1 create 获取>', ids.dbId)
    .replace('<CACHE KV ID>', ids.cacheId)
    .replace('<SESSION KV ID>', ids.sessionId)
    .replace('"SITE_NAME": "Zero Site"', vars.join(',\n    '))
    .replace(
      '"ALLOWED_ORIGINS": "https://zero-cms.pages.dev,https://zero-site.pages.dev"',
      `"ALLOWED_ORIGINS": ${JSON.stringify([a.cmsUrl, a.siteUrl].join(','))}`,
    );

  if (/"<[^>]+>"/.test(cfg)) die('wrangler.jsonc.example 中仍有未替换的占位符，请核对占位符文本');
  writeFileSync(resolve(API_DIR, 'wrangler.jsonc'), cfg);
  good(`已生成 packages/api/wrangler.jsonc（worker：${WORKER_NAME}）`);
}

/** 密钥只通过 stdin 送入，不拼进命令行，避免留在 shell 历史或进程列表 */
function putSecret(name: string, value: string): void {
  try {
    wrangler(`secret put ${name}`, { cwd: API_DIR, input: value, capture: true });
    good(`密钥 ${name} 已写入`);
  } catch {
    warn(`${name} 自动写入失败，请手动执行：cd packages/api && npx wrangler secret put ${name}`);
  }
}

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
  if (a.useGithub && a.githubToken) putSecret('GITHUB_TOKEN', a.githubToken);
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

const QUESTIONS: PromptObject[] = [
  { type: 'text', name: 'siteName', message: '站点名称', initial: 'My Zero Site' },
  {
    type: 'text',
    name: 'siteUrl',
    message: '站点前台地址（Hugo 站点，与后台地址一起构成 CORS 白名单）',
    initial: () => prev.siteUrl || 'https://example.com',
  },
  {
    type: 'text',
    name: 'cmsUrl',
    message: '后台地址（绑了自定义域名就填它，否则是 Pages 给的 *.pages.dev）',
    initial: () => prev.cmsUrl || `https://${PAGES_PROJECT}.pages.dev`,
  },
  {
    type: 'text',
    name: 'apiUrl',
    message: '后台与前台要访问的 API 地址（给 Worker 绑的自定义域名，例如 https://api.example.com；留空 = 用刚部署出的 *.workers.dev）',
    initial: () => prev.apiUrl,
  },
  {
    type: 'select',
    name: 'emailProvider',
    message: '邮件发送通道（之后可在后台改）',
    choices: [
      { title: 'SMTP（通用，支持所有邮箱服务商）', value: 'smtp' },
      { title: 'Resend', value: 'resend' },
      { title: 'Cloudflare Email Sending API', value: 'cloudflare' },
      { title: '暂不配置，之后在后台填写', value: 'none' },
    ],
    initial: 0,
  },
  { type: (p) => (p.emailProvider === 'smtp' ? 'text' : null), name: 'smtpHost', message: 'SMTP 服务器地址（如 smtp.qq.com）' },
  { type: (p) => (p.emailProvider === 'smtp' ? 'text' : null), name: 'smtpPort', message: 'SMTP 端口（465 或 587）', initial: '465' },
  { type: (p) => (p.emailProvider === 'smtp' ? 'text' : null), name: 'smtpUser', message: 'SMTP 用户名（邮箱地址）' },
  {
    type: (p) => (p.emailProvider === 'smtp' ? 'password' : null),
    name: 'smtpPassword',
    message: 'SMTP 密码 / 授权码（只写入 secret）',
  },
  {
    type: (p) => (p.emailProvider === 'resend' ? 'password' : null),
    name: 'resendApiKey',
    message: 'Resend API Key（只写入 secret）',
  },
  {
    type: (p) => (p.emailProvider === 'cloudflare' ? 'text' : null),
    name: 'cfAccountId',
    message: 'Cloudflare 账户 ID',
    /** whoami 认出来的账户直接当默认值，省得再去控制台抄一遍。
        QUESTIONS 是模块级常量，必须写成函数取用，否则拿到的是 import 时的 null */
    initial: () => loginAccountId ?? '',
  },
  {
    type: (p) => (p.emailProvider === 'cloudflare' ? 'password' : null),
    name: 'cfEmailToken',
    message: 'Email Sending API Token（只写入 secret）',
  },
  { type: 'confirm', name: 'useGithub', message: '启用「文章提交回 Git」（后台发布文章需要）', initial: false },
  { type: (p) => (p.useGithub ? 'text' : null), name: 'githubOwner', message: 'GitHub 用户名' },
  { type: (p) => (p.useGithub ? 'text' : null), name: 'githubRepo', message: '内容仓库名', initial: 'zero-site' },
  { type: (p) => (p.useGithub ? 'text' : null), name: 'githubBranch', message: '内容仓库分支', initial: 'main' },
  {
    type: (p) => (p.useGithub ? 'password' : null),
    name: 'githubToken',
    message: 'GitHub Token（contents:write，只写入 secret）',
  },
];

function summary(a: Answers, apiUrl: string | null, pagesUrl: string | null, apiUrlNote: string): void {
  console.log('\n\x1b[32m✅ 部署完成\x1b[0m\n');
  console.log(`  API  ：${apiUrl ?? '见上方 wrangler deploy 输出'}${apiUrl ? apiUrlNote : ''}`);
  console.log(`  后台 ：${pagesUrl ?? a.cmsUrl}`);
  console.log('\n后续步骤：');
  console.log(`  1. 打开后台：库里还没有账号时，登录页会自己变成「建为站长并登录」表单，填邮箱 + 两遍密码即可（第一个账号自动是 admin，跳过邮箱验证）${apiUrl ? '（API 地址已内置在产物里）' : '（先在登录页填 API 地址）'}`);
  console.log('  2. 后台「设置」补齐 siteUrl、emailFrom、smtpHost、smtpUser 等配置项');
  if (a.emailProvider === 'smtp') {
    console.log(`     （SMTP：${a.smtpHost ?? '待填'}:${a.smtpPort ?? '待填'}，账号 ${a.smtpUser ?? '待填'}；密码已存为 secret）`);
  }
  console.log(`  3. pnpm create:site 生成私密内容仓库，然后在「设置 → 内容仓库」填 owner / repo / token`);
  console.log(`  4. 主题侧 hugo.toml 设置 params.apiBaseURL = ${apiUrl ?? 'https://<worker>.workers.dev'}（前台与后台都走这一个地址，CORS 已放行 ${a.siteUrl}）`);
  console.log('  5. 迁移旧评论：pnpm migrate:waline（详见 docs/DEPLOYMENT.md）');
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
  const apiUrl = (a.apiUrl ?? '').trim().replace(/\/+$/, '');
  if (apiUrl && !/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(apiUrl)) {
    die(`API 地址不像完整 URL：${apiUrl}\n要形如 https://api.你的域名（协议 + 域名都写全），或直接留空用 *.workers.dev`);
  }
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

  writeWranglerConfig(a, ids);
  configureSecrets(a);

  if (noDeploy) {
    console.log('\n✅ 资源、配置与密钥已就绪。之后运行 pnpm deploy:api 与 pnpm deploy:cms 完成部署。');
    return;
  }

  step('应用数据库迁移');
  wrangler(`d1 migrations apply ${D1_NAME} --remote`, { cwd: API_DIR });
  good('D1 表结构已同步');

  const workerUrl = deployWorker();
  /** 绑了自定义域名就用它编进后台产物：*.workers.dev 在很多网络根本连不通 */
  const finalApiUrl = apiUrl || workerUrl;
  const pagesUrl = deployCms(finalApiUrl);
  summary(a, finalApiUrl, pagesUrl, apiUrl ? '（你填的自定义域名）' : '（取自 wrangler deploy 输出）');
}

main().catch((e: unknown) => {
  die(e instanceof Error ? e.message : String(e));
});
