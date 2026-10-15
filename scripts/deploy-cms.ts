import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CMS_DIR, PAGES_PROJECT, die, ensurePagesProject, good, info, run, step, wrangler } from './_util.js';

/**
 * 构建并部署 zero-cms 后台：pnpm deploy:cms [--no-build] [--project <名称>]
 *   --no-build          复用已有的 .svelte-kit/cloudflare 产物
 *   --project <名称>    自定义 Pages 项目名（默认 zero-cms）
 */
const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const project = args.includes('--project') ? args[args.indexOf('--project') + 1] : PAGES_PROJECT;
if (!project || project.startsWith('--')) die('--project 后面需要跟 Pages 项目名');

const output = resolve(CMS_DIR, '.svelte-kit/cloudflare');

if (!noBuild) {
  step('构建 zero-cms');
  run('npm run build', { cwd: CMS_DIR });
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
info('首次使用：打开后台注册第一个账号（自动成为管理员），并在登录页填写 API 地址。');
info('想让后台与 API 同源，可在 Pages 上配置前缀或直接把 API 地址填进登录页（保存在浏览器本地）。');
