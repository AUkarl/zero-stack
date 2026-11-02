/**
 * 友链数据文件的「段内重排」纯函数 —— 后台「保存顺序」唯一依赖它才会真的体现在站点上。
 * 这块以前没测，所以排序写进 D1 却没写进文件这种事跑了一年也没人发现。
 * 运行：pnpm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLinksYaml, sortFriendBlocks } from '../src/services/links-yaml';

const A = 'https://a.example.com/';
const B = 'https://b.example.com/';

const FILE = [
  '# 友链页的数据文件：主题的 layouts/links/list.html 读两段',
  'friends:',
  `  - name: "甲"`,
  `    url: "${A}"`,
  '    desc: "第一个"',
  '    icon: ""',
  '    email: ""',
  '    rss: ""',
  '  - name: "乙"',
  `    url: "${B}"`,
  '    desc: "第二个"',
  '    icon: ""',
  '    email: ""',
  '    rss: ""',
  'alliance:',
  '',
].join('\n');

test('友链重排：给出反序就真的换过来，且条目内容一个字节不少', () => {
  const out = sortFriendBlocks(FILE, new Map([[A, 1], [B, 0]]));
  assert.ok(out.moved > 0, '要说明确实搬动过');
  const urls = parseLinksYaml(out.text).map((s) => s.url);
  assert.deepEqual(urls, [B, A]);
  assert.equal(out.text.split('\n').length, FILE.split('\n').length, '只能换位置，不能吞行');
  assert.ok(out.text.includes('# 友链页的数据文件'), '文件头注释要留在原位');
  assert.ok(out.text.includes('desc: "第二个"'), '条目自己的字段不能丢');
});

test('友链重排：顺序与现状相同就报告「没搬动」（少一次没意义的提交与重建）', () => {
  const out = sortFriendBlocks(FILE, new Map([[A, 0], [B, 1]]));
  assert.equal(out.moved, 0);
  assert.equal(out.text, FILE);
});

test('友链重排：没给顺序的条目排到最后，不会凭空消失', () => {
  const out = sortFriendBlocks(FILE, new Map([[A, 5]]));
  assert.deepEqual(parseLinksYaml(out.text).map((s) => s.url), [A, B]);
});

test('友链重排：只给两条里的两条以外 id 时，文件原样不动', () => {
  const out = sortFriendBlocks(FILE, new Map([['https://别的站.example/', 0]]));
  assert.equal(out.moved, 0);
  assert.deepEqual(parseLinksYaml(out.text).map((s) => s.url), [A, B]);
});

test('友链重排：CRLF 的文件重排之后还是 CRLF（少一个字节就是一条无谓的 Git 改动）', () => {
  const crlf = FILE.replace(/\n/g, '\r\n');
  const out = sortFriendBlocks(crlf, new Map([[A, 1], [B, 0]]));
  assert.ok(out.text.includes('\r\n'), '换行风格要保持');
  assert.ok(!/[^\r]\n/.test(out.text), '不能混进只带 LF 的行');
  assert.deepEqual(parseLinksYaml(out.text).map((s) => s.url), [B, A]);
});

test('友链重排：条目之间夹着的注释跟着那一块走，不会被甩到段尾', () => {
  const withComment = FILE.replace(`  - name: "乙"`, `  # 这条是后加的几个\n  - name: "乙"`);
  const out = sortFriendBlocks(withComment, new Map([[A, 1], [B, 0]]));
  const lines = out.text.split('\n');
  const idx = lines.findIndex((l) => l.includes('这条是后加的'));
  const order乙 = lines.findIndex((l) => l.includes(`url: "${B}"`));
  assert.ok(idx < order乙 && idx > lines.findIndex((l) => l === 'friends:'), `注释要跟在自己的条目前面（在第 ${idx} 行）`);
});
