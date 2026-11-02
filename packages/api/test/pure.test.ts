/**
 * 这几条测的都是「写坏一个字符就会让整站构建失败 / 前台少一块」的纯函数。
 * 运行：pnpm test（CI 里也跑）。判据一律用真实 hugo 0.165 的行为校准过：
 * tab 缩进、重复键、流式括号没闭合这三种，go-yaml 直接判整份 data 文件加载失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAuthorsYaml, serializeAuthorsYaml, validateAuthorsYaml } from '../src/services/authors';
import { postWebPath } from '../src/services/frontmatter';

test('作者表：正常条目通过', () => {
  const text = 'a:\n  name: "A"\n  email: "a@x.com"\nb:\n  name: "B"\n  email: "b@x.com"\n';
  assert.equal(validateAuthorsYaml(text), null);
  assert.deepEqual(Object.keys(parseAuthorsYaml(text)), ['a', 'b']);
});

test('作者表：tab 缩进被拒（go-yaml 会整站失败）', () => {
  const msg = validateAuthorsYaml('a:\n\tname: "A"\n');
  assert.ok(msg && msg.includes('tab'), String(msg));
});

test('作者表：块标量的内容里可以有 tab（空格缩进之后）', () => {
  assert.equal(validateAuthorsYaml('a:\n  bio: |\n  \t这里有 tab 内容\n'), null);
});

test('作者表：重复键被拒，但两位作者各自的 social 不算重复', () => {
  assert.ok(validateAuthorsYaml('a:\n  name: "A"\na:\n  name: "B"\n'));
  assert.equal(validateAuthorsYaml('a:\n  social:\n    github: "x"\nb:\n  social:\n    github: "y"\n'), null);
  assert.ok(validateAuthorsYaml('a:\n  social:\n    github: "x"\n    github: "y"\n'));
});

test('作者表：流式括号没闭合被拒，行内花括号文本不受影响', () => {
  assert.ok(validateAuthorsYaml('a: {\n  name: "A"\n'));
  assert.equal(validateAuthorsYaml('a:\n  bio: "他说 {随便}"\n'), null);
});

test('作者表：parse → serialize 对普通文件是恒等的', () => {
  const text = 'a:\n  name: "A"\n  email: "a@x.com"\n';
  assert.equal(serializeAuthorsYaml(parseAuthorsYaml(text)), text);
});

test('文章站内地址：扁平文件与页面包', () => {
  assert.equal(postWebPath('content/zh/posts/hello-world.md'), '/posts/hello-world/');
  assert.equal(postWebPath('content/zh/posts/faq/index.md'), '/posts/faq/');
});
