/**
 * hugo-guard.ts — 写进内容仓之前，按 **Hugo 的口径** 拦一道。
 *
 * 为什么要有这个文件：这套系统里「保存成功」和「站点能构建成功」以前是两件事。
 * 后台把 front matter 拼好交给仓库、仓库交给 Git/Pages，谁都不问 Hugo 能不能读；
 * 而 Hugo 对某些值是**整站构建失败**（退出码 1），不是「这一篇跳过」：
 *   date: 2026-10-25 12:00      → ERROR the "date" front matter field is not a parsable date
 *   date: 2026-10-25T12:00      → 同上（少秒，HTML datetime-local 的原样值）
 * JS 的 Date.parse 对这两种都**给得出数**，所以老代码里那道「发布时间在将来」的判断反而把它们放过去了。
 * 台架 2026-10-25 第 1 轮实测：一篇这样的文章能让本地 hugo server 静默停在旧构建、
 * 让线上 Pages 构建失败 —— 而后台每一笔都显示「已保存」。
 *
 * 这里只收** Hugo 会硬失败**的几类，不做风格洁癖：
 *   ① 日期格式与真实日历日（date / lastmod / updated / publishDate / expiryDate，含小写别名）；
 *   ② 媒体对象键的长度与字符（R2 对超长名回运行时错误，以前冒成 500）；
 *   ③ 上传件的字节真相（空文件、扩展名与文件头不符）。
 */
import { checkRepoFileSyntax } from './repo-syntax';

/* ------------------------------------------------------------------ ① 日期 */

/** Hugo 0.165 实测能解析的两种形状：纯日期，或带秒（可带时区）的时间戳。空格分隔的「只到分」不行。 */
const HUGO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * 会被写进 front matter 的时间字段。
 *
 * **一律按小写比对**：Hugo 认这些键时不分大小写（实测 `Date:`、`DATE:`、`Lastmod:`、`PUBLISHDATE:`、
 * `expiryDate:` 它都会去解析），而上一版这张表是精确大小写的字符串数组，于是同一个坏值写成
 * `expiryDate`（Hugo 真读的写法）就从两道闸中间漏过去，落盘后整站构建失败 —— 台架 2026-10-29 三轮实测。
 * `modified` 是这轮按实测补进来的（`modified: 2026-13-45` 同样让 Hugo 退出码 1）。
 * 表里保留 `updated` / `expiredate` / `startdate`：Hugo 0.165 实测不读它们，但历史版本读，
 * 而且这三个键的值本来就该是时间，拦住写坏的值比放过去让某些版本炸站安全。
 */
const DATE_KEYS = ['date', 'lastmod', 'updated', 'publishdate', 'expirydate', 'expiredate', 'startdate', 'modified'];
const DATE_KEY_SET = new Set(DATE_KEYS);

/** 这个 front matter 键该不该按时间校？返回规范化后的键名（用于回执），不该则 null */
function dateKeyAlias(key: string): string | null {
  const lower = String(key ?? '').toLowerCase();
  return DATE_KEY_SET.has(lower) ? lower : null;
}

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isRealCalendarDay(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > MONTH_DAYS[m - 1]!) return false;
  if (m === 2 && d === 29) return !(y % 4) && (!!((y % 100)) || !(y % 400));
  return true;
}

/** 一条时间值能不能被 Hugo 解析；能则返回 null */
export function checkHugoDateValue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return null;
  if (typeof value === 'number') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    return `时间要写成字符串或省略，现在是 ${typeof value} 形状`;
  }
  const text = String(value).trim();
  if (!text) return null;
  const m = HUGO_DATE_RE.exec(text);
  if (!m) {
    return `「${text}」Hugo 解析不了：要么用日期 2026-10-25，要么把时间和时区写全 2026-10-25T12:00:00+08:00（只到分、少秒、用 / 分隔都会让整站构建失败）`;
  }
  const [, ys, mos, ds, hs, ms, ss] = m;
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  if (!isRealCalendarDay(y, mo, d)) return `「${text}」里的日期不存在（${mo} 月没有 ${d} 日，或月份/年份越界）`;
  if (hs !== undefined) {
    if (Number(hs) > 23 || Number(ms) > 59 || Number(ss) > 60) return `「${text}」里的时间不存在（时:分:秒要在 23:59:59 之内）`;
    const off = m[7];
    if (off && off !== 'Z') {
      const [, oh, om] = /([+-])(\d{2}):(\d{2})/.exec(off) ?? [];
      if (Number(oh) > 23 || Number(om) > 59) return `「${text}」里的时区偏移越界`;
    }
  }
  return null;
}

/** 一整份 front matter：返回第一条不可解析的时间错误（含字段名），没有则 null */
export function checkHugoDates(front: Record<string, unknown> | null | undefined): string | null {
  if (!front || typeof front !== 'object') return null;
  /* 按小写别名比对：Hugo 认这些键不分大小写，写成 Date: / expiryDate: 一样会被它解析 */
  for (const [key, value] of Object.entries(front)) {
    const alias = dateKeyAlias(key);
    if (!alias) continue;
    const err = checkHugoDateValue(value);
    if (err) return `${key}${alias === key ? '' : `（Hugo 按 ${alias} 读）`}：${err}`;
  }
  return null;
}

/* ------------------------------------------------------------------ ② 媒体键 */

/** R2 的对象名上限（实测 1023 能过、1024 起报 "object name is not valid"），留足余量 */
export const MEDIA_KEY_MAX = 700;

/** 返回错误说明；合法则 null。控制字符、.. 段、越界长度都在这里挡掉，别让它冒到运行时成 500。 */
export function checkMediaKey(key: string): string | null {
  const k = String(key ?? '');
  if (!k) return '缺少对象键';
  if (k.length > MEDIA_KEY_MAX) return `对象键过长（${k.length} 字符，上限 ${MEDIA_KEY_MAX}）`;
  if (/[\u0000-\u001f\u007f]/.test(k)) return '对象键含控制字符';
  const segs = k.replace(/\\/g, '/').split('/');
  if (segs.some((s) => s === '.' || s === '..')) return '对象键不能含 . 或 .. 段';
  return null;
}

/* ------------------------------------------------------------------ ③ 上传件 */

/** 扩展名 → 认哪些文件头。对得上才算真货；对不上就是「改了名的别种文件」，以前这种能一路进图库并在前台永久破图。 */
const SIGNATURES: Array<{ kind: string; test: (b: Uint8Array) => boolean }> = [
  { kind: 'png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { kind: 'jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'gif', test: (b) => b.length > 5 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { kind: 'webp', test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  { kind: 'avif', test: (b) => ascii(b, 4, 8) === 'ftyp' && /avif|avis/.test(ascii(b, 8, 12)) },
  { kind: 'heic', test: (b) => ascii(b, 4, 8) === 'ftyp' && /heic|heix|hevc|mif1/.test(ascii(b, 8, 16)) },
  { kind: 'mp4', test: (b) => ascii(b, 4, 8) === 'ftyp' },
  { kind: 'pdf', test: (b) => ascii(b, 0, 4) === '%PDF' },
  { kind: 'mp3', test: (b) => (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || ascii(b, 0, 3) === 'ID3' },
  { kind: 'ogg', test: (b) => ascii(b, 0, 4) === 'OggS' },
  { kind: 'flac', test: (b) => ascii(b, 0, 4) === 'fLaC' },
  { kind: 'wav', test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE' },
  { kind: 'avi', test: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'AVI ' },
  { kind: 'bmp', test: (b) => ascii(b, 0, 2) === 'BM' },
  { kind: 'ico', test: (b) => b.length > 3 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 },
  { kind: 'tiff', test: (b) => ascii(b, 0, 4) === 'II*\u0000' || ascii(b, 0, 4) === 'MM\u0000*' },
  { kind: 'mkv', test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { kind: 'webm', test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { kind: 'm4a', test: (b) => ascii(b, 4, 8) === 'ftyp' && /M4A |mp42|isom/.test(ascii(b, 8, 12)) },
  { kind: 'aac', test: (b) => b[0] === 0xff && (b[1] & 0xf6) === 0xf0 },
];

/** 这些扩展名有明确文件头，必须验；验不出来就当不是它 */
const STRICT_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'pdf', 'heic', 'avif']);
const EXT_KINDS: Record<string, string[]> = {
  png: ['png'], jpg: ['jpeg'], jpeg: ['jpeg'], gif: ['gif'], webp: ['webp'],
  bmp: ['bmp'], ico: ['ico'], tiff: ['tiff'], pdf: ['pdf'], heic: ['heic', 'm4a'], avif: ['avif', 'mp4'],
  mp4: ['mp4', 'quicktime'], mov: ['mp4', 'quicktime'], m4a: ['m4a', 'mp4'], aac: ['aac', 'adts'],
  mp3: ['mp3'], ogg: ['ogg'], wav: ['wav'], flac: ['flac'], mkv: ['mkv', 'webm'], webm: ['webm', 'mkv'],
};

function ascii(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

export function detectKind(bytes: Uint8Array): string | null {
  for (const sig of SIGNATURES) if (sig.test(bytes)) return sig.kind;
  return null;
}

/**
 * 上传件的字节真相。三条判据，一条都不涉及「什么格式才高级」的偏好：
 *   · 空文件：库里留一个 0 字节的件，前台永远是一张破图，而上传方以为成了；
 *   · 文本/HTML 开头：改了扩展名也拦（白名单只管扩展名，挡不住「<html> 改名 .png」）；
 *   · STRICT 名单里的扩展名必须有对应文件头。
 */
export function checkUploadBytes(ext: string, bytes: Uint8Array): string | null {
  if (bytes.length === 0) return '文件是 0 字节：什么都没传上来（浏览器读本地文件失败时也会这样），媒体库里留个空件只会变成前台一张破图';
  const head = ascii(bytes, 0, 8).toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml') || head.startsWith('<svg')) {
    return `文件内容其实是标记语言（开头「${ascii(bytes, 0, 12).replace(/[^\x21-\x7e]/g, ' ')}…」），不是 .${ext}：改名混进来会在图床域名上被人当页面读`;
  }
  const allowed = EXT_KINDS[ext.toLowerCase()];
  const detected = detectKind(bytes);
  if (STRICT_EXTS.has(ext.toLowerCase()) && allowed?.length) {
    const got = detected;
    if (!got) return `.${ext} 的文件头不对（认出来的是「${got ?? '无法识别'}」）：把内容原样存成 .${ext} 会在图床域名上被误当别的类型`;
    if (!allowed.includes(got)) return `文件头是 ${got}，扩展名却是 .${ext}：两者不一致时前台按哪个类型处理说不准，请改成与内容相符的扩展名`;
  }
  /* 魔数只证明「开头几个字节像」，证明不了这份文件能解码。台架 2026-10-29 实测：
     16 字节（PNG 魔数 + IHDR 前几个字节）的文件当时是**收下了**，图库里就是一张永远打不开的破图；
     变体口同理，`RIFF`+`WEBP` 后接一串垃圾也照收，而清单一旦记下这个档位，前台 srcset 就会去用它。
     来源通常是浏览器截断的下载、上传中途关页面、以及往桶里灌脚本。判据放在这一个函数里，
     上传口与变体口共用。 */
  return checkStructure(detected ?? ext.toLowerCase(), bytes);
}

/** 结构完整性：只查「一定会炸」的几件事，不做格式洁癖（能解码的最小图 67 字节，所以不按大小一刀切） */
function checkStructure(kind: string, b: Uint8Array): string | null {
  const tail = (n: number) => ascii(b, Math.max(0, b.length - n), b.length);
  const truncated = (what: string) =>
    `这份 .${kind} 只有 ${b.length} 字节且${what}：像是下载或上传被截断的文件。媒体库里存成这样，前台引用它就是张永远打不开的破图，请重新导出完整文件`;
  switch (kind) {
    case 'png':
      if (b.length < 24) return truncated('短于一个最小合法 PNG');
      if (ascii(b, 12, 16) !== 'IHDR') return truncated('缺 IHDR 头块');
      if (!tail(16).includes('IEND')) return truncated('结尾没有 IEND 结束块');
      return null;
    case 'jpeg':
      if (b.length < 20) return truncated('短于一张最小合法 JPEG');
      if (!(b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9)) return truncated('结尾没有 FFD9 结束标记');
      return null;
    case 'gif':
      if (b.length < 20) return truncated('短于一张最小合法 GIF');
      if (b[b.length - 1] !== 0x3b && !tail(3).includes(';')) return truncated('结尾没有 GIF 终止字节');
      return null;
    case 'webp': {
      if (b.length < 20) return truncated('短于一个最小合法 WebP');
      const fourcc = ascii(b, 12, 16);
      if (!['VP8 ', 'VP8L', 'VP8X', 'ANIM'].includes(fourcc)) return truncated(`第一个块不是图像数据块（读到的是「${fourcc.replace(/[^\x20-\x7e]/g, ' ')}」）`);
      const declared = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) + 8;
      /* RIFF 头里写的总长度比实际字节多 —— 就是被截断了（少一点可能是尾部填充，放过） */
      if (declared > 8 && declared > b.length + 1) return truncated(`文件头声明 ${declared} 字节，实际只有 ${b.length} 字节`);
      return null;
    }
    case 'pdf':
      if (!tail(64).includes('%%EOF')) return truncated('结尾没有 %%EOF');
      return null;
    default:
      /* 音视频与容器格式的原子结构太多种，判错的风险比收益大：这几类仍然只认魔数 */
      return null;
  }
}

/* ------------------------------------------------------------------ ④ 写进仓库的每一份文件 */

/**
 * 仓库写入层的总闸门。上一轮把判据加在各条路由的「保存」里，结果是**保护按调用点堆积**：
 * 实测还有 6 个会触发站点重建的入口一个检查都没有（投稿审核、友链申请、个人中心写稿、整篇翻译、
 * 备份恢复、以及**每天 02:00 的 cron** —— cron 直接往仓库写 data/poststats.json 与友链那两份 JSON）。
 * 而 R31 那次打死整站构建的正是「构建期被消费的数据文件」。
 *
 * 所以这一条挂在**往仓库写的那个唯一出口**上（services/repo.ts 的 writeViaTarget / commitViaTarget），
 * 以后新增写入口自动带上，不需要谁记得再抄一遍。
 *
 * 刻意只收「Hugo 会硬失败」的三种，且全部复用已有判据，不另立标准：
 *   ① .toml / links.yaml → 交给 repo-syntax（真解析器，已拿站长真站那份验过能过）；
 *   ② .json → 只用 JSON.parse 判「语法就坏了」的；**不**检查字段形状 ——
 *      台架实测 site.json 里把描述包成数组并不炸构建，按形状拦会把正当保存挡在门外；
 *   ③ .md → 扫开头那段 front matter 的时间字段，值本身的判据仍是上面那一份 checkHugoDateValue。
 * 返回 null = 放行；返回字符串 = 一句人能照着改的话（调用方当 400 的 message，或写进审计与日志）。
 */
export function checkRepoWrite(path: string, content: string): string | null {
  const p = String(path ?? '').trim().replace(/\\/g, '/');

  const syntax = checkRepoFileSyntax(p, content);
  if (syntax) return syntax;

  if (/\.json$/i.test(p)) {
    try {
      JSON.parse(content);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `${p} 不是合法的 JSON（${String(msg).replace(/\s+/g, ' ').slice(0, 160)}）：这种内容写进仓库会让 Hugo 读不出这一份数据文件，所以没写进去`;
    }
    return null;
  }

  if (/\.md$/i.test(p)) return checkMarkdownFrontDates(p, content);

  return null;
}

/**
 * 只扫第一对 `---` 之间的时间行。这里**不**引入 services/frontmatter.ts 那个解析器：
 * 它要读 git 与配置，引进来就和 repo.ts 成了环。规则仍然只有一份 —— 每条时间值
 * 还是交给 checkHugoDateValue 判，这里只负责把「哪个键配了哪个值」找出来。
 */
function checkMarkdownFrontDates(path: string, md: string): string | null {
  const text = String(md ?? '');
  const open = text.startsWith('---') ? 0 : -1;
  if (open < 0) return null;
  const close = text.indexOf('\n---', 3);
  if (close < 0) return null;
  const block = text.slice(3, close);
  for (const line of block.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][\w-]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    /* 与上面 checkHugoDates 同一张表、同一种比法（小写别名）：两道闸不能一道严一道松 */
    if (!dateKeyAlias(key)) continue;
    const raw = m[2]!.replace(/^["']|["']$/g, '');
    const err = checkHugoDateValue(raw);
    if (err) return `${path} 的 ${key}：${err}`;
  }
  return null;
}

