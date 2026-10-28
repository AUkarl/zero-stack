/**
 * R76 这批入参闸门的纯函数判据（配置闸门 + 批量口径 + 友链协议）。
 *
 * 为什么这些要写成单测而不是只靠台架：它们全是「静默失效」那一类 —— 少拦一条不会报错，
 * 只会让后台显示「已保存」而参数其实没生效。单测能在改表的那一次提交就指出漏了哪一档。
 * fixture 用的是真实形状（现网 / 模板里的值），不是凭空写的漂亮值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_CONFIG_KEYS,
  JSON_CONFIG_KEYS,
  STATIC_DEFAULTS,
  enumKeyBadValue,
  jsonKeyBadValue,
  lengthKeyBadValue,
  numericKeyBadValue,
  textKeyMaxLen,
} from '../src/services/config';
import { DEFAULT_TEMPLATES } from '../src/services/email-defaults';
import { chunk, mapChunks, parseKeys, IN_BATCH, MAX_BATCH_KEYS } from '../src/lib/batch';
import { socialRowsSchema } from '../src/services/authors';
import { friendCreateSchema } from '../src/services/friends-groups';

/* ---------------- 1. JSON 形状闸门 ---------------- */

test('commentProviders：真服务商 + 参数对象通过（含空串=不改）', () => {
  assert.equal(jsonKeyBadValue('commentProviders', '{"waline":{"serverURL":"https://x.leancloud.cn"},"giscus":{"repo":"a/b"}}'), null);
  assert.equal(jsonKeyBadValue('commentProviders', ''), null);
  assert.equal(jsonKeyBadValue('commentProviders', '   '), null);
});

test('commentProviders：坏 JSON / 数组 / 不认识的键都点名拒', () => {
  assert.match(jsonKeyBadValue('commentProviders', '{"waline":'), /解析不出来/);
  assert.match(jsonKeyBadValue('commentProviders', '["waline"]'), /不能是数组/);
  assert.match(jsonKeyBadValue('commentProviders', '{"waline":{"serverURL":"https://x"},"disqus":{}}'), /disqus/);
});

test('commentProviders：值不是参数对象时也拒（主题侧 `|| {}` 会静默吞掉它）', () => {
  assert.match(jsonKeyBadValue('commentProviders', '{"waline":1}'), /要写成参数对象/);
  assert.match(jsonKeyBadValue('commentProviders', '{"waline":null}'), /要写成参数对象/);
  assert.match(jsonKeyBadValue('commentProviders', '{"waline":{"meta":{"a":1}}}'), /meta/);
});

test('字符串数组那几键：必须是「非空字符串」数组', () => {
  for (const key of ['spamKeywords', 'friendApplyBlocklist', 'commentEmojiPacks']) {
    assert.equal(JSON_CONFIG_KEYS[key], 'stringArray', `${key} 的档位`);
    assert.equal(jsonKeyBadValue(key, '["博彩","广告"]'), null);
    assert.equal(jsonKeyBadValue(key, ''), null);
    assert.match(jsonKeyBadValue(key, '{"a":1}'), /不是数组/);
    assert.match(jsonKeyBadValue(key, '["", 1]'), /非空字符串/);
  }
});

test('mediaBuckets：对象数组，掺进字符串就拒', () => {
  assert.equal(jsonKeyBadValue('mediaBuckets', '[{"id":"r2","label":"默认 R2","kind":"r2","binding":"R2"}]'), null);
  assert.match(jsonKeyBadValue('mediaBuckets', '["r2"]'), /每一项都要是一个对象/);
});

/* ---------------- 2. 长度闸门 ---------------- */

test('长度上限按用途分档，且现实里最长的默认值离上限还很远', () => {
  assert.equal(textKeyMaxLen('emailTemplateNotice'), 20000);
  assert.equal(textKeyMaxLen('spamKeywords'), 8000);
  assert.equal(textKeyMaxLen('smtpPassword'), 4096);
  assert.equal(textKeyMaxLen('siteName'), 120);
  assert.equal(textKeyMaxLen('siteUrl'), 500);
  assert.equal(textKeyMaxLen('siteDescription'), 2000, '认不出用途的文本键走兜底那一档');
  for (const v of Object.values(DEFAULT_TEMPLATES)) {
    assert.ok(v.length < textKeyMaxLen('emailTemplateCode'), `默认邮件模板 ${v.length} 字应远小于上限`);
  }
});

test('超长点名是哪一项、现在多长、上限多少；边界值以内放行', () => {
  const siteName = '知'.repeat(5000);
  assert.match(String(lengthKeyBadValue('siteName', siteName)), /siteName 太长了（现在 5000 个字符，最多 120）/);
  assert.equal(lengthKeyBadValue('siteName', '一个人的小站'), null);
  assert.equal(lengthKeyBadValue('siteName', 'x'.repeat(120)), null);
  assert.equal(lengthKeyBadValue('siteName', 'x'.repeat(121)), 'siteName 太长了（现在 121 个字符，最多 120）：这一项会被直接写进页面或邮件，超限时整批都不保存');
});

test('每一条配置键的默认值都不会被自己的闸门挡住（改表时必须仍绿）', () => {
  for (const key of ALL_CONFIG_KEYS) {
    const value = String((STATIC_DEFAULTS as Record<string, string>)[key] ?? '');
    assert.equal(lengthKeyBadValue(key, value), null, `${key} 的默认值被长度闸门挡了`);
    assert.equal(jsonKeyBadValue(key, value), null, `${key} 的默认值被 JSON 闸门挡了`);
    assert.equal(enumKeyBadValue(key, value), null, `${key} 的默认值被枚举闸门挡了`);
    assert.equal(numericKeyBadValue(key, value), false, `${key} 的默认值被数字闸门挡了`);
  }
});

/* ---------------- 3. 批量口的分批与截断 ---------------- */

test('parseKeys：去空、按上限截断（送 900 个只留前 500）', () => {
  assert.deepEqual(parseKeys(' /a/ , /b/ ,, /c/ '), ['/a/', '/b/', '/c/']);
  assert.equal(parseKeys(undefined).length, 0);
  const many = Array.from({ length: 900 }, (_, i) => `/posts/${i}/`).join(',');
  const kept = parseKeys(many);
  assert.equal(kept.length, MAX_BATCH_KEYS);
  assert.equal(kept[0], '/posts/0/');
  assert.equal(kept[499], '/posts/499/');
});

test('chunk 的批长不超 D1 的绑参上限，且拼回去与原序一致', () => {
  const items = Array.from({ length: 237 }, (_, i) => i);
  const parts = chunk(items);
  assert.ok(parts.every((p) => p.length <= IN_BATCH), '每批都不超过 IN_BATCH');
  assert.equal(parts.length, Math.ceil(237 / IN_BATCH));
  assert.deepEqual(parts.flat(), items);
  assert.deepEqual(chunk([1, 2, 3], 5), [[1, 2, 3]]);
});

test('mapChunks 把各批结果并起来（批量口靠这一条不重不漏）', async () => {
  const keys = Array.from({ length: 121 }, (_, i) => `k${i}`);
  const seenBatches: number[] = [];
  const rows = await mapChunks(keys, async (part) => {
    seenBatches.push(part.length);
    return part.map((k) => ({ k, n: 1 }));
  });
  assert.deepEqual(seenBatches, [50, 50, 21]);
  assert.equal(rows.length, 121);
  assert.equal(rows[0]!.k, 'k0');
  assert.equal(rows[120]!.k, 'k120');
});

/* ---------------- 4. 友链地址只认 http(s) ---------------- */

const baseFriend = { name: '测试友链' };

test('友链 url：http/https 通过，其它协议当场拒（后台那格会原样写进 a 标签）', () => {
  const ok1 = friendCreateSchema.safeParse({ ...baseFriend, url: 'https://example.com' });
  assert.equal(ok1.success, true, JSON.stringify(ok1.error?.issues ?? {}));
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///C:/Windows/win.ini',
    'example.com',
    '//example.com',
  ]) {
    const r = friendCreateSchema.safeParse({ ...baseFriend, url: bad });
    assert.equal(r.success, false, `「${bad}」本该被拒`);
    assert.match(String(r.error?.issues?.[0]?.message), /http\(s\)/);
  }
});

test('友链的可选地址（头像 / RSS）留空仍算「不填」，但填了就得是同一条协议口径', () => {
  const r = friendCreateSchema.safeParse({ ...baseFriend, url: 'https://example.com', avatar: '', rssUrl: '' });
  assert.equal(r.success, true, JSON.stringify(r.error?.issues ?? {}));
  const bad = friendCreateSchema.safeParse({ ...baseFriend, url: 'https://example.com', rssUrl: 'ftp://example.com/feed' });
  assert.equal(bad.success, false, 'rssUrl 走的是同一条协议闸门');
});

/* ---------------- 5. 作者申请的社交方式：同平台只许一条 ---------------- */

test('社交方式按归一后的平台判重：微博 + weibo 算同一条，落盘时后写会顶掉前写', () => {
  const ok1 = socialRowsSchema.safeParse([{ platform: 'github', handle: 'ada' }, { platform: '微博', handle: 'ada_cn' }]);
  assert.equal(ok1.success, true, JSON.stringify(ok1.error?.issues ?? {}));
  const dup = socialRowsSchema.safeParse([{ platform: 'github', handle: 'ada' }, { platform: 'GitHub', handle: 'ada2' }]);
  assert.equal(dup.success, false, 'GitHub 与 github 是同一家');
  assert.match(String(dup.error?.issues?.[0]?.message), /同一个平台只能填一条/);
  assert.match(String(dup.error?.issues?.[0]?.message), /github \/ GitHub/);
});

test('认不出的平台不参与判重（它们本来就会被 normalizeSocial 丢掉，不该因此卡住提交）', () => {
  const r = socialRowsSchema.safeParse([{ platform: '', handle: 'x' }, { platform: '   ', handle: 'y' }]);
  assert.equal(r.success, true, JSON.stringify(r.error?.issues ?? {}));
});
