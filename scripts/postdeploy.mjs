#!/usr/bin/env node
/**
 * 部署后只读核验：确认「线上跑的是这版、关键闸门都还在」。
 *
 * 用法：
 *   API=https://<worker 域名> CMS=https://<后台域名> SITE=https://<站点域名> pnpm postdeploy
 *
 * 只发 GET，不写任何数据（不发评论、不提交友链申请）。任何一项不符就退出码 1。
 * 这不是 smoke.sh 的替代：smoke 验接口面，这里验「部署这件事」——
 * 健康检查、迁移、绑定、后台守卫、批量上限、CSP 份数、静态站点是否在线。
 */
const API = (process.env.API ?? '').replace(/\/+$/, '');
const CMS = (process.env.CMS ?? '').replace(/\/+$/, '');
const SITE = (process.env.SITE ?? '').replace(/\/+$/, '');
const EXPECT_ENV = process.env.EXPECT_ENV ?? 'production';

if (!API) {
  console.error('缺少 API=https://<worker 域名>（可再加 CMS=… SITE=…）');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const failed = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
  } else {
    fail++;
    failed.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
const get = async (url, headers = {}) => {
  const res = await fetch(url, { headers: { 'user-agent': 'zero-postdeploy/1.0', ...headers } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 也算拿到响应体 */
  }
  return { res, text, json };
};
const hasSql = (s) => /Failed query|Prepare statement|no such column|SQLITE_/i.test(s);

console.log(`\n== 1. 健康检查与迁移（${API}） ==`);
try {
  const { res, json } = await get(`${API}/api/health`);
  check('GET /api/health 200', res.status === 200, `实际 ${res.status}`);
  check('整体 ok=true', json?.ok === true, JSON.stringify((json?.broken ?? []).slice(0, 5)));
  check(`environment=${EXPECT_ENV}`, json?.environment === EXPECT_ENV, String(json?.environment));
  check('D1 表结构不是旧版（迁移跑完）', json?.checks?.d1?.ok === true, json?.checks?.d1?.detail ?? '');
  if (json?.checks?.mediaBuckets) {
    check('媒体库绑定的 R2 桶都在', json.checks.mediaBuckets.ok === true, json.checks.mediaBuckets.detail ?? '');
  }
} catch (e) {
  check('GET /api/health', false, String(e));
}

console.log('\n== 2. 后台守卫 ==');
try {
  const { res } = await get(`${API}/api/admin/config`);
  check('未登录访问后台接口必须 401', res.status === 401, `实际 ${res.status}`);
} catch (e) {
  check('GET /api/admin/config', false, String(e));
}

console.log('\n== 3. 批量口上限（修过 100 条 500 的回归点） ==');
const mkSlugs = (n) => Array.from({ length: n }, (_, i) => `postdeploy-probe-${i}`).join(',');
try {
  const { res, text } = await get(`${API}/api/comments/count?slugs=${encodeURIComponent(mkSlugs(300))}`);
  check('comments/count 300 条 → 200', res.status === 200, `实际 ${res.status}`);
  check('回包不含 SQL 文本', !hasSql(text));
} catch (e) {
  check('comments/count', false, String(e));
}
try {
  const want = 150;
  const { res, text } = await get(`${API}/api/reactions?slugs=${encodeURIComponent(mkSlugs(want))}`);
  const n = Object.keys(JSON.parse(text)?.data ?? {}).length;
  check(`reactions ${want} 条 → 200`, res.status === 200, `实际 ${res.status}`);
  check(`回包条目数 = ${want}（不是空过）`, n === want, `实际 ${n}`);
} catch (e) {
  check('reactions', false, String(e));
}

console.log('\n== 4. 公开配置与友链输出 ==');
try {
  const { res, json } = await get(`${API}/api/config`);
  check('GET /api/config 200', res.status === 200, `实际 ${res.status}`);
  check('响应带 Cache-Control: no-store（开关不延迟）', /no-store/.test(res.headers.get('cache-control') ?? ''), res.headers.get('cache-control') ?? '');
  check('没有把密钥类字段带出来', !/smtpPassword|resendApiKey|githubToken/i.test(JSON.stringify(json ?? {})));
} catch (e) {
  check('GET /api/config', false, String(e));
}
try {
  const { res, json } = await get(`${API}/api/friends`);
  const list = JSON.stringify(json ?? {});
  check('GET /api/friends 200', res.status === 200, `实际 ${res.status}`);
  check('友链里没有 javascript:/data: 链接', !/"url"\s*:\s*"(javascript|data):/i.test(list));
} catch (e) {
  check('GET /api/friends', false, String(e));
}

if (CMS) {
  console.log(`\n== 5. 后台页面与 CSP（${CMS}） ==`);
  try {
    const { res, text } = await get(`${CMS}/`);
    check('后台首页 200', res.status === 200, `实际 ${res.status}`);
    check('返回的是 SvelteKit 产物', /_app\/immutable\//.test(text));
    const csp = res.headers.get('content-security-policy') ?? '';
    check('只有一份 CSP（不是两份叠加）', (csp.match(/default-src/g) ?? []).length === 1, `${(csp.match(/default-src/g) ?? []).length} 份`);
    check('CSP 放行本站内联样式（后台依赖）', /style-src[^;]*unsafe-inline/.test(csp));
  } catch (e) {
    check('GET CMS /', false, String(e));
  }
}

if (SITE) {
  console.log(`\n== 6. 静态站点在线（${SITE}） ==`);
  try {
    const { res, text } = await get(`${SITE}/`);
    check('站点首页 200', res.status === 200, `实际 ${res.status}`);
    check('首页有 <title>', /<title[\s>]/i.test(text));
    const cc = res.headers.get('cache-control') ?? '';
    check('HTML 不做长缓存（改完立刻可见）', !/max-age=(\d{4,})/.test(cc), cc || '(空)');
  } catch (e) {
    check('GET SITE /', false, String(e));
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} 项通过，${fail} 项失败`);
if (fail) {
  console.log('失败项：');
  for (const f of failed) console.log('  - ' + f);
  process.exit(1);
}
