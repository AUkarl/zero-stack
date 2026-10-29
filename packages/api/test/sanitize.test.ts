/**
 * 用户填的文本进库前的清洗，与「配置项必须是一行」那道闸。
 *
 * 台架 2026-10-29 第三轮的实测口径：评论昵称填「昵称\r\nX-Mailer: hacked」原样入库并原样回显，
 * 还会被拼进 `【站点名】X 回复了你的评论` 那一句主题。SMTP 那一档有 RFC2047 编码兜着（抓到真报文），
 * 但 `emailProvider=cloudflare` 是 `join('\r\n')` 手拼 multipart 的 —— 与其记住哪一档通道安全，
 * 不如在入口一次洗干净，并在发信前再断言一次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoHeaderBreaks, cleanInline, cleanMultiline } from '../src/lib/sanitize';
import { ALL_CONFIG_KEYS, JSON_CONFIG_KEYS, lineShapeBadValue } from '../src/services/config';
import { appendFriends, validateLinksYaml } from '../src/services/links-yaml';

/* ---------------- ① 清洗 ---------------- */

test('单行字段：换行、控制字符、零宽都拿掉，长度按上限截', () => {
  assert.equal(cleanInline('张三\r\nX-Mailer: hacked', 64), '张三 X-Mailer: hacked');
  assert.equal(cleanInline('a\u0000b\u001bc'), 'abc');
  assert.equal(cleanInline('\u200b\u202a昵称\ufeff'), '昵称');
  assert.equal(cleanInline('   两头空白   '), '两头空白');
  assert.equal(cleanInline('x'.repeat(200), 64).length, 64);
});

test('多行字段：留换行、统一成 LF，段尾空格去掉，其余控制字符拿掉', () => {
  assert.equal(cleanMultiline('第一段  \r\n第二段\r第三段'), '第一段\n第二段\n第三段');
  assert.equal(cleanMultiline('a\u0007b'), 'ab');
  assert.equal(cleanMultiline('x'.repeat(9000), 5000).length, 5000);
});

test('清洗不吃正常中文与标点（不许把正当内容洗成乱码）', () => {
  const s = '《zero》主题 v1.2 —— 支持 emoji 😀、代码 `pnpm dev`、全角标点：，。！？';
  assert.equal(cleanInline(s, 200), s);
  assert.equal(cleanMultiline(s), s);
});

test('发信前断言：主题或收件人带换行就不发', () => {
  assert.equal(assertNoHeaderBreaks('主题', '【站点】新评论'), null);
  assert.ok(assertNoHeaderBreaks('主题', '【站点】\r\nX-Mailer: hacked'));
  assert.ok(assertNoHeaderBreaks('收件人', 'a@x.com\nb@y.com'));
});

/* ---------------- ② 友链表：写盘那一处也不会漏 ---------------- */

test('links.yaml：名称与说明里的换行不会折成跨行标量', () => {
  const entry = { url: 'https://a.example.com', avatar: '', rssUrl: '', kind: 'friend' as const };
  const { text, added } = appendFriends('friends: []\n', [{ ...entry, name: '甲站\r\n注入行', description: '说明\t带制表' }]);
  assert.deepEqual(added, ['https://a.example.com']);
  /* 与「事先就写干净」的那一份逐字节相同：换行既没有多出一行 YAML，也没有留在值里 */
  const clean = appendFriends('friends: []\n', [{ ...entry, name: '甲站 注入行', description: '说明 带制表' }]).text;
  assert.equal(text, clean);
  assert.ok(text.includes('name: "甲站 注入行"'), text);
  assert.equal(validateLinksYaml(text), null, text);
});

/* ---------------- ③ 配置：除邮件模板与 JSON 名单，每一项都必须是一行 ---------------- */

test('配置：siteName / siteUrl 带换行被拒（会多插一行 hugo.toml）', () => {
  assert.ok(lineShapeBadValue('siteName', '我的站\n[params]\nbad = 1'));
  assert.ok(lineShapeBadValue('siteUrl', 'https://x.com\nbaseURL = "https://evil"'));
  assert.ok(lineShapeBadValue('emailFrom', 'a@x.com\r\nb@y.com'));
  assert.ok(lineShapeBadValue('smtpUser', 'user\x00name'));
  assert.equal(lineShapeBadValue('siteName', '我的站'), null);
});

test('配置：只有邮件模板与 JSON 名单允许多行', () => {
  for (const key of ALL_CONFIG_KEYS) {
    const multiline = lineShapeBadValue(key, '第一行\n第二行');
    const allowed = key.startsWith('emailTemplate') || Boolean(JSON_CONFIG_KEYS[key]);
    assert.equal(multiline === null, allowed, `${key}：允许多行=${allowed}，实际${multiline === null ? '放行' : '拦截'}`);
  }
});
