import { D1_NAME, API_DIR, WORKER_NAME, die, good, requireWranglerConfig, step, wrangler, info } from './_util.js';

/**
 * 部署 zero-api：pnpm deploy:api [--no-migrate] [--local] [--dry-run]
 *   --no-migrate  跳过 D1 迁移（只改代码时更快）
 *   --local       迁移打到本地 D1，不部署
 *   --dry-run     只做打包校验，不上传
 */
const args = process.argv.slice(2);
const noMigrate = args.includes('--no-migrate');
const localOnly = args.includes('--local');
const dryRun = args.includes('--dry-run');

if (localOnly && dryRun) die('--local 与 --dry-run 不能同时使用');
if (!dryRun) requireWranglerConfig();

if (!noMigrate && !dryRun) {
  step(`同步 D1 迁移（${localOnly ? 'local' : 'remote'}）`);
  wrangler(`d1 migrations apply ${D1_NAME} ${localOnly ? '--local' : '--remote'}`, { cwd: API_DIR });
  good('迁移已应用');
}

if (localOnly) {
  console.log('\n✅ 本地数据库就绪。启动开发服务：pnpm dev:api');
  process.exit(0);
}

step(dryRun ? `校验 ${WORKER_NAME} 打包` : `部署 ${WORKER_NAME}`);
const out = wrangler(dryRun ? 'deploy --dry-run' : 'deploy', { cwd: API_DIR, capture: true });
console.log(out);
if (dryRun) {
  good('打包校验通过（未上传）');
} else {
  const url = out.match(/https:\/\/[a-z0-9.-]*workers\.dev/i)?.[0];
  good(`已部署${url ? '：' + url : ''}`);
  info('跨域白名单来自 wrangler.jsonc 的 ALLOWED_ORIGINS，改完需要重新部署。');
}
