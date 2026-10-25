/**
 * build-report.ts —— 内容仓构建结果回报：CI → Worker → 后台。
 *
 * 补的是上一轮的半个洞：构建体检（services/repo.ts 的 runLocalBuildCheck）只有本地后端能跑，
 * workerd 里起不了 hugo 子进程。所以线上「Pages 构建挂了、站点从这一版起不再更新」在后台是
 * 完全看不见的 —— 每笔保存都回「已保存」，站主往往过很久才发现前台是旧的。
 * 构建成败只有跑构建那一侧知道，就让它自己报上来。
 *
 * 为什么这个文件挂在 `/api/build-report` 而不是 `/api/admin/build-report`：
 * `index.ts` 对 `/api/admin/*` 有一道统一的登录闸（CI 没有会话 Cookie），
 * 挂在下面时令牌逻辑根本轮不到执行 —— 实测会直接 401「请先登录」。
 * 因此写口放在闸外、只认 `x-build-report-token`；读口仍然要求管理员会话。
 */
import { Hono } from 'hono';
import { requireAdmin } from '../middleware/auth';
import { kvGet, kvPut } from '../services/kv-cache';
import { clientIp } from '../lib/http';
import { writeAudit } from '../services/audit';
import { fail, ok } from '../lib/errors';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

/** 与其它 CACHE 键同前缀（`zero:admin:posts`、`zero:subscribe-push:last`）；审计的 target 也用它 */
const BUILD_REPORT_KEY = 'zero:build-report';
/** 留 30 天：最后一次构建结果要能撑到站长想起来看它；成功一次就会被覆盖 */
const BUILD_REPORT_TTL = 60 * 60 * 24 * 30;

export interface BuildReport {
  status: 'success' | 'failure';
  sha: string;
  branch: string;
  error: string;
  at: number;
}

/** 定长比较，别让令牌变成逐字符计时侧信道 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** POST /api/build-report —— 内容仓的 CI 在构建成功/失败后各调一次（见 create-site 生成的 deploy.yml） */
app.post('/', async (c) => {
  const secret = ((c.env as unknown as { BUILD_REPORT_TOKEN?: string }).BUILD_REPORT_TOKEN ?? '').trim();
  if (!secret) {
    fail(500, '本站没开构建结果回报：给 Worker 加一条 Secret `BUILD_REPORT_TOKEN`（随机长字符串），再在内容仓的 GitHub Secrets 里放同名的一份（生成的 deploy.yml 读的就是它）。没开之前构建结果无处可报，后台也就不会显示站点是否停在旧版 —— 不影响部署本身。');
  }
  if (!safeEqual(secret, c.req.header('x-build-report-token') ?? '')) fail(401, '构建回报令牌不对');
  const body = (await c.req.json().catch(() => null)) as Partial<BuildReport> | null;
  const status = body?.status === 'success' ? 'success' : body?.status === 'failure' ? 'failure' : '';
  if (!status) fail(400, 'status 只能是 success 或 failure');
  const record: BuildReport = {
    status,
    sha: String(body?.sha ?? '').slice(0, 40),
    branch: String(body?.branch ?? '').slice(0, 60),
    // 只留一小截：整页构建日志既超 KV 值大小，也没人会读
    error: String(body?.error ?? '').slice(0, 4000),
    at: Math.floor(Date.now() / 1000),
  };
  await kvPut(c.env, BUILD_REPORT_KEY, record, BUILD_REPORT_TTL);
  await writeAudit(c.env, {
    action: 'config',
    target: BUILD_REPORT_KEY,
    detail: { event: 'build-report', status, sha: record.sha, branch: record.branch, hasError: Boolean(record.error), via: 'ci' },
    ip: clientIp(c),
  });
  return ok({ stored: true, status, sha: record.sha });
});

/** GET /api/build-report —— 后台读最近一次构建结果（要登录） */
app.get('/', async (c) => {
  requireAdmin(c);
  const last = (await kvGet(c.env, BUILD_REPORT_KEY)) as BuildReport | null;
  return ok({
    last,
    notice: last
      ? null
      : '内容仓的构建结果还没回报过：给 Worker 与仓库各加一份 Secret `BUILD_REPORT_TOKEN`，站点停在旧版这件事就会在这里显示出来。',
  });
});

export default app;
