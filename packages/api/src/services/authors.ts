/**
 * services/authors.ts —— 作者资料表 data/authors.yaml 的读与写。
 *
 * 前台（zero-theme 的 author-box / author-contacts / donate-modal）按 Hugo 的 data 目录
 * 读这个文件，键就是文章 front matter 里 author 写的作者标识（users.handle）。
 * 作者认证通过后，后台把申请资料写进这里；后台还可以直接读写整份文本做手工修订。
 *
 * YAML 只实现这个文件用得到的子集，零依赖、Workers 直接能跑：
 *   两空格缩进的映射 / 块序列（标量项与内联映射项）/ 行内 [] 与 {} /
 *   标量（双引号或单引号字符串、布尔、数字、null）/ 字面量块 | 与 >。
 * 注释：文档开头的说明块、每个顶层作者条目上方的注释块会原样保留；
 *   条目内部的注释与行尾注释在重写时丢弃 —— 字段值一个都不丢。
 * 序列化：字符串一律加双引号、缩进两空格、字段按 AUTHOR_FIELD_ORDER 输出，
 *   未知字段按原顺序跟在后面，所以 parse → serialize 对现网文件是恒等的。
 */

import { getConfig } from './config';
import { configuredSiteName } from './site-name';
import { readRepoFile, writeRepoFile, type RepoBackend, type RepoFileResult } from './repo';
import type { AuditAction } from './audit';
import { canonHandle } from '../lib/slug';
import { isEmail } from '../lib/avatar';
import { kvGet, kvPut } from './kv-cache';

/* ------------------------------------------------------------------ 类型 */

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

/** 一个作者的资料：已知的八股 + 后台手工加的任意字段都原样保留 */
export interface AuthorProfile {
  name?: string;
  avatar?: string;
  email?: string;
  bio_zh?: string;
  website?: string;
  verified?: boolean;
  social?: { [key: string]: YamlValue } | YamlValue[];
  donate?: YamlValue[];
  [key: string]: YamlValue | undefined;
}

/** 作者标识 → 资料 */
export interface AuthorsMap {
  [handle: string]: AuthorProfile;
}

/** 社交条目：申请里的 { platform, handle, proof } 与 yaml 里的 { name|platform, url, icon } 都吃 */
export interface AuthorSocialRow {
  platform?: string | null;
  name?: string | null;
  key?: string | null;
  handle?: string | null;
  url?: string | null;
  link?: string | null;
  proof?: string | null;
  icon?: string | null;
}

export type AuthorSocialInput =
  | { [platform: string]: string | number | boolean | null | undefined }
  | readonly (AuthorSocialRow | null | undefined)[]
  | null
  | undefined;

export interface UpsertAuthorInput {
  /** 作者标识：yaml 的键，也是 /author/<标识>/ 与 front matter 的 author */
  handle: string;
  name: string;
  avatar: string;
  email: string;
  bioZh?: string | null;
  website?: string | null;
  verified?: boolean;
  social?: AuthorSocialInput;
  donate?: readonly (string | null | undefined)[] | null;
}

export interface UpsertAuthorResult {
  path: string;
  /** false = 覆盖了这个标识已有的资料 */
  created: boolean;
  backend: RepoBackend;
  sha: string | null;
  bytes: number;
}

export interface AuthorsFileState {
  path: string;
  exists: boolean;
  content: string;
  sha: string;
}

export interface AuthorsWriteOptions {
  message?: string;
  actor?: { id?: string | null; name?: string | null } | null;
  ip?: string;
  action?: AuditAction;
  /** false = 不写审计（调用方自己记了更详细的流水）；本地后端默认会记一条 */
  audit?: boolean;
}

export const AUTHORS_FILE_DEFAULT = 'data/authors.yaml';

/** 字段顺序：与站点现有 authors.yaml 的写法一致，新字段一律排在后面 */
export const AUTHOR_FIELD_ORDER = ['name', 'avatar', 'email', 'bio_zh', 'website', 'verified', 'social', 'donate'] as const;

/** 赞赏图上限，与文件头的说明、账号端表单的校验保持一致 */
export const DONATE_MAX = 3;

/* ------------------------------------------------------------------ 注释留档 */

/** parse 时看到的文档头/文档尾注释块，serialize 原样放回（WeakMap 免得污染返回给调用方的对象） */
const docNotes = new WeakMap<object, { header: string[]; footer: string[] }>();
/** 顶层作者条目上方的注释块 */
const entryNotes = new WeakMap<object, string[]>();
/** 顶层写的不是映射（手滑写成了标量或列表）时，值暂存在这个键里，序列化时原样写回 */
const TOP_LEVEL_RAW_KEY = '__value';

/* ------------------------------------------------------------------ 解析 */

interface DocEntry {
  indent: number;
  text: string;
  notes: string[];
}

export function parseAuthorsYaml(text: string): AuthorsMap {
  const raw = String(text ?? '');
  // 行首 BOM 用码位判断，免得正则里塞一个看不见的字符
  const src = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, '\n').replace(/\t/g, '  ');
  const { entries, header, footer } = scanLines(src);
  const map: AuthorsMap = {};
  docNotes.set(map, { header, footer });
  if (!entries.length) return map;

  const base = Math.min(...entries.map((e) => e.indent));
  const body = base === 0 ? entries : entries.map((e) => ({ ...e, indent: e.indent - base }));
  const notesOut = new Map<string, string[]>();
  const parsed = parseMap(body, 0, body[0]!.indent, notesOut);
  for (const [key, value] of Object.entries(parsed.value)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const profile = value as AuthorProfile;
      const notes = notesOut.get(key);
      if (notes?.length) entryNotes.set(profile, notes);
      map[key] = profile;
      continue;
    }
    // 顶层出现标量 / 序列（手写的怪东西）：拿 __value 存住原值，序列化时写回同一行，绝不丢
    map[key] = { __value: value ?? null };
  }
  return map;
}

/**
 * 整份保存前的体检：认不出的行回一句中文说明，全认得回 null。
 * parseAuthorsYaml 对外手写的怪东西是宽容的（宁可留原值也不报错），
 * 后台「保存作者表」这一步却要把话说清楚，免得写进去一份前台渲染不出来的文件。
 */
/**
 * 值以 `{` 或 `[` 开头时的括号配平（可跨行）。
 *
 * 为什么需要：作者表用的是自家行扫描，`x: {`、`tags: [a, b` 这类**流式映射/数组没闭合**的写法
 * 我们认成普通键值放行，而 go-yaml 直接 `failed to load data` → 整站构建失败。
 * 这里只查"值以流式括号开头"的那些，普通文本里的花括号不碰（YAML 的 plain scalar 允许它们，
 * 判严了会误伤作者简介里的大括号）。
 */
function flowBracketProblem(raw: string): string | null {
  const lines = String(raw ?? '').replace(/\r\n/g, '\n').replace(/\t/g, '  ').split('\n');
  /** >=0 表示正处于块标量（| / >）里：缩进比它深的行都是内容，整行跳过 */
  let blockIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (blockIndent >= 0) {
      if (indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (trimmed.startsWith('#')) continue;
    const body = stripInlineComment(trimmed);
    if (!body) continue;
    /* 块标量开头：`key: |`、`key: >-`、`- >2` —— 后面的行都是字面内容 */
    if (/(^|:\s*|-\s*)[|>][+\-]?\d*\s*$/.test(body)) {
      blockIndent = indent;
      continue;
    }

    const kv = splitKeyValue(body);
    const value = (kv ? kv.value : isSeqItem(body) ? body.replace(/^-\s*/, '') : '').trim();
    const open = value[0];
    if (open !== '{' && open !== '[') continue;

    /* 从这一行的 `{` / `[` 开始，逐字符配对，可以跨行 */
    const stack: string[] = [];
    let quote: string | null = null;
    let done = false;
    for (let li = i; li < lines.length && !done; li++) {
      const text = li === i ? lines[li]! : lines[li]!;
      const from = li === i ? text.indexOf(open) : 0;
      for (let ci = from; ci < text.length; ci++) {
        const ch = text[ci]!;
        if (quote) {
          if (ch === '\\' && quote === '"') { ci++; continue; }
          if (ch === quote) quote = null;
          continue;
        }
        if (ch === '#' && (ci === 0 || /[\s]/.test(text[ci - 1]!))) break; // 行内注释到行尾
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '{' || ch === '[') { stack.push(ch); continue; }
        if (ch === '}' || ch === ']') {
          const top = stack.pop();
          if ((ch === '}' && top !== '{') || (ch === ']' && top !== '[')) {
            return `第 ${i + 1} 行的流式括号对不上：${trimmed.slice(0, 60)}`;
          }
          if (!stack.length) { done = true; break; }
        }
      }
    }
    if (!done) return `第 ${i + 1} 行的流式映射/数组没闭合（go-yaml 会整站构建失败）：${trimmed.slice(0, 60)}`;
  }
  return null;
}

/**
 * 缩进里出现 tab：我们的扫描把 tab 当两个空格容错，go-yaml 却直接报
 * `found a tab character that violates indentation` → 整站构建失败。
 * 块标量（| / >）内容里的 tab 合法，跳过；行内（值或注释里）的 tab 也不管。
 */
function tabIndentProblem(raw: string): string | null {
  const lines = String(raw ?? '').replace(/\r\n/g, '\n').split('\n');
  let blockIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (indent > blockIndent) continue;
      blockIndent = -1;
    }
    const body = stripInlineComment(line.trim());
    if (!body) continue;
    if (/(^|:\s*|-\s*)[|>][+\-]?\d*\s*$/.test(body)) blockIndent = indent;
    if (/^[ ]*\t/.test(line)) return `第 ${i + 1} 行的缩进里有 tab（YAML 只认空格，go-yaml 会整站构建失败）`;
  }
  return null;
}

/**
 * 重复的键：go-yaml（yaml.v3）对同一层映射里重复出现的键直接报
 * `mapping key ... already defined` → 整站构建失败。同层 = 同一个父块下、同一个缩进；
 * 两位作者各自写一份 `social:` 不算重复（各有各的父块）。
 */
function duplicateKeyProblem(raw: string): string | null {
  const lines = String(raw ?? '').replace(/\r\n/g, '\n').replace(/\t/g, '  ').split('\n');
  interface Scope { indent: number; keys: Set<string> }
  const stack: Scope[] = [];
  let blockIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (indent > blockIndent) continue;
      blockIndent = -1;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    const body = stripInlineComment(trimmed);
    if (!body) continue;
    if (/(^|:\s*|-\s*)[|>][+\-]?\d*\s*$/.test(body)) {
      blockIndent = indent;
      continue;
    }
    const isSeq = isSeqItem(body);
    const rest = isSeq ? body.replace(/^-\s*/, '') : body;
    const kv = splitKeyValue(rest);
    if (!kv) continue;
    const keyIndent = isSeq ? indent + 2 : indent;

    while (stack.length && stack[stack.length - 1]!.indent > keyIndent) stack.pop();
    let scope = stack[stack.length - 1];
    if (!scope || scope.indent < keyIndent) {
      scope = { indent: keyIndent, keys: new Set() };
      stack.push(scope);
    }
    if (scope.keys.has(kv.key)) return `第 ${i + 1} 行的键「${kv.key}」重复了（go-yaml 会整站构建失败）`;
    scope.keys.add(kv.key);
  }
  return null;
}

export function validateAuthorsYaml(text: string): string | null {
  const raw = String(text ?? '').replace(/\r\n/g, '\n');
  const contentLines = raw.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!contentLines.length) return null; // 只有注释或空文件：当作空表放行，前台自己回退

  // 先查这两条「我们认、go-yaml 不认」的写法，再查流式括号
  const tabBad = tabIndentProblem(raw);
  if (tabBad) return tabBad;
  const dupBad = duplicateKeyProblem(raw);
  if (dupBad) return dupBad;

  const flowBad = flowBracketProblem(raw);
  if (flowBad) return flowBad;

  const entries = scanLines(raw.replace(/\t/g, '  ')).entries;
  if (!entries.length) return '一行作者条目都没认出来：顶层要写成「作者标识:」，资料缩进两空格';
  const base = Math.min(...entries.map((e) => e.indent));

  for (const e of entries) {
    if (unclosedQuote(e.text)) return `引号没闭合：${e.text}`;
    if ((e.indent - base) % 2 !== 0) return `缩进不是两空格一档：${e.text}`;
    if (e.indent !== base) continue;
    if (isSeqItem(e.text)) return `顶层得是「作者标识: 资料」，不能用短横列表：${e.text}`;
    if (!splitKeyValue(e.text)) return `这一行缺冒号或写法认不出来：${e.text}`;
  }
  if (!Object.keys(parseAuthorsYaml(raw)).length) return '解析出来是空表：顶层得是「作者标识: 资料」';
  return null;
}

/** 只看值起始位置的引号（`name: "a"` 里的双引号），普通句子里的中单引号不算开引号 */
function unclosedQuote(line: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && (i === 0 || /[:\s]/.test(line[i - 1]!))) quote = ch;
  }
  return Boolean(quote);
}

/** 逐行扫描：注释块挂到它下面的第一条内容行；第一行内容之前的注释块是文档头 */
function scanLines(src: string): { entries: DocEntry[]; header: string[]; footer: string[] } {
  const lines = src.split('\n');
  const entries: DocEntry[] = [];
  const pending: string[] = [];
  const header: string[] = [];
  let headerDone = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // 只有正在攒注释、或还没出现任何内容行时才记住空行，其余交给序列化统一补
      if (!headerDone || pending.length) pending.push('');
      continue;
    }
    if (trimmed.startsWith('#')) {
      pending.push(line);
      continue;
    }
    const body = stripInlineComment(trimmed);
    if (!body) continue;
    const notes = trimTrailingBlank(pending);
    pending.length = 0;
    if (!headerDone) {
      header.push(...notes);
      headerDone = true;
      entries.push({ indent: leadingWidth(line), text: body, notes: [] });
      continue;
    }
    entries.push({ indent: leadingWidth(line), text: body, notes });
  }

  return { entries, header: trimTrailingBlank(header), footer: trimTrailingBlank(pending) };
}

function leadingWidth(line: string): number {
  return line.length - line.trimStart().length;
}

function trimTrailingBlank(list: string[]): string[] {
  let end = list.length;
  while (end > 0 && !list[end - 1]!.trim()) end--;
  return list.slice(0, end);
}

/** 去掉值后面的 ` # 注释`，引号里的 # 不算 */
function stripInlineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i).trimEnd();
  }
  return line;
}

function isSeqItem(text: string): boolean {
  return /^-(\s|$)/.test(text);
}

function parseBlock(entries: DocEntry[], start: number, level: number, notesOut?: Map<string, string[]>): { value: YamlValue; next: number } {
  if (isSeqItem(entries[start]!.text)) return parseSeq(entries, start, level);
  return parseMap(entries, start, level, notesOut);
}

function parseMap(
  entries: DocEntry[],
  start: number,
  level: number,
  notesOut?: Map<string, string[]>,
): { value: Record<string, YamlValue>; next: number } {
  const obj: Record<string, YamlValue> = {};
  let i = start;
  while (i < entries.length) {
    const e = entries[i]!;
    if (e.indent < level) break;
    if (e.indent > level || isSeqItem(e.text)) {
      i++;
      continue; // 缩进对不上或映射里混了序列项：跳过这一行，别把整份文件判死
    }
    const kv = splitKeyValue(e.text);
    if (!kv) {
      i++;
      continue;
    }
    if (kv.key && notesOut && e.notes.length) notesOut.set(kv.key, e.notes);

    if (kv.value === '') {
      const child = entries[i + 1];
      if (child && child.indent > level) {
        const r = parseBlock(entries, i + 1, child.indent);
        obj[kv.key] = r.value;
        i = r.next;
        continue;
      }
      if (child && child.indent === level && isSeqItem(child.text)) {
        const r = parseSeq(entries, i + 1, level);
        obj[kv.key] = r.value;
        i = r.next;
        continue;
      }
      obj[kv.key] = null;
      i++;
      continue;
    }

    const block = /^([|>])([-+]?\d*)$/.exec(kv.value);
    if (block) {
      const folded = block[1] === '>';
      const parts: string[] = [];
      let j = i + 1;
      while (j < entries.length && entries[j]!.indent > level) {
        parts.push(entries[j]!.text);
        j++;
      }
      obj[kv.key] = parts.join(folded ? ' ' : '\n');
      i = j;
      continue;
    }

    obj[kv.key] = parseInline(kv.value);
    i++;
  }
  return { value: obj, next: i };
}

function parseSeq(entries: DocEntry[], start: number, level: number): { value: YamlValue[]; next: number } {
  const arr: YamlValue[] = [];
  let i = start;
  while (i < entries.length) {
    const e = entries[i]!;
    if (e.indent !== level || !isSeqItem(e.text)) break;
    const afterDash = e.text.slice(1);
    const spaces = afterDash.length - afterDash.trimStart().length;
    const rest = afterDash.trim();
    const keyCol = e.indent + 1 + Math.max(1, spaces);

    if (!rest) {
      const child = entries[i + 1];
      if (child && child.indent > level) {
        const r = parseBlock(entries, i + 1, child.indent);
        arr.push(r.value);
        i = r.next;
        continue;
      }
      arr.push(null);
      i++;
      continue;
    }

    // `- name: "GitHub"`：这一行的余下部分和后续更深缩进的行共同组成一个映射
    if (splitKeyValue(rest)) {
      const sub: DocEntry[] = [{ indent: 0, text: rest, notes: [] }];
      let j = i + 1;
      while (j < entries.length && entries[j]!.indent > level && !isSeqItem(entries[j]!.text)) {
        sub.push({ indent: Math.max(0, entries[j]!.indent - keyCol), text: entries[j]!.text, notes: [] });
        j++;
      }
      arr.push(parseMap(sub, 0, 0).value);
      i = j;
      continue;
    }

    arr.push(parseInline(rest));
    i++;
  }
  return { value: arr, next: i };
}

/** `key: value` → 键与余下值；值里的冒号（URL）不会被当成键值分隔符 */
function splitKeyValue(text: string): { key: string; value: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && i > 0 && /\s/.test(text[i - 1]!)) break;
    if (ch === ':' && (i + 1 >= text.length || text[i + 1] === ' ')) {
      const key = unquoteScalar(text.slice(0, i).trim());
      if (!key) return null;
      return { key, value: text.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseInline(raw: string): YamlValue {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return parseFlow(s);
    } catch {
      return s; // 行内写坏了就当成字符串存着，至少不丢
    }
  }
  return parseScalar(s);
}

/** 行内 [] / {} —— 够前台与后台手写的行内写法用 */
function parseFlow(raw: string): YamlValue {
  const st = { i: 0 };
  const value = readFlowNode(raw, st, '');
  return value;
}

function skipSpace(raw: string, st: { i: number }): void {
  while (st.i < raw.length && /\s/.test(raw[st.i]!)) st.i++;
}

function readFlowNode(raw: string, st: { i: number }, stops: string): YamlValue {
  skipSpace(raw, st);
  const ch = raw[st.i];
  if (ch === '[') {
    st.i++;
    const arr: YamlValue[] = [];
    skipSpace(raw, st);
    while (st.i < raw.length && raw[st.i] !== ']') {
      arr.push(readFlowNode(raw, st, ',]'));
      skipSpace(raw, st);
      if (raw[st.i] === ',') st.i++;
      skipSpace(raw, st);
    }
    st.i++;
    return arr;
  }
  if (ch === '{') {
    st.i++;
    const obj: Record<string, YamlValue> = {};
    skipSpace(raw, st);
    while (st.i < raw.length && raw[st.i] !== '}') {
      const key = unquoteScalar(readFlowToken(raw, st, ':,'));
      skipSpace(raw, st);
      if (raw[st.i] === ':') st.i++;
      if (key) obj[key] = readFlowNode(raw, st, ',}');
      skipSpace(raw, st);
      if (raw[st.i] === ',') st.i++;
      skipSpace(raw, st);
    }
    st.i++;
    return obj;
  }
  return parseScalar(readFlowToken(raw, st, stops).trim());
}

function readFlowToken(raw: string, st: { i: number }, stops: string): string {
  skipSpace(raw, st);
  const first = raw[st.i];
  if (first === '"' || first === "'") {
    const start = st.i;
    st.i++;
    while (st.i < raw.length && raw[st.i] !== first) {
      if (raw[st.i] === '\\' && first === '"') st.i++;
      st.i++;
    }
    st.i++;
    return unquoteScalar(raw.slice(start, st.i));
  }
  let out = '';
  while (st.i < raw.length && !stops.includes(raw[st.i]!)) {
    out += raw[st.i];
    st.i++;
  }
  return out.trim();
}

function unquoteScalar(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if (a === '"' && b === '"') {
      try {
        return JSON.parse(t) as string;
      } catch {
        return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    if (a === "'" && b === "'") return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

function parseScalar(s: string): YamlScalar {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return unquoteScalar(t);
  if (!t || /^(null|~)$/i.test(t)) return null;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^[+-]?\d+$/.test(t)) return Number(t);
  if (/^[+-]?\d*\.\d+$/.test(t)) return Number(t);
  return unquoteScalar(t);
}

/* ------------------------------------------------------------------ 序列化 */

export function serializeAuthorsYaml(map: AuthorsMap): string {
  const lines: string[] = [];
  const notes = map ? docNotes.get(map) : undefined;
  const header = notes?.header ?? [];
  if (header.length) lines.push(header.join('\n'));

  for (const [key, profile] of Object.entries(map ?? {})) {
    if (lines.length) lines.push('');
    const block = profile ? entryNotes.get(profile) : undefined;
    if (block?.length) lines.push(block.join('\n'));
    const fields = profile ? orderedFields(profile) : [];
    if (fields.length === 1 && fields[0]!.key === TOP_LEVEL_RAW_KEY) {
      // 顶层标量 / 序列：写回同一行，形状跟进来时一致
      const out = itemValueOut(fields[0]!.value);
      lines.push(out ? `${serializeKey(key)}: ${out}` : `${serializeKey(key)}:`);
      continue;
    }
    if (!fields.length) {
      lines.push(`${serializeKey(key)}: {}`);
      continue;
    }
    lines.push(`${serializeKey(key)}:`);
    for (const field of fields) emitPair(lines, field.key, field.value, 1);
  }

  const footer = notes?.footer ?? [];
  if (footer.length) {
    if (lines.length) lines.push('');
    lines.push(footer.join('\n'));
  }
  if (!lines.length) return '';
  return `${lines.join('\n')}\n`;
}

/** 已知字段按 AUTHOR_FIELD_ORDER，其余按对象里的原顺序跟在后面：同一份资料两次序列化结果一致 */
function orderedFields(profile: AuthorProfile): { key: string; value: YamlValue }[] {
  const out: { key: string; value: YamlValue }[] = [];
  const seen = new Set<string>();
  const keys = Object.keys(profile);
  for (const key of [...AUTHOR_FIELD_ORDER, ...keys]) {
    if (seen.has(key) || !keys.includes(key)) continue;
    seen.add(key);
    const value = profile[key];
    if (value === undefined) continue;
    out.push({ key, value: value as YamlValue });
  }
  return out;
}

/** key: value（值可以是标量、序列、映射），缩进两空格一层 */
function emitPair(lines: string[], key: string, value: YamlValue, depth: number): void {
  const pad = '  '.repeat(depth);
  const k = serializeKey(key);

  if (Array.isArray(value)) {
    if (!value.length) {
      lines.push(`${pad}${k}: []`);
      return;
    }
    lines.push(`${pad}${k}:`);
    for (const item of value) emitItem(lines, item, depth);
    return;
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) {
      lines.push(`${pad}${k}: {}`);
      return;
    }
    lines.push(`${pad}${k}:`);
    for (const [childKey, childValue] of entries) emitPair(lines, childKey, childValue, depth + 1);
    return;
  }

  const out = scalarOut(value as YamlScalar);
  lines.push(out ? `${pad}${k}: ${out}` : `${pad}${k}:`);
}

/** 序列项：标量直接跟短横；映射把第一对写在短横后，其余对齐；再深的结构走行内 */
function emitItem(lines: string[], item: YamlValue, depth: number): void {
  const pad = '  '.repeat(depth);
  if (item && typeof item === 'object') {
    if (Array.isArray(item)) {
      lines.push(`${pad}  - ${flowOut(item)}`);
      return;
    }
    const entries = Object.entries(item).filter(([, v]) => v !== undefined);
    if (!entries.length) {
      lines.push(`${pad}  - {}`);
      return;
    }
    lines.push(`${pad}  - ${serializeKey(entries[0]![0])}: ${itemValueOut(entries[0]![1])}`);
    for (const [key, value] of entries.slice(1)) lines.push(`${pad}    ${serializeKey(key)}: ${itemValueOut(value)}`);
    return;
  }
  const out = scalarOut(item as YamlScalar);
  lines.push(out ? `${pad}  - ${out}` : `${pad}  -`);
}

function itemValueOut(value: YamlValue): string {
  if (value && typeof value === 'object') return flowOut(value);
  return scalarOut(value as YamlScalar);
}

/** JSON 本身就是合法的 YAML 流式写法，嵌套结构用它兜底，绝不写坏 */
function flowOut(value: YamlValue): string {
  return JSON.stringify(value ?? null);
}

function serializeKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/** 字符串一律加引号：现网的 authors.yaml 就是这么写的，也免得冒号 / 井号要特判 */
function scalarOut(value: YamlScalar): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

/* ------------------------------------------------------------------ 写回 */

/** 作者文件路径：后台配置 githubAuthorsFile，缺省 data/authors.yaml */
export async function authorsFilePath(env: Env): Promise<string> {
  const configured = (await getConfig(env, 'githubAuthorsFile')) ?? AUTHORS_FILE_DEFAULT;
  const clean = String(configured).replace(/\\/g, '/').replace(/^\/+/, '');
  return clean || AUTHORS_FILE_DEFAULT;
}

export async function getAuthorsFile(env: Env): Promise<AuthorsFileState> {
  const path = await authorsFilePath(env);
  const file = await readRepoFile(env, path);
  return { path, exists: Boolean(file), content: file?.content ?? '', sha: file?.sha ?? '' };
}

/** 读一位作者的资料；文件没这份或没登记这个标识时回 null（调用方自己决定兜底） */
export async function readAuthorProfile(env: Env, handle: string): Promise<AuthorProfile | null> {
  const clean = resolveAuthorHandle(handle);
  if (!clean) return null;
  const file = await readRepoFile(env, await authorsFilePath(env));
  if (!file) return null;
  return parseAuthorsYaml(file.content)[clean] ?? null;
}

/**
 * 署名为「站方」的场合（邮件落款、新评论提醒里的作者名、后台邮件预览）取名字的顺序：
 * config.author（后台手填）> 站长作者资料 data/authors.yaml > 站点名。
 */
export async function siteAuthorName(env: Env): Promise<string> {
  const fromConfig = ((await getConfig(env, 'author')) ?? '').trim();
  if (fromConfig) return fromConfig;
  const fromProfile = ((await ownerAuthorProfile(env))?.name ?? '').trim();
  if (fromProfile) return fromProfile;
  return await configuredSiteName(env);
}
export async function ownerAuthorProfile(env: Env): Promise<AuthorProfile | null> {
  const preferred = ((await getConfig(env, 'defaultAuthor')) ?? '').trim();
  if (preferred) {
    const hit = await readAuthorProfile(env, preferred);
    if (hit) return hit;
  }
  return null;
}

/** 整份覆盖：后台「作者文件」编辑器用，调用方自己保证文本能解析 */
export async function putAuthorsFile(env: Env, text: string, opts: AuthorsWriteOptions = {}): Promise<RepoFileResult> {
  const path = await authorsFilePath(env);
  const message = (opts.message ?? '').trim() || `zero-cms: 更新作者资料表 ${path}`;
  // 写之前留一份旧文本：作者表是「一键清空全站署名」最容易发生的地方，后台要能一键退回去
  const before = await readRepoFile(env, path).catch(() => null);
  if (before && before.content !== String(text ?? '')) {
    await saveAuthorsSnapshot(env, {
      path,
      content: before.content,
      sha: before.sha ?? '',
      savedAt: new Date().toISOString(),
      actor: String(opts.actor?.name ?? opts.actor?.id ?? '').slice(0, 80),
      reason: message.slice(0, 160),
    });
  }
  return writeRepoFile(env, path, String(text ?? ''), message, {
    actor: opts.actor ?? null,
    ip: opts.ip,
    action: opts.action ?? 'authorRequest',
    audit: opts.audit,
  });
}

/* ---------------------------------------------------- 上一次保存的快照（可撤销） */

/** 只留最近一份：撤销是「刚才那次保存写坏了」的应急出口，不需要历史版本树 */
const AUTHORS_PREV_KEY = 'zero:authors:prev';
const AUTHORS_PREV_TTL = 30 * 24 * 60 * 60;

export interface AuthorsSnapshot {
  path: string;
  content: string;
  sha: string;
  savedAt: string;
  actor?: string;
  reason?: string;
}

export async function readAuthorsSnapshot(env: Env): Promise<AuthorsSnapshot | null> {
  const value = await kvGet(env, AUTHORS_PREV_KEY);
  if (!value || typeof value !== 'object') return null;
  const s = value as Partial<AuthorsSnapshot>;
  if (typeof s.content !== 'string' || !s.content.trim()) return null;
  return {
    path: String(s.path ?? AUTHORS_FILE_DEFAULT),
    content: s.content,
    sha: String(s.sha ?? ''),
    savedAt: String(s.savedAt ?? ''),
    actor: s.actor ? String(s.actor) : undefined,
    reason: s.reason ? String(s.reason) : undefined,
  };
}

async function saveAuthorsSnapshot(env: Env, snapshot: AuthorsSnapshot): Promise<void> {
  await kvPut(env, AUTHORS_PREV_KEY, snapshot, AUTHORS_PREV_TTL);
}

/** 撤销接口用：把快照文本写回仓库（写入本身会再留一份「撤销前」的快照，撤销错了还能再改回来） */
export async function restoreAuthorsSnapshot(env: Env, opts: AuthorsWriteOptions = {}): Promise<{ result: RepoFileResult; snapshot: AuthorsSnapshot }> {
  const snapshot = await readAuthorsSnapshot(env);
  if (!snapshot) throw new Error('没有可撤销的上一次保存（快照只保留最近一次，且最多 30 天）');
  const problem = validateAuthorsYaml(snapshot.content);
  if (problem) throw new Error(`上一次保存的快照本身解析失败，未写回：${problem}`);
  const result = await putAuthorsFile(env, snapshot.content, {
    ...opts,
    message: (opts.message ?? '').trim() || `zero-cms: 撤销上一次作者表保存${snapshot.savedAt ? `（回到 ${snapshot.savedAt}）` : ''}`,
  });
  if (!result.success) throw new Error(result.error ?? '作者表写回失败');
  return { result, snapshot };
}

/**
 * 认证通过后写进作者表：已存在的标识合并更新（没给的字段保留原值），不存在就新建。
 * 校验用中文 Error 抛出，让调用方决定是打断审核还是回一条 authorFile.ok = false。
 */
export async function upsertAuthor(env: Env, a: UpsertAuthorInput, opts: AuthorsWriteOptions = {}): Promise<UpsertAuthorResult> {
  const handle = resolveAuthorHandle(a.handle);
  const path = await authorsFilePath(env);
  const file = await readRepoFile(env, path);
  const map: AuthorsMap = file ? parseAuthorsYaml(file.content) : {};
  const previous = map[handle];
  const created = !previous;

  map[handle] = buildAuthorProfile(previous, a);
  const content = serializeAuthorsYaml(map);
  const result = await putAuthorsFile(env, content, {
    ...opts,
    message: (opts.message ?? '').trim() || `zero-cms: 作者认证写入 ${path}（${handle}）`,
  });
  if (!result.success) throw new Error(result.error ?? `作者资料写入失败：${path}`);
  return { path, created, backend: result.backend, sha: result.sha ?? null, bytes: content.length };
}

/**
 * 合成一个作者条目：name / avatar / email 缺任一项抛中文错误（需求 6.7 的必填三项），
 * 其余字段没给就不写这个键，给了就覆盖；已有条目里没被涉及的键原样留着。
 */
export function buildAuthorProfile(previous: AuthorProfile | undefined, a: UpsertAuthorInput): AuthorProfile {
  const name = cleanText(a.name);
  const avatar = cleanText(a.avatar);
  const email = cleanText(a.email);
  if (!name) throw new Error('作者昵称（name）必填：资料里没取到昵称，无法写入作者表');
  if (!avatar) throw new Error('作者头像（avatar）必填：申请留空时应当用邮箱头像地址兜底');
  if (!email) throw new Error('作者邮箱（email）必填');
  if (!isEmail(email)) throw new Error(`作者邮箱格式不对：${email}`);

  const profile: AuthorProfile = { ...(previous ?? {}) };
  profile.name = name;
  profile.avatar = avatar;
  profile.email = email;
  putField(profile, 'bio_zh', a.bioZh);
  putField(profile, 'website', a.website);
  if (a.verified !== undefined) profile.verified = Boolean(a.verified);

  const social = normalizeSocial(a.social);
  if (Object.keys(social).length) profile.social = social;
  const donate = normalizeDonate(a.donate);
  if (donate.length) profile.donate = donate;
  return profile;
}

/** 标识必须是小写字母 / 数字 / 短横线；脏值先过 canonHandle 兜底，兜不出东西就直接报错 */
export function resolveAuthorHandle(raw: string): string {
  const s = cleanText(raw);
  if (!s) throw new Error('作者标识（handle）必填，否则作者表里没地方放这份资料');
  if (/^[a-z0-9-]+$/.test(s)) return s;
  const canon = canonHandle(s);
  if (!canon) throw new Error(`作者标识只能用英文小写字母、数字和短横线：${s}`);
  return canon;
}

function cleanText(value: unknown): string {
  return String(value ?? '').trim();
}

/** 取第一个真正填了的：空串与 undefined 都算没填（申请里的 proof 留空时是空串，不是缺失） */
function firstText(...values: readonly (string | null | undefined)[]): string {
  for (const value of values) {
    const s = cleanText(value);
    if (s) return s;
  }
  return '';
}

/** 不给（或给的是空串）就不写这个键：前端按「没有这一行」渲染，比塞空串干净 */
function putField(profile: AuthorProfile, key: string, value: unknown): void {
  const s = cleanText(value);
  if (s) profile[key] = s;
}

/**
 * 社交方式统一成主题首选的 { 平台: 主页 URL } 映射：
 *   键走别名表（微博 → weibo、Twitter / X → twitter …），认不出就保留原标签，不丢数据；
 *   值优先用可核验链接，其次按平台拼主页地址，拼不出来就只留账号文本。
 */
export function normalizeSocial(input: AuthorSocialInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;

  if (Array.isArray(input)) {
    for (const row of input) {
      if (!row || typeof row !== 'object') continue;
      const key = socialKeyOf(String(row.platform ?? row.name ?? row.key ?? ''));
      if (!key) continue;
      const value = socialValueOf(key, firstText(row.url, row.link, row.proof, row.handle));
      if (value) out[key] = value;
    }
    return out;
  }

  for (const [raw, value] of Object.entries(input)) {
    const key = socialKeyOf(raw);
    if (!key) continue;
    const s = cleanText(value);
    if (!s) continue;
    // 映射写法里的值本来就是作者表里的成品（URL 或账号文本），原样留着
    out[key] = s;
  }
  return out;
}

const SOCIAL_ALIASES: Record<string, string> = {
  微博: 'weibo',
  weibo: 'weibo',
  sina: 'weibo',
  b站: 'bilibili',
  'b 站': 'bilibili',
  bilibili: 'bilibili',
  哔哩哔哩: 'bilibili',
  知乎: 'zhihu',
  zhihu: 'zhihu',
  instagram: 'instagram',
  ins: 'instagram',
  twitter: 'twitter',
  'twitter / x': 'twitter',
  'x / twitter': 'twitter',
  x: 'twitter',
  facebook: 'facebook',
  fb: 'facebook',
  telegram: 'telegram',
  tg: 'telegram',
  github: 'github',
  gitlab: 'gitlab',
  gitee: 'gitee',
  email: 'email',
  'e-mail': 'email',
  邮箱: 'email',
  邮件: 'email',
  '邮箱 / 其它': 'email',
  小红书: 'xiaohongshu',
  xiaohongshu: 'xiaohongshu',
  mastodon: 'mastodon',
};

/** 平台名 → 主题认识的键；认不出保留原样（序列化时会自动加引号） */
export function socialKeyOf(raw: string): string {
  const s = cleanText(raw).replace(/\s+/g, ' ');
  if (!s) return '';
  const hit = SOCIAL_ALIASES[s.toLowerCase()];
  if (hit) return hit;
  return /^[a-z0-9_-]+$/i.test(s) ? s.toLowerCase() : s;
}

const SOCIAL_HOMEpages: Record<string, (handle: string) => string> = {
  github: (h) => `https://github.com/${h}`,
  gitlab: (h) => `https://gitlab.com/${h}`,
  gitee: (h) => `https://gitee.com/${h}`,
  twitter: (h) => `https://x.com/${h}`,
  instagram: (h) => `https://www.instagram.com/${h}`,
  facebook: (h) => `https://www.facebook.com/${h}`,
  telegram: (h) => `https://t.me/${h}`,
  zhihu: (h) => `https://www.zhihu.com/people/${h}`,
  bilibili: (h) => (/^\d+$/.test(h) ? `https://space.bilibili.com/${h}` : ''),
  weibo: (h) => (/^\d+$/.test(h) ? `https://weibo.com/u/${h}` : /^[A-Za-z][\w-]{3,}$/.test(h) ? `https://weibo.com/${h}` : ''),
  mastodon: (h) => {
    const m = /^@?([^@\s]+)@([\w.-]+\.\w+)$/.exec(h);
    return m ? `https://${m[2]}/@${m[1]}` : '';
  },
};

function socialValueOf(key: string, raw: string): string {
  const v = cleanText(raw);
  if (!v) return '';
  if (key === 'email') {
    // 邮箱键只收真邮箱：其余文本会拼成 mailto:乱码，而 email 字段本身已经给了主题
    if (/^mailto:/i.test(v)) return decodeURIComponent(v.replace(/^mailto:/i, '')).trim();
    return isEmail(v) ? v : '';
  }
  if (/^(https?:)?\/\//i.test(v)) return /^\/\//.test(v) ? `https:${v}` : v;
  if (/\s/.test(v)) return v; // 带空格的账号拼不出安全 URL，原样留文本
  const builder = SOCIAL_HOMEpages[key];
  const url = builder ? builder(v.replace(/^@/, '')) : '';
  return url || v;
}

function normalizeDonate(list: readonly (string | null | undefined)[] | null | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    const s = cleanText(item);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= DONATE_MAX) break;
  }
  return out;
}
