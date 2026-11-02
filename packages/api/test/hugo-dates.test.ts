/**
 * 日期别名表（fuzzed 写法）与上传件结构判据 —— 都是「少拦一条就打死整站构建 / 图库里留一张永久破图」的那一类。
 *
 * 为什么写成单测而不只靠台架：这 27 个写法在台架上要跑 27 次真 hugo 构建（十几分钟），
 * 而单测 1 秒就把「大小写归一」这条不变量钉住。台架那轮负责另一件事：证明这张表跟**真 Hugo 的行为**对齐。
 * 真正的判据只有一份（services/hugo-guard.ts 的 DATE_KEYS + checkHugoDateValue），
 * 这里断言的是两道闸（路由口 checkHugoDates、仓库口 checkRepoWrite）用的是同一份、同一比法。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHugoDateValue, checkHugoDates, checkRepoWrite, checkUploadBytes } from '../src/services/hugo-guard';

/** 台架 b3b 那轮逐个问过的 27 个写法，值一律填 `2026-13-45`（任何历法都不存在） */
const WRITE_SHAPES = [
  'date', 'Date', 'DATE',
  'lastmod', 'Lastmod', 'moddate', 'modified', 'modifiedDate', 'revised', 'updated', 'updateDate',
  'publishDate', 'publishdate', 'PUBLISHDATE',
  'expiryDate', 'expireDate', 'expirydate', 'expiredate', 'expiry_date',
  'startDate', 'startdate', 'start', 'end', 'endDate',
  'unscheduledDate', 'dateString', 'postedOn',
];

/**
 * Hugo 0.165 **实测会去解析**的那些写法（台架 2026-10-29 第三轮：这个集合里的键配坏值，
 * hugo --minify 一律退出码 1，报 `the "…" front matter field is not a parsable date`）。
 * 后端只要漏掉这里面任何一个，就是「站主从后台保存一次，整站构建停摆」。
 */
const HUGO_READS = [
  'date', 'Date', 'DATE',
  'lastmod', 'Lastmod', 'modified',
  'publishDate', 'publishdate', 'PUBLISHDATE',
  'expiryDate', 'expireDate', 'expirydate', 'expiredate',
];

/** 这张表按小写比对，所以下面这些别名同样要拦（Hugo 不读它们，但值本来就该是时间，拦住比放过去安全） */
const EXTRA_GUARD_KEYS = ['updated', 'startDate', 'startdate', 'expiredate'];

const BAD_VALUES = ['2026-13-45', '2026-10-25 12:00', '2026-10-25T12:00', '2026-02-30', '2026/10/25', '2026-10-25T12:00:00+0800'];
const GOOD_VALUES = ['2026-10-25', '2026-10-25T12:00:00', '2026-10-25T12:00:00+08:00', '2026-10-25T04:00:00Z'];

function mdWith(key: string, value: string): string {
  return `---\ntitle: 台架\n${key}: ${value}\n---\n\n正文\n`;
}

/* ---------------- ① 大小写归一：两道闸同一份表 ---------------- */

test('日期别名：Hugo 会读的每一种大小写写法，路由口都拦', () => {
  for (const key of HUGO_READS) {
    const msg = checkHugoDates({ title: 'x', [key]: '2026-13-45' });
    assert.ok(msg, `路由口放过了「${key}」（Hugo 会解析它，坏值让整站构建失败）`);
    assert.ok(msg!.includes(key), `回执没点名是哪一个键：${msg}`);
  }
});

test('日期别名：Hugo 会读的每一种大小写写法，仓库总闸同样拦', () => {
  for (const key of HUGO_READS) {
    const msg = checkRepoWrite('content/zh/posts/2026-01-01-1.md', mdWith(key, '2026-13-45'));
    assert.ok(msg, `仓库总闸放过了「${key}」`);
    assert.ok(msg!.includes(key), `仓库总闸的回执没点名键：${msg}`);
  }
});

test('日期别名：两道闸对同一份内容的松紧一致（不许一个拦一个放）', () => {
  for (const key of WRITE_SHAPES) {
    for (const value of [...BAD_VALUES, ...GOOD_VALUES]) {
      const route = checkHugoDates({ [key]: value }) !== null;
      const repo = checkRepoWrite('content/zh/posts/t.md', mdWith(key, value)) !== null;
      assert.equal(route, repo, `「${key}: ${value}」路由口${route ? '拦' : '放'}、仓库口${repo ? '拦' : '放'}：两张表开始分叉了`);
    }
  }
});

test('日期别名：小写别名表覆盖 Hugo 读的每一个键（大小写只差的那点归一不算漏）', () => {
  for (const key of [...HUGO_READS, ...EXTRA_GUARD_KEYS]) {
    assert.ok(checkHugoDates({ [key]: '2026-13-45' }) !== null, `${key} 不在闸的别名表里`);
  }
  // 反例：Hugo 不读、我们也不装成时间字段管的键，坏值不该被拦（拦了就是误伤站长的自定义字段）
  for (const key of ['moddate', 'revised', 'updateDate', 'expiry_date', 'start', 'end', 'endDate', 'unscheduledDate', 'dateString', 'postedOn']) {
    assert.equal(checkHugoDates({ [key]: '2026-13-45' }), null, `${key} 不是 Hugo 的时间键，不该被日期闸拦下`);
  }
});

test('日期值：好形状一律放行，坏形状一律拦（每个别名都一样）', () => {
  for (const key of HUGO_READS) {
    for (const value of GOOD_VALUES) assert.equal(checkHugoDateValue(value), null, `${key}: ${value} 该放行，实际「${checkHugoDateValue(value)}」`);
    for (const value of BAD_VALUES) assert.ok(checkHugoDateValue(value), `${key}: ${value} 该拦下`);
  }
});

test('日期别名：值本身合法时不因大小写而多报（`Date: 2026-10-25` 是好文章）', () => {
  assert.equal(checkHugoDates({ title: 'x', Date: '2026-10-25', Lastmod: '2026-10-26T08:00:00+08:00' }), null);
  assert.equal(checkRepoWrite('content/zh/posts/t.md', mdWith('DATE', '2026-10-25T04:00:00Z')), null);
});

test('日期别名：正文里出现 `---` 分隔的代码块不影响总闸只看第一对', () => {
  const md = `---\ntitle: x\ndate: 2026-10-25\n---\n\n正文里的 front matter 样子：\n\n---\ndate: 2026-13-45\n---\n`;
  assert.equal(checkRepoWrite('content/zh/posts/t.md', md), null);
});

/* ---------------- ② 上传件：魔数对上之后还要看结构 ---------------- */

const png = (extra: number[]): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]);

test('上传件：只有 PNG 魔数的 16 字节被拒（台架三轮都收下的那个件）', () => {
  const broken = png([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  assert.equal(broken.length, 16);
  const msg = checkUploadBytes('png', broken);
  assert.ok(msg && msg.includes('截断'), `实际回执：${msg}`);
  /* IHDR 在、但整份到不了结尾的件：按结束块拦 */
  const noEnd = png([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, ...new Array(24).fill(0x00)]);
  assert.ok(String(checkUploadBytes('png', noEnd)).includes('IEND'), '结尾没有 IEND 的件必须按结束块拦');
});

test('上传件：完整的最小 PNG（有 IHDR 也有 IEND）放行', () => {
  const whole = new Uint8Array([
    ...png([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00]),
    0x90, 0x9d, 0x1a, 0x4e, // CRC（内容不参与判据）
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  assert.equal(checkUploadBytes('png', whole), null);
});

test('上传件：JPEG 缺 FFD9 结尾被拒、有结尾放行', () => {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00];
  assert.ok(String(checkUploadBytes('jpg', new Uint8Array(head))).includes('FFD9'));
  assert.equal(checkUploadBytes('jpg', new Uint8Array([...head, 0xff, 0xd9])), null);
});

test('上传件：GIF 缺终止字节被拒、有 `;` 放行', () => {
  const head = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00];
  assert.ok(String(checkUploadBytes('gif', new Uint8Array(head))).includes('终止'));
  assert.equal(checkUploadBytes('gif', new Uint8Array([...head, 0x3b])), null);
});

test('上传件：WebP 声明长度超过实际字节数（RIFF 截断）被拒，声明与实际相符放行', () => {
  const head = [0x52, 0x49, 0x46, 0x46, 0x40, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0x10, 0x00, 0x00, 0x00];
  // 声明 0x40 + 8 = 72 字节，实际只有 20
  assert.ok(String(checkUploadBytes('webp', new Uint8Array(head))).includes('截断'));
  const honest = [...head];
  honest[4] = 0x0c; // RIFF 长度 = 实际长度 - 8
  assert.equal(checkUploadBytes('webp', new Uint8Array(honest)), null);
});

test('上传件：PDF 缺 %%EOF 被拒', () => {
  const body = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
  assert.ok(String(checkUploadBytes('pdf', body)).includes('EOF'));
  assert.equal(checkUploadBytes('pdf', new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n')), null);
});

test('上传件：结构判据不碰音视频（这几类仍然只认魔数，判错的风险比收益大）', () => {
  const mp4 = new TextEncoder().encode(''.padEnd(48, 'x'));
  mp4.set([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]); // size + ftyp
  mp4.set([0x69, 0x73, 0x6f, 0x6d], 8);
  assert.equal(checkUploadBytes('mp4', mp4), null);
});
