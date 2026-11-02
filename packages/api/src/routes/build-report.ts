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

/**
 * 「最近一次回报尝试」—— 成功和失败都记。
 *
 * 为什么：后台只显示「最近一次构建成功（N 天前）」时，站长分不清是「CI 根本没在回报」
 * 还是「回报被拒了」。把最后一次尝试（含 401/400/503 的原因）也存下来，
 * 界面就能直说：从没收到过请求 / 收到了但令牌不对 / 收到了但格式不对。
 */
const BUILD_REPORT_ATTEMPT_KEY = 'zero:build-report:attempt';
/** 同一 isolate 里失败尝试最多一分钟记一次，别让刷接口的人把 KV 写爆 */
const ATTEMPT_THROTTLE_MS = 60_000;
let lastAttemptWriteAt = 0;

export interface BuildReportAttempt {
  at: number;
  ok: boolean;
  code: number;
  reason: string;
  ip: string;
  ua: string;
}

async function noteAttempt(
  env: Env,
  c: { req: { header: (k: string) => string | undefined } },
  ip: string,
  ok: boolean,
  code: number,
  reason: string,
): Promise<void> {
  const now = Date.now();
  if (!ok && now - lastAttemptWriteAt < ATTEMPT_THROTTLE_MS) return;
  lastAttemptWriteAt = now;
  const record: BuildReportAttempt = {
    at: Math.floor(now / 1000),
    ok,
    code,
    reason: reason.slice(0, 120),
    ip,
    ua: String(c.req.header('user-agent') ?? '').slice(0, 120),
  };
  await kvPut(env, BUILD_REPORT_ATTEMPT_KEY, record, BUILD_REPORT_TTL);
}

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
  const ip = clientIp(c);
  const secret = ((c.env as unknown as { BUILD_REPORT_TOKEN?: string }).BUILD_REPORT_TOKEN ?? '').trim();
  if (!secret) {
    await noteAttempt(c.env, c, ip, false, 503, 'Worker 没配 BUILD_REPORT_TOKEN');
    /* 503 = 「这项没开通」，不是「服务器坏了」：内容仓 CI 每次构建都调这里，没配 Secret 时
       这一步要能被认出来是「跳过」，而不是一个看着像站点坏掉的 500。 */
    fail(503, '本站没开构建结果回报：给 Worker 加一条 Secret `BUILD_REPORT_TOKEN`（随机长字符串），再在内容仓的 GitHub Secrets 里放同名的一份（生成的 deploy.yml 读的就是它）。没开之前构建结果无处可报，后台也就不会显示站点是否停在旧版 —— 不影响部署本身。');
  }
  if (!safeEqual(secret, c.req.header('x-build-report-token') ?? '')) {
    await noteAttempt(c.env, c, ip, false, 401, '令牌与 Worker 里的不一致');
    fail(401, '构建回报令牌不对');
  }
  const body = (await c.req.json().catch(() => null)) as Partial<BuildReport> | null;
  const status = body?.status === 'success' ? 'success' : body?.status === 'failure' ? 'failure' : '';
  if (!status) {
    await noteAttempt(c.env, c, ip, false, 400, 'status 只能是 success 或 failure');
    fail(400, 'status 只能是 success 或 failure');
  }
  const record: BuildReport = {
    status,
    sha: String(body?.sha ?? '').slice(0, 40),
    branch: String(body?.branch ?? '').slice(0, 60),
    // 只留一小截：整页构建日志既超 KV 值大小，也没人会读
    error: String(body?.error ?? '').slice(0, 4000),
    at: Math.floor(Date.now() / 1000),
  };
  await kvPut(c.env, BUILD_REPORT_KEY, record, BUILD_REPORT_TTL);
  await noteAttempt(c.env, c, ip, true, 200, '');
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
  const attempt = (await kvGet(c.env, BUILD_REPORT_ATTEMPT_KEY)) as BuildReportAttempt | null;
  /* 每次构建都会报一次，缓存住就等于让站长看不到最新结果 */
  c.header('Cache-Control', 'no-store');
  return ok({
    last,
    attempt,
    notice: last
      ? null
      : attempt
        ? null
        : '还从没收到过构建回报请求（连失败的都没有）：到内容仓的 Actions 里看 Deploy 有没有在跑，以及 scripts/build-report.sh 用的 API 地址指向哪里。',
  });
});

export default app;
