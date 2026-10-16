import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import prompts from 'prompts';
import {
  CMS_DIR,
  PAGES_PROJECT,
  die,
  ensurePagesProject,
  good,
  info,
  readSavedApiBase,
  run,
  saveApiBase,
  step,
  warn,
  wrangler,
} from './_util.js';

/**
 * 构建并部署 zero-cms 后台：pnpm deploy:cms [--no-build] [--project <名称>] [--api <worker 地址>]
 *   --no-build          复用已有的 .svelte-kit/cloudflare 产物（内置的 API 地址也就是上一次的）
 *   --project <名称>    自定义 Pages 项目名（默认 zero-cms）
 *   --api <地址>        要内置进产物的 API 地址；不填就问一次，答案记在 packages/cms/.zero-api-base
 */
const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const project = args.includes('--project') ? args[args.indexOf('--project') + 1] : PAGES_PROJECT;
if (!project || project.startsWith('--')) die('--project 后面需要跟 Pages 项目名');

const output = resolve(CMS_DIR, '.svelte-kit/cloudflare');

function normalize(u: string): string {
  return u.trim().replace(/\/+$/, '');
}

/** 校验的是「像不像一个能用的地址」——少了协议的半成品只会让后台报 Failed to fetch，更难查 */
function assertHttpUrl(u: string): void {
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(u)) {
    die(`API 地址看着不像完整 URL：${u}\n要形如 https://zero-api.你的账户子域名.workers.dev（协议 + 域名都要写全）`);
  }
}

async function resolveApiBase(): Promise<string> {
  const saved = readSavedApiBase();
  if (args.includes('--api')) {
    const fromArgs = normalize(args[args.indexOf('--api') + 1] ?? '');
    if (!fromArgs || fromArgs.startsWith('--')) die('--api 后面需要跟 worker 地址');
    assertHttpUrl(fromArgs);
    return fromArgs;
  }
  const fromEnv = normalize(process.env.VITE_API_BASE ?? '');
  if (fromEnv) {
    assertHttpUrl(fromEnv);
    return fromEnv;
  }
  // CI 里没有终端可问：沿用上次记下的地址，没记过就保持不内置
  if (!process.stdin.isTTY) return saved;
  /** 说明单独打一行：prompts 每敲一个字符就重画当前行，长文案在 PowerShell 里
      会换行且擦不干净，屏幕上留下一串重复行 */
  console.log(`  \x1b[2mworker 域名，回车留空 = 部署后在登录页手填；${saved ? '上次：' + saved : '例如 https://zero-api.xxx.workers.dev'}\x1b[0m`);
  const res = await prompts({
    type: 'text',
    name: 'api',
    message: 'API 地址',
    initial: saved,
  });
  const value = normalize(String(res.api ?? ''));
  if (!value) return '';
  assertHttpUrl(value);
  return value;
}

async function main(): Promise<void> {
  const apiBase = await resolveApiBase();
  if (!apiBase) warn('未内置 API 地址：后台打开后要在登录页手填 worker 域名，否则接口全部 404');

  if (!noBuild) {
    step(apiBase ? `构建 zero-cms（内置 API 地址 ${apiBase}）` : '构建 zero-cms');
    run('npm run build', { cwd: CMS_DIR, env: { VITE_API_BASE: apiBase } });
    if (apiBase) saveApiBase(apiBase);
  } else if (!existsSync(output)) {
    die('.svelte-kit/cloudflare 不存在，请先完整构建一次（去掉 --no-build）');
  }

  step(`准备 Pages 项目 ${project}`);
  good(ensurePagesProject(project) ? `Pages 项目 ${project} 已创建（生产分支 main）` : `Pages 项目 ${project} 已存在，沿用`);

  step(`部署 ${project} 到 Cloudflare Pages`);
  const out = wrangler(`pages deploy .svelte-kit/cloudflare --project-name=${project}`, { cwd: CMS_DIR, capture: true });
  console.log(out);

  const url = out.match(/https:\/\/[a-z0-9.-]*pages\.dev/i)?.[0];
  good(`后台已部署${url ? '：' + url : ''}`);
  info(`访问请用生产地址${url ? '（预览地址每次部署都变，别拿它当白名单）' : ''}。`);
  info(
    apiBase
      ? `已内置 API 地址 ${apiBase}，打开就能登录；登录页手填的地址优先于内置值。`
      : '首次使用：在登录页「API 地址」填 worker 域名（本机只需填一次）。',
  );
  info('库里还没有账号时，登录页会自己变成「建为站长并登录」表单（等价于 POST /api/auth/register）。');
  info('两边不同源，必须把这个后台地址写进 packages/api/wrangler.jsonc 的 ALLOWED_ORIGINS 并 pnpm deploy:api，否则浏览器报 Failed to fetch。');
}

void main();
