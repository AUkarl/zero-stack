/**
 * csp-connect 的纯函数判据。
 *
 * 校准口径：中间件那份直接读仓库里的真模板（scripts/site-template/functions/_middleware.ts），
 * _headers 那份用一行真实生成过的 CSP（connect-src 里带接口域与同父域通配，另外掺一个
 * 人手补的域 —— 用来判住「自动摘除只摘我们自己写进去的，手补的一个不碰」）。
 * 这两份的形状不是我们凭空定的：static/_headers 由 create-site 的 siteCsp() 拼成一行，
 * functions/_middleware.ts 由 site-template 原样复制，connect-src 是运行时算出来的表达式。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applyConnectOriginsToHeaders,
  applyManagedOriginsToMiddleware,
  commentConnectOrigins,
  readManagedOrigins,
  wsTwin,
} from '../src/services/csp-connect';

const MW_TEMPLATE = readFileSync(
  fileURLToPath(new URL('../../../scripts/site-template/functions/_middleware.ts', import.meta.url)),
  'utf8',
);

/** 真实生成过的 _headers 里那一行（整条 CSP 就一行；掺一个人手补的 https://stats.example.net） */
const HEADERS_FIXTURE = [
  '/*',
  '  X-Content-Type-Options: nosniff',
  "  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self' https://zero-website-api.example.com https://*.example.com wss://*.example.com https://stats.example.net; media-src 'self' https:; object-src 'none'",
].join('\n');

test('两家都用 Zero 自带评论时不补任何域', () => {
  const r = commentConnectOrigins({ provider: 'zero', momentProvider: 'zero', providersJson: '{}' });
  assert.deepEqual(r.origins, []);
  assert.ok(r.notes.join(' ').includes('Zero'));
});

test('waline 的 serverURL 只取协议+域，路径与端口保留、后面那段路径丢掉', () => {
  const r = commentConnectOrigins({
    provider: 'waline',
    momentProvider: 'zero',
    providersJson: JSON.stringify({ waline: { serverURL: 'https://waline.example.com/ok/' } }),
  });
  assert.deepEqual(r.origins, ['https://waline.example.com']);
  assert.ok(r.notes.join(' ').includes('wss://waline.example.com'), '必须同时说明 wss 一起生效');
});

test('带端口与少写协议的服务地址也认', () => {
  assert.deepEqual(
    commentConnectOrigins({ provider: 'waline', momentProvider: 'zero', providersJson: '{"waline":{"serverURL":"my-waline.test:8360"}}' }).origins,
    ['https://my-waline.test:8360'],
  );
  assert.deepEqual(
    commentConnectOrigins({ provider: 'artalk', momentProvider: 'zero', providersJson: '{"artalk":{"server":"http://127.0.0.1:2070"}}' }).origins,
    ['http://127.0.0.1:2070'],
  );
});

test('文章区与时刻区用不同家时，两个域都补且重复只留一份', () => {
  const r = commentConnectOrigins({
    provider: 'waline',
    momentProvider: 'artalk',
    providersJson: '{"waline":{"serverURL":"https://w.example.com"},"artalk":{"server":"https://a.example.com"},"twikoo":{}}',
  });
  assert.deepEqual(r.origins, ['https://w.example.com', 'https://a.example.com']);
});

test('giscus 不需要补域（它在自己 iframe 里发请求）', () => {
  const r = commentConnectOrigins({ provider: 'giscus', momentProvider: 'giscus', providersJson: '{"giscus":{"repo":"a/b"}}' });
  assert.deepEqual(r.origins, []);
  assert.ok(r.notes.join(' ').includes('iframe'));
});

test('twikoo 只给 envId 时不猜腾讯云域名，而是说清楚该补哪个键', () => {
  const r = commentConnectOrigins({ provider: 'twikoo', momentProvider: 'zero', providersJson: '{"twikoo":{"envId":"abc123","region":"ap-shanghai"}}' });
  assert.deepEqual(r.origins, []);
  assert.ok(r.notes.join(' ').includes('serviceUrl'), '提示要给出可照抄的键名');
});

test('切到第三方却没写那一段参数时，报「认不出」而不是静默什么都不做', () => {
  const r = commentConnectOrigins({ provider: 'waline', momentProvider: 'zero', providersJson: '{"twikoo":{}}' });
  assert.deepEqual(r.origins, []);
  assert.ok(r.notes.join(' ').includes('serverURL'));
});

test('参数不是合法 JSON 时绝不动 CSP（宁可漏补，不可拿脏数据改安全头）', () => {
  const r = commentConnectOrigins({ provider: 'waline', momentProvider: 'zero', providersJson: '{"waline":' });
  assert.deepEqual(r.origins, []);
  assert.ok(r.notes.join(' ').includes('JSON'));
});

test('wsTwin：https→wss、http→ws，其他原样', () => {
  assert.equal(wsTwin('https://a.example.com'), 'wss://a.example.com');
  assert.equal(wsTwin('http://127.0.0.1:2070'), 'ws://127.0.0.1:2070');
  assert.equal(wsTwin('wss://already'), 'wss://already');
});

test('模板那份中间件认得 marker，写进去再读回来是同一份清单', () => {
  assert.equal(readManagedOrigins(MW_TEMPLATE)?.length, 0, '出厂清单必须是空的');
  const once = applyManagedOriginsToMiddleware(MW_TEMPLATE, ['https://w.example.com']);
  assert.equal(once.changed, true);
  assert.deepEqual(readManagedOrigins(once.text), ['https://w.example.com']);
  const twice = applyManagedOriginsToMiddleware(once.text, ['https://w.example.com']);
  assert.equal(twice.changed, false, '同一份清单不该再改一次（否则每次保存都插一条空提交）');
  assert.ok(once.text.includes("COMMENT_CONNECT.map((o) => ` ${o} ${wsTwin(o)}`)"), 'connect-src 必须真的把这份清单接进去');
});

test('老站那份没有 marker 的中间件：补出 marker 段并接上 connect-src', () => {
  const old = MW_TEMPLATE.replace(/\/\/ zero-cms:csp-connect:begin[\s\S]*?\/\/ zero-cms:csp-connect:end/, 'const COMMENT_CONNECT_LEGACY_REMOVED = 0;')
    .replace(/\$\{COMMENT_CONNECT\.map\(\(o\) => ` \$\{o\} \$\{wsTwin\(o\)\}`\)\.join\(''\)\}/, '')
    .replace(/function wsTwin[\s\S]*?\n}\n/, '');
  assert.equal(readManagedOrigins(old), null, '先确认这份真的没有 marker');
  const r = applyManagedOriginsToMiddleware(old, ['https://a.example.com']);
  assert.equal(r.changed, true);
  assert.equal(r.inserted, true);
  assert.deepEqual(readManagedOrigins(r.text), ['https://a.example.com']);
  assert.ok(/function wsTwin/.test(r.text), '老文件里没有 wsTwin，得一起补上');
  /* 补出来的那一行必须与模板里手写的那行逐字相同 —— 台架第一次跑就是这条抓出真 bug：
     插错一个字符就变成「两个模板字符串挨在一起」，整份 _middleware.ts 语法错。 */
  const lineOf = (t: string) => t.split('\n').find((l) => l.includes('`connect-src'))?.trim();
  assert.equal(lineOf(r.text), lineOf(MW_TEMPLATE), 'connect-src 那一行要和模板逐字一致');
});

test('CSP 被手改过形状时就地停手，不猜着改', () => {
  const handEdited = MW_TEMPLATE.replace(`connect-src 'self'\${API_ORIGIN ? \` \${API_ORIGIN}\${API_SIBLINGS}\` : ' https:'}\${COMMENT_CONNECT.map((o) => \` \${o} \${wsTwin(o)}\`).join('')}`, "connect-src 'self' https://别的写法");
  const noMarker = handEdited.replace(/\/\/ zero-cms:csp-connect:begin[\s\S]*?\/\/ zero-cms:csp-connect:end/, '');
  const r = applyManagedOriginsToMiddleware(noMarker, ['https://a.example.com']);
  assert.equal(r.changed, false);
  assert.ok(r.reason, '必须说明为什么没改');
});

test('_headers：补进去的域带 wss，摘的时候只摘我们自己补的那两个', () => {
  const added = applyConnectOriginsToHeaders(HEADERS_FIXTURE, ['https://w.example.com'], []);
  assert.equal(added.changed, true);
  assert.ok(added.text.includes("connect-src 'self' https://zero-website-api.example.com https://*.example.com wss://*.example.com https://stats.example.net https://w.example.com wss://w.example.com"));
  const removed = applyConnectOriginsToHeaders(added.text, [], ['https://w.example.com']);
  assert.equal(removed.changed, true);
  assert.equal(removed.text, HEADERS_FIXTURE, '摘干净之后必须逐字回到改之前');
  const same = applyConnectOriginsToHeaders(HEADERS_FIXTURE, ['https://w.example.com'], []);
  const again = applyConnectOriginsToHeaders(same.text, ['https://w.example.com'], []);
  assert.equal(again.changed, false, '重复补同一个域不该再改文件');
});

test('_headers 里没有那一行时说明原因，不静默', () => {
  const r = applyConnectOriginsToHeaders('/*\n  X-Content-Type-Options: nosniff\n', ['https://a'], []);
  assert.equal(r.changed, false);
  assert.ok(r.reason);
});
