/**
 * data/links.yaml 的追加写入。
 *
 * 友链页由 Hugo 构建期读取 data/links.yaml 渲染，后台审核通过一条申请后，
 * 除了进 D1（供 RSS 聚合与健康检测用），还要把这条站点写回仓库，
 * 站点重建后才会出现在 /links/ 上。
 *
 * 文件里有两个列表段：
 *   friends:   左邻右舍，字段 name / url / desc / icon / image / email / rss
 *   alliance:  站点联盟，字段 name / url / desc / icon（不参与在线检测）
 * 条目按 kind 落到对应的段里；缺 alliance: 段时在文件末尾补一个。
 *
 * 这里不做 YAML 解析与序列化：那份文件带几十行使用说明，序列化回去会全丢。
 * 只在目标段落的末尾插入条目，其余字节保持原样。
 */

export type FriendKindKey = 'friend' | 'alliance';

export interface NewFriend {
  name: string;
  url: string;
  description?: string | null;
  avatar?: string | null;
  image?: string | null;
  email?: string | null;
  rssUrl?: string | null;
  /** 缺省 'friend'：进 friends: 段；'alliance' 进 alliance: 段 */
  kind?: FriendKindKey | (string & {});
}

export interface AppendResult {
  text: string;
  added: string[];
  skipped: { url: string; reason: string }[];
  /** 没有发生任何写入时给出原因，后台直接展示 */
  message: string | null;
}

/** 比较用：忽略协议、www 与末尾斜杠 */
export function normalizeFriendUrl(u: string): string {  return u
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/**
 * 写进 links.yaml 的标量：友链的 name / desc / url 每一项在主题里都是**一行**。
 * 这里先把控制字符拿掉再转义 —— 手写的双引号不会把 `\n` 转成 `\n`，
 * 昵称里带回车就会在 YAML 里折成一条跨行的值，`desc` 里多个换行还能把后面几条友链的排版带歪。
 */
function quote(value: string): string {
  const oneLine = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim();
  return `"${oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const TOP_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*:/;

/** friends: / alliance: 段的顶层键 */
const SECTION_KEYS = ['friends', 'alliance'] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

function sectionOf(kind: unknown): SectionKey {
  return String(kind ?? '').trim().toLowerCase() === 'alliance' ? 'alliance' : 'friends';
}

/** 取出某个顶层键的行区间 [start, end)，end 是下一个顶层键 */
function blockOf(lines: string[], key: SectionKey): { start: number; end: number } | null {
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l) || new RegExp(`^${key}:\\s*\\[\\]\\s*(#.*)?$`).test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (TOP_KEY_RE.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/** 两个段里已经出现过的 URL（规范化后）——同一个站不能既进友链又进联盟 */
function existingFriendUrls(text: string): Set<string> {
  const lines = text.split(/\r?\n/);
  const set = new Set<string>();
  for (const key of SECTION_KEYS) {
    const block = blockOf(lines, key);
    if (!block) continue;
    for (let i = block.start + 1; i < block.end; i++) {
      const m = /^\s*[-\s]*url:\s*(.*)$/.exec(lines[i]!);
      if (m) set.add(normalizeFriendUrl(scalarValue(m[1]!)));
    }
  }
  return set;
}

/**
 * 取出一个标量值。
 *
 * 别把 `#` 后面一律当注释切掉：友链地址常带 `#apply` 这类锚点，引号里的 `#` 更是字面量
 * —— 早先就是这么切的，`"http://host/links/#apply"` 被读成 `http://host/links`，
 * 那条在文件里删不掉，前台于是永远多出一条后台管不着的链接。
 * YAML 的规则是「裸值里、前面有空格的 # 才起注释作用」，这里照这条来。
 */
export function scalarValue(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (s[0] === '"') {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const ch = s[i]!;
      if (ch === '\\' && i + 1 < s.length) {
        out += s[++i];
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return out.trim();
  }
  if (s[0] === "'") {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const ch = s[i]!;
      if (ch !== "'") {
        out += ch;
        continue;
      }
      if (s[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      break;
    }
    return out.trim();
  }
  return s.replace(/\s+#.*$/, '').trim();
}

/** 一段 YAML 列表条目：联盟只写主题会读的字段，友链保持原有写法 */
function entryLines(section: SectionKey, entry: NewFriend): string[] {
  const out = [`  - name: ${quote(entry.name)}`, `    url: ${quote(entry.url)}`, `    desc: ${quote(entry.description ?? '')}`];
  if (section === 'friends') {
    out.push(`    icon: ${quote(entry.avatar ?? '')}`);
    if (entry.image) out.push(`    image: ${quote(entry.image)}`);
    out.push(`    email: ${quote(entry.email ?? '')}`);
    out.push(`    rss: ${quote(entry.rssUrl ?? '')}`);
  } else {
    out.push(`    icon: ${quote(entry.avatar ?? '')}`);
  }
  return out;
}

/**
 * 把条目插进对应段落（friends: / alliance:）的末尾；已存在的 URL 跳过，不重复写。
 * alliance: 段缺失时在文件末尾新建一段，免得后台通过了联盟站点、主题那边却没地方读。
 */
export function appendFriends(text: string, entries: NewFriend[]): AppendResult {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const seen = existingFriendUrls(text);
  const added: string[] = [];
  const skipped: AppendResult['skipped'] = [];

  // 按段分组，插桩时每段一次写入，顺序与入参一致
  const planned = new Map<SectionKey, NewFriend[]>();
  for (const entry of entries) {
    const section = sectionOf(entry.kind);
    const key = normalizeFriendUrl(entry.url);
    if (seen.has(key)) {
      skipped.push({ url: entry.url, reason: '该站点已在友链数据里' });
      continue;
    }
    // friends: 段是这份文件的主段，缺了就是文件不对劲，不猜该写到哪
    if (section === 'friends' && !blockOf(lines, 'friends')) {
      skipped.push({ url: entry.url, reason: '文件里没有 friends: 段' });
      continue;
    }
    seen.add(key);
    planned.set(section, [...(planned.get(section) ?? []), entry]);
    added.push(entry.url);
  }

  if (!added.length) {
    return { text, added, skipped, message: skipped[0]?.reason ?? '没有需要写入的友链' };
  }

  let out = [...lines];
  let createdAlliance = false;

  for (const [section, list] of planned) {
    const chunk = list.flatMap((e) => entryLines(section, e));
    const block = blockOf(out, section);
    if (!block) {
      // 只有 alliance: 会走到这里：站点没建过联盟段，就在末尾补一段
      while (out.length && !out[out.length - 1]!.trim()) out.pop();
      out.push(`${section}:`, ...chunk, '');
      createdAlliance = true;
      continue;
    }
    /* 段头写成流式空表 `friends: []` 时（出厂新站与「一条都没同步过」的文件就是这样），
       在它后面直接挂块状条目会得到 `friends: []` + `  - name: …`，go-yaml 当场拒绝
       （实测 `[10:3] value is not allowed in this context` → **整站构建失败**，
       而接口当时回的是「已同意」。所以先把这一行收成光秃秃的 `friends:`，条目照原样跟在下面。 */
    const head = /^([A-Za-z_][\w-]*): *\[[ \t]*\]([ \t]*(?:#.*)?)$/.exec(out[block.start]!);
    if (head) out[block.start] = `${head[1]}:${head[2] ?? ''}`;
    // 从段尾往回跳过空行与注释：那些说明文字属于下一个键，不能被插到中间
    let insertAt = block.end;
    if (block.end - block.start <= 1) insertAt = block.start + 1;
    else {
      for (let i = block.end - 1; i > block.start; i--) {
        const l = out[i]!;
        if (!l.trim() || /^\s*#/.test(l)) continue;
        insertAt = i + 1;
        break;
      }
    }
    out = [...out.slice(0, insertAt), ...chunk, ...out.slice(insertAt)];
  }

  const message = createdAlliance ? '新建了 alliance: 段' : null;
  return { text: out.join(eol), added, skipped, message };
}

/**
 * 从 data/links.yaml 里删掉某个站点（两个段落都找）。
 *
 * 后台删除一条友链时必须连带这份文件：前台「左邻右舍 / 站点联盟」就是按这份文件
 * 构建期渲染的，只删 D1 的话页面下次构建还是照旧显示它（就是「删了还在」那个问题）。
 * 条目是「- name: … 往下若干行同级字段」，按 url 命中后整块删掉，注释与空行不动。
 */
export interface RemoveResult {
  text: string;
  removed: string | null;
  message: string | null;
}

/** 命中条目的行区间（半开区间 [start, end)）与它所属段落 */
interface ItemHit {
  section: SectionKey;
  start: number;
  end: number;
}

/**
 * 条目块的实际结尾：末尾那些空行与独立注释行属于下一个键（或段落的说明文字），
 * 不算这一条的内容。不裁的话，删最后一条会把段落尾部的空行一起吃掉。
 */
function trimChunkEnd(lines: string[], start: number, end: number): number {
  let e = end;
  while (e > start + 1) {
    const l = lines[e - 1]!;
    if (!l.trim() || /^\s*#/.test(l)) {
      e--;
      continue;
    }
    break;
  }
  return e;
}

/** 在两个段落里按 url 找那一条；找不到返回 null */
function findItem(lines: string[], url: string): ItemHit | null {
  const target = normalizeFriendUrl(url);
  if (!target) return null;
  for (const key of SECTION_KEYS) {
    const block = blockOf(lines, key);
    if (!block) continue;
    let start = -1;
    for (let i = block.start + 1; i <= block.end; i++) {
      const line = i === block.end ? '' : lines[i]!;
      if (/^\s*-\s+[A-Za-z_][\w-]*\s*:/.test(line)) {
        if (start >= 0 && chunkUrl(lines.slice(start, i)) === target) {
          return { section: key, start, end: trimChunkEnd(lines, start, i) };
        }
        start = i;
      }
    }
    if (start >= 0 && chunkUrl(lines.slice(start, block.end)) === target) {
      return { section: key, start, end: trimChunkEnd(lines, start, block.end) };
    }
  }
  return null;
}

export function removeFriend(text: string, url: string): RemoveResult {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const hit = findItem(lines, url);
  if (!hit) return { text, removed: null, message: '这份数据文件里没有这个站点' };
  const out = [...lines.slice(0, hit.start), ...lines.slice(hit.end)];
  return { text: out.join(eol), removed: normalizeFriendUrl(url), message: null };
}

/**
 * 原位改写某一条（按 oldUrl 找）。找不到就返回 replaced:false，调用方决定要不要新增。
 * 保留原位置是为了不打乱作者手工排好的顺序；换分组时目标段落与现在不同，
 * 就整条搬到那一段末尾（顺序会变，但分组必须对）。
 */
export interface ReplaceResult {
  text: string;
  replaced: boolean;
  /** 换段落了（友链 ↔ 站点联盟） */
  moved: boolean;
}

export function replaceFriend(text: string, oldUrl: string, entry: NewFriend): ReplaceResult {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const hit = findItem(lines, oldUrl);
  if (!hit) return { text, replaced: false, moved: false };
  const want = sectionOf(entry.kind);
  const chunk = entryLines(want, entry);
  if (want === hit.section) {
    const out = [...lines.slice(0, hit.start), ...chunk, ...lines.slice(hit.end)];
    return { text: out.join(eol), replaced: true, moved: false };
  }
  // 搬到另一段：先删这条，再交给 appendFriends 追加到目标段末尾
  const stripped = [...lines.slice(0, hit.start), ...lines.slice(hit.end)];
  const appended = appendFriends(stripped.join(eol), [entry]);
  return { text: appended.text, replaced: true, moved: true };
}

/** 从一个条目块里取出 url 字段 */
function chunkUrl(chunk: string[]): string {
  for (const l of chunk) {
    const m = /^\s*[-\s]*url:\s*(.*)$/.exec(l);
    if (m) return normalizeFriendUrl(scalarValue(m[1]!));
  }
  return '';
}

/**
 * 按给定顺序重排两段里的条目块（后台「友链 → 保存顺序」用）。
 *
 * 为什么需要这一手：前台那两页是 hugo 构建期按 `data/links.yaml` 的**段落顺序**渲染的，
 * 而排序这条路以前只改 D1 的 sortOrder、不碰文件 —— 后台列表自己按 sortOrder 排，
 * 于是界面上看着挪好了，站点上一个字没动（实测：两次相反的排序，文件与 HTML 完全一致）。
 *
 * 做法是「整块搬、不重排字段」：条目块连着它后面的空行与注释一起走，段头之前的说明、
 * 段尾剩下的内容都留在原位，所以手写在文件里的注释与条目不会被改写或丢掉。
 * 没在 order 里的条目（比如手写的、或本次没动的）排到最后，彼此保持原顺序。
 */
export function sortFriendBlocks(text: string, order: Map<string, number>): { text: string; moved: number } {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  /** 调用方给的是库里存的原始网址，文件里的写法可能多个斜杠 / www / 大写 —— 两边都规范化之后再比 */
  const wanted = new Map<string, number>();
  for (const [u, n] of order) wanted.set(normalizeFriendUrl(u), n);
  const itemStart = (l: string) => /^\s*-\s+[A-Za-z_][\w-]*\s*:/.test(l);
  let moved = 0;
  /* 从后往前搬，前面那些段的行号才不会因为这里 splice 而错位 */
  for (const key of [...SECTION_KEYS].reverse()) {
    const block = blockOf(lines, key);
    if (!block) continue;
    const bounds: number[] = [];
    for (let i = block.start + 1; i < block.end; i++) if (itemStart(lines[i]!)) bounds.push(i);
    if (bounds.length < 2) continue;
    /* 条目上方紧挨着的注释 / 空行算这一条自己的头（这份文件是允许手写的，
       把「这条是后加的」这种说明甩到别的条目下面，比丢注释更难查） */
    const starts = bounds.map((b) => {
      let s = b;
      while (s - 1 > block.start && /^\s*(#|$)/.test(lines[s - 1]!)) s--;
      return s;
    });
    for (let i = 0; i < starts.length - 1; i++) if (starts[i]! >= starts[i + 1]!) starts[i] = bounds[i]!;
    const chunks: { url: string; from: number; to: number }[] = [];
    for (let i = 0; i < starts.length; i++) {
      const from = starts[i]!;
      /** 最后一块要把它后面的空行 / 注释留给段尾，别一并搬走 */
      const to = i + 1 < starts.length ? starts[i + 1]! : trimChunkEnd(lines, bounds[i]!, block.end);
      chunks.push({ url: chunkUrl(lines.slice(from, to)), from, to });
    }
    const rank = (c: (typeof chunks)[number], i: number) => (wanted.has(c.url) ? wanted.get(c.url)! : Number.MAX_SAFE_INTEGER - (chunks.length - i));
    const sorted = chunks.map((c, i) => ({ c, i, r: rank(c, i) })).sort((a, b) => a.r - b.r || a.i - b.i);
    if (sorted.every((s, i) => s.i === i)) continue;
    const flat = sorted.map((s) => lines.slice(s.c.from, s.c.to)).flat();
    const spanFrom = chunks[0]!.from;
    const spanTo = chunks[chunks.length - 1]!.to;
    /** 只做置换：行数变了就说明切块切错了，宁可不搬也不能把数据文件写坏 */
    if (flat.length !== spanTo - spanFrom) continue;
    lines.splice(spanFrom, spanTo - spanFrom, ...flat);
    moved += flat.length;
  }
  return { text: lines.join(eol), moved };
}

/**
 * 语法体检：只认「Hugo（go-yaml）一定会拒绝」的那几种写法，宁可放过也不要误拒。
 *
 * 为什么要有这一份：后台「前端管理 → 主题配置文件」能把 data/links.yaml 整份覆盖成任意文本，
 * 而这份文件一旦坏了 Hugo 是 `failed to load data: [1:3] sequence end token ']' not found`，
 * **友链整页没了对应前台还是 200**，接口当时回的是「已保存」。与 params.toml 那三条同一类事故。
 *
 * 这里不试图做一个 YAML 解析器（那要引一个 119KB gzip 的依赖，而本文件的写入方就是我们自己，
 * 见上面 parseLinksYaml 的注释），但必须挡住实测会炸的这几类（每类都真跑过 hugo --gc --minify）：
 *  ① 整份被粘成散文 —— Hugo 回 `unexpected data type string in file links.yaml`，构建 exit=1；
 *     （第一版只挡了 `[[[`/`{` 起始，漏了这一类，是第 15 套那条红把它揪出来的）
 *  ② 已知段落（friends / alliance）的值写成一句话 —— Hugo 能过，但主题 `range` 时炸在友链页；
 *  ③ 流式起始 `[[[` —— `sequence end token ']' not found`；
 *  ④ Tab 缩进 —— go-yaml 直接 "found character that cannot start any token"；
 *  ⑤ 值以引号开头却没闭合。
 * 换句话说：认这份文件自己的固定形状（顶层键 + 下面缩进的条目行），行形状对不上就拒。
 * 返回 null = 可以落盘；返回字符串 = 一句人话，直接当接口的 400 文案。
 */
const TOP_KEY_LINE = /^([A-Za-z_][\w-]*):(.*)$/;
const ITEM_FIRST_LINE = /^\s+-\s+[A-Za-z_][\w-]*:.*$/;
const ITEM_FIELD_LINE = /^\s{2,}[A-Za-z_][\w-]*:.*$/;

export function validateLinksYaml(text: string): string | null {
  const raw = String(text ?? '');
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const firstIndex = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
  if (firstIndex < 0) return null; // 只有注释/空：交给入口那道「不许写空」管

  const first = lines[firstIndex] ?? '';
  // ①③ 顶层必须是个映射键；散文行、`[[[`、`{…}` 都在这里挡掉
  if (!TOP_KEY_LINE.test(first)) {
    return `第 ${firstIndex + 1} 行不是友链文件的写法：顶层要按「friends:」「alliance:」两段来写，每段下面用「  - name: …」列条目（现在开头是「${first.trim().slice(0, 40)}」）`;
  }

  /* 流式空表后面又挂块状条目 —— `friends: []` 紧跟 `  - name: …` 是 go-yaml 一定拒绝的形状
     （实测 `[3:3] value is not allowed in this context`，Hugo 整站构建失败、页面还照旧 200）。
     写方已改成「先收光秃秃的键再挂条目」，这一道是给后台那个「整份覆盖」的编辑口兜底：
     从别处粘来这种形状也必须当场拒绝，而不是等构建挂了才知道。 */
  let flowEmptyKey: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = TOP_KEY_LINE.exec(line);
    if (top) {
      const v = String(top[2] ?? '').replace(/\s+#.*$/, '').trim();
      flowEmptyKey = v === '[]' || v === '{}' ? String(top[1]) : null;
      continue;
    }
    if (flowEmptyKey && /^\s+-\s*\S/.test(line)) {
      return `第 ${i + 1} 行：「${flowEmptyKey}:」已经写成空表 [] 了，下面不能再挂条目 —— 要列条目就把这一行改成「${flowEmptyKey}:」，别在空表后面加条目（这样 Hugo 构建会整站失败）`;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) continue;
    // ④ Tab 缩进：go-yaml 一律拒
    if (/^\s*\t/.test(line)) return `第 ${i + 1} 行用了 Tab 缩进（YAML 只认空格）：${line.trim().slice(0, 40)}`;
    // ⑤ 值以引号开头却没闭合。只看值起始位置 —— `name: it's fine` 这种裸值里的撇号是合法的，
    //    拿整行引号奇偶去判会把它误杀（与 authors.ts 的 unclosedQuote 同一口径）。
    if (unclosedValueQuote(line)) return `第 ${i + 1} 行的值以引号开头却没闭合：${line.trim().slice(0, 50)}`;

    if (TOP_KEY_LINE.test(line)) {
      // ② 已知段落必须是「键:」后面换行列条目（或写个空表 []），不能是一句话
      const key = (line.match(TOP_KEY_LINE)?.[1] ?? '').toLowerCase();
      const value = String(line.match(TOP_KEY_LINE)?.[2] ?? '').replace(/\s+#.*$/, '').trim();
      if (SECTIONS[key] && value && value !== '[]') {
        return `第 ${i + 1} 行：「${key}:」这一段得写成下面的条目列表（每行「  - name: …」），现在直接接了一句话，主题渲染友链页会炸`;
      }
      continue;
    }
    if (ITEM_FIRST_LINE.test(line) || ITEM_FIELD_LINE.test(line)) continue;
    // 落到这里说明这行既不是顶层键也不是条目行 —— 就是混进来的散文/别的形状
    return `第 ${i + 1} 行对不上友链文件的形状：顶层是「friends:」「alliance:」两段，段里每行写成「  - name: …」或「    url: …」（这一行是「${line.trim().slice(0, 40)}」）`;
  }
  return null;
}


/** 值从引号开始却没走到闭合引号 → go-yaml 一定报错；裸值里出现引号不算问题 */
function unclosedValueQuote(line: string): boolean {
  const idx = line.indexOf(':');
  if (idx < 0) return false;
  const v = line.slice(idx + 1).trim();
  if (v.length < 1) return false;
  const q = v[0];
  if (q !== '"' && q !== "'") return false;
  for (let i = 1; i < v.length; i++) {
    const ch = v[i];
    if (q === '"' && ch === '\\') { i++; continue; }
    if (ch === q) {
      if (q === "'" && v[i + 1] === "'") { i++; continue; }
      return false;
    }
  }
  return true;
}

/**
 * 读 data/links.yaml 里已登记的站点。
 *
 * 友链的真实清单在这份文件（前台也用它渲染），D1 的 friends 表只装了后台经手的那几条。
 * 健康检测与 RSS 聚合要覆盖全部站点，所以两边都得读；这里只写一个针对本文件固定结构的
 * 行扫描，不引入 YAML 依赖 —— Worker 里多一个解析库不值当，而且文件是我们自己生成的。
 */
export interface LinkSite {
  name: string;
  url: string;
  icon: string;
  image: string;
  email: string;
  rss: string;
  kind: FriendKindKey;
}

const SECTIONS: Record<string, FriendKindKey> = { friends: 'friend', alliance: 'alliance' };

export function parseLinksYaml(text: string): LinkSite[] {
  const out: LinkSite[] = [];
  let kind: FriendKindKey | null = null;
  let cur: LinkSite | null = null;
  const flush = () => {
    if (cur?.url) out.push(cur);
    cur = null;
  };
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const section = /^([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (section && line.search(/^\S/) === 0) {
      flush();
      kind = SECTIONS[section[1]!] ?? null;
      continue;
    }
    if (!kind) continue;

    const item = /^\s*-\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (item) {
      flush();
      cur = { name: '', url: '', icon: '', image: '', email: '', rss: '', kind };
      assign(cur, item[1]!, item[2]!);
      continue;
    }
    const field = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (field && cur) assign(cur, field[1]!, field[2]!);
  }
  flush();
  return out;
}

function assign(site: LinkSite, key: string, value: string): void {
  const v = scalarValue(value);
  if (!v) return;
  if (key === 'name') site.name = v;
  else if (key === 'url') site.url = v;
  else if (key === 'icon') site.icon = v;
  else if (key === 'image') site.image = v;
  else if (key === 'email') site.email = v;
  else if (key === 'rss') site.rss = v;
}
