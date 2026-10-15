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

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
