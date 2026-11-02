import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  API_DIR,
  BUILD_REPORT_TOKEN_FILE,
  die,
  ensureBuildReportToken,
  good,
  info,
  setGithubActionsBuildSecrets,
  step,
  wrangler,
} from './_util.js';

/**
 * 给已经部署过的站补写/轮换「构建结果回报」：
 *
 *   pnpm provision:build-report -- --owner AUkarl --repo mywebsite [--api-url https://...] [--dry-run]
 *
 * 令牌从 .build-report-token 读取（没有就生成），用户不需要知道值；
 * 同时写入 Worker Secret 与内容仓 Actions Secrets，两边保持同一串。
 * 需要 GITHUB_TOKEN（classic PAT 的 repo 权限，或 fine-grained 的 Secrets 读写），
 * 并在带线上 packages/api/wrangler.jsonc 的部署副本里执行。
 */
function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length).trim();
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith('--')) return process.argv[idx + 1]!.trim();
  return undefined;
}

/** 只读本地 .dev.vars 的 GITHUB_TOKEN，其次用本机 gh 已登录的令牌；绝不打印值 */
function localGithubToken(): string {
  const fromEnv = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '').trim();
  if (fromEnv) return fromEnv;
  const file = resolve(API_DIR, '.dev.vars');
  if (existsSync(file)) {
    const line = readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .find((l) => /^GITHUB_TOKEN=/.test(l));
    if (line) return line.slice('GITHUB_TOKEN='.length).trim();
  }
  /* 不要求用户把令牌贴出来：本机 gh 登录过就直接用它的令牌 */
  const gh = process.env.GH_BIN ?? (process.platform === 'win32' ? 'gh.exe' : 'gh');
  const r = spawnSync(gh, ['auth', 'token'], { encoding: 'utf-8', windowsHide: true });
  return r.status === 0 ? String(r.stdout ?? '').trim() : '';
}

const owner = arg('owner') ?? (process.env.GITHUB_OWNER ?? '').trim();
const repo = arg('repo') ?? (process.env.GITHUB_REPO ?? '').trim();
/* 不默认读 .zero-api-base：那是站点自己的自定义域，可能被 Cloudflare 挑战；
   不传 --api-url 就只更新令牌，保留现有的 CI 回报地址。 */
const apiUrl = (arg('api-url') ?? '').trim().replace(/\/+$/, '');
const dryRun = process.argv.includes('--dry-run');

if (!owner || !repo) {
  die(
    '缺 owner / repo。\n' +
      '  例：pnpm provision:build-report -- --owner AUkarl --repo mywebsite\n' +
      '  也可以设环境变量 GITHUB_OWNER / GITHUB_REPO。',
  );
}
if (apiUrl && !/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(apiUrl)) {
  die(`接口地址不像完整 URL：${apiUrl}\n要形如 https://zero-website-api.example.com`);
}

const githubToken = localGithubToken();
const tokenFile = process.env.BUILD_REPORT_TOKEN_FILE || BUILD_REPORT_TOKEN_FILE;

if (dryRun) {
  info(`不会写任何东西：将使用 ${existsSync(tokenFile) ? `已有的 ${tokenFile}` : `新生成 ${tokenFile}`}`);
  info(`Worker：packages/api（当前 wrangler.jsonc）写入 BUILD_REPORT_TOKEN`);
  info(`内容仓：${owner}/${repo} 写入 BUILD_REPORT_TOKEN${apiUrl ? ` 与 API_BASE_URL（${apiUrl}）` : '（不传 --api-url 时不改 API_BASE_URL，保留现有 CI 回报地址）'}`);
  info(githubToken ? 'GITHUB_TOKEN 已找到（值不显示）' : '还没找到 GITHUB_TOKEN；真正执行时需要它来写内容仓 Actions Secrets');
  process.exit(0);
}

if (!githubToken) {
  die(
    '缺 GITHUB_TOKEN：这个令牌要能写内容仓的 Actions Secrets。\n' +
      '  classic PAT 勾 repo，或 fine-grained 给 Secrets 读写；然后：\n' +
      '  GITHUB_TOKEN="<令牌>" pnpm provision:build-report -- --owner ... --repo ...',
  );
}

const reportToken = ensureBuildReportToken(tokenFile);
step('写入 Worker Secret');
wrangler('secret put BUILD_REPORT_TOKEN', { cwd: API_DIR, input: reportToken, capture: true });
good('Worker BUILD_REPORT_TOKEN 已写入');

step('写入内容仓 Actions Secrets');
const result = setGithubActionsBuildSecrets({
  owner,
  repo,
  githubToken,
  buildReportToken: reportToken,
  apiBaseUrl: apiUrl,
});
if (!result.ok) {
  die(
    `${result.detail}\n` +
      `  令牌已保存在本机 ${tokenFile}（已 gitignore），修好权限后从文件补写：\n` +
      `  gh secret set BUILD_REPORT_TOKEN --repo ${owner}/${repo} < "${tokenFile}"` +
      (apiUrl ? `\n  gh secret set API_BASE_URL --repo ${owner}/${repo} --body ${apiUrl}` : ''),
  );
}
good(`内容仓 Actions Secrets 已写入：${result.written.join('、')}`);
info('两边现在同一串；下一轮推送或手动重跑 Deploy 后，后台「站点构建」会更新。');
