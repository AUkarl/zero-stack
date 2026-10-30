/**
 * _frontmatter.ts — 文章 front matter 的结构化读写。
 *
 * 只做后台表单需要的那几个键，其余键（comments / type / layout / menus …）原样保留：
 * 保存时按原顺序补在已知键之后，免得后台一改就把站点在用的其它字段弄丢。
 * 键顺序与 zero-site 现有文章保持一致：title → date → description → categories → tags → image → author → toc → math。
 */

/** 已知键：表单直接管理它们 */
const KNOWN_KEYS = [
  'title',
  'subtitle',
  'date',
  /** 后台表单里的「修改时间」；写回时统一用 Hugo 认的键名 lastmod */
  'updated',
  'lastmod',
  'summary',
  'description',
  'categories',
  'tags',
  'image',
  'draft',
  'weight',
  'pinned',
  'author',
  'toc',
  'math',
  /** 只通过链接访问的页面：build / sitemap / robots 三件一起由「隐藏」开关写 */
  'build',
  'sitemap',
  'robots',
] as const;

const KNOWN = new Set<string>(KNOWN_KEYS);

/**
 * 日期键按小写归一。Hugo 读这几个键**不分大小写**（实测 `Date:`、`DATE:`、`Lastmod:` 它都会解析），
 * 后台以前按精确键名读，于是手写成 `Date:` 的文章在表单里是「发布时间空着」，保存时又补一条小写 `date:`，
 * 同一篇里两个日期键 —— 与 `services/hugo-guard.ts` 里那张小写别名表是同一个口径。
 * 只归一表单真的管理的那几个键：`publishDate` / `expiryDate` 这些后台没有输入框，
 * 归一了会把站长手写的值整条丢掉，它们照旧走 extras 原样保留。
 */
const FORM_DATE_KEYS: Record<string, string> = { date: 'date', updated: 'updated', lastmod: 'lastmod' };

export interface PostForm {
  title: string;
  subtitle: string;
  date: string;
  updated: string;
  summary: string;
  description: string;
  categories: string[];
  tags: string[];
  image: string;
  draft: boolean;
  /**
   * Hugo 原生排序权重：升序排，数字越小越靠前；留空表示不写该键。
   * 只能是字符串：输入框是 type=number，用 bind:value 会把数字塞进来，
   * 拼 front matter 时 .trim() 就抛异常，提交还会卡在「提交中」不动。
   */
  weight: string;
  /** 置顶：主题把带这个标记的文章排在首页精选的热度分之前 */
  pinned: boolean;
  author: string;
  toc: boolean;
  math: boolean;
  /** 不在列表 / RSS / sitemap 里出现，只能通过链接访问（build.list=never） */
  hidden: boolean;
}

export function emptyForm(): PostForm {
  return {
    title: '',
    subtitle: '',
    date: '',
    updated: '',
    summary: '',
    description: '',
    categories: [],
    tags: [],
    image: '',
    draft: false,
    weight: '',
    pinned: false,
    author: '',
    toc: true,
    math: false,
    hidden: false,
  };
}

export interface FrontDoc {
  /** 标量键的显示值（已去引号） */
  scalars: Record<string, string>;
  /** 列表键 */
  lists: Record<string, string[]>;
  /** 已知键之外的条目，保序回写；block 是「键: 下面缩进的子行」这类嵌套表，逐字保留 */
  extras: { key: string; value: string; items?: string[]; block?: string[] }[];
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2) {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  }
  return s;
}

/** front 里出现冒号、井号、引号或首尾空格时整体加双引号，否则 Hugo 解析会错位 */
export function yq(v: string): string {
  const s = String(v ?? '');
  if (s === '') return '""';
  if (/^[^:#{}[\]&*!|>%@`"'\s][^:#{}[\]&*!|>%@`"]*$/.test(s) && !/\s$/.test(s)) return s;
  return JSON.stringify(s);
}

function parseInlineList(raw: string): string[] {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((x) => unquote(x.trim()))
    .filter(Boolean);
}

/** 解析 --- 之间的 YAML（不含首尾分隔线） */
export function parseFront(front: string): FrontDoc {
  const doc: FrontDoc = { scalars: {}, lists: {}, extras: [] };
  const lines = front.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) {
      i++;
      continue;
    }
    const m = /^([\w.-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!m) {
      i++;
      continue;
    }
    const key = FORM_DATE_KEYS[m[1].toLowerCase()] ?? m[1];
    const raw = m[2].trim();
    if (raw === '') {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+\S/.test(lines[j])) {
        items.push(unquote(lines[j].trim().slice(1).trim()));
        j++;
      }
      if (items.length) {
        doc.lists[key] = items;
        if (!KNOWN.has(key)) doc.extras.push({ key, value: '', items });
      } else {
        // 缩进的「子键: 值」是嵌套表（link: {url,title,…} 这类），整块原样留着，
        // 否则回写时只剩一个空键，编辑一条时刻就把链接悄悄弄丢了
        const block: string[] = [];
        while (j < lines.length && /^\s+\S/.test(lines[j])) {
          block.push(lines[j]);
          j++;
        }
        if (block.length) {
          if (!KNOWN.has(key)) doc.extras.push({ key, value: '', block });
          const flat: Record<string, string> = {};
          for (const b of block) {
            const mm = /^\s*([\w.-]+)\s*:\s*(.*)$/.exec(b);
            if (mm) flat[mm[1]] = unquote(mm[2]);
          }
          for (const [sk, sv] of Object.entries(flat)) doc.scalars[`${key}.${sk}`] = sv;
        } else if (!KNOWN.has(key)) {
          doc.extras.push({ key, value: raw });
        }
      }
      i = j;
      continue;
    }
    if (/^\[.*\]$/.test(raw)) {
      doc.lists[key] = parseInlineList(raw);
      if (!KNOWN.has(key)) doc.extras.push({ key, value: raw });
      i++;
      continue;
    }
    doc.scalars[key] = unquote(raw);
    if (!KNOWN.has(key)) doc.extras.push({ key, value: raw });
    i++;
  }
  return doc;
}

const scalar = (d: FrontDoc, key: string): string => d.scalars[key] ?? '';
const list = (d: FrontDoc, key: string): string[] => d.lists[key] ?? [];
const bool = (d: FrontDoc, key: string, dflt: boolean): boolean => {
  const v = d.scalars[key];
  if (v === undefined || v === '') return dflt;
  return v === 'true' || v === '1';
};

/** front matter + 正文 → 表单值 */
export function formFromDoc(doc: FrontDoc): PostForm {
  const weight = scalar(doc, 'weight');
  const w = Number.parseInt(weight, 10);
  // 早期用 weight<=0 表示置顶，读到时也算勾上，回写时统一写成 pinned
  const pinnedLegacy = Number.isFinite(w) && w <= 0;
  return {
    title: scalar(doc, 'title'),
    subtitle: scalar(doc, 'subtitle'),
    date: toInputDateTime(scalar(doc, 'date')),
    /* 修改时间：手写的老文章用 lastmod，后台保存写 updated，两个都认，
       回写时统一成 updated（老的那条 lastmod 在 frontFromForm 里被跳过）。 */
    updated: toInputDateTime(scalar(doc, 'updated') || scalar(doc, 'lastmod')),
    summary: scalar(doc, 'summary'),
    description: scalar(doc, 'description'),
    categories: [...list(doc, 'categories')],
    tags: [...list(doc, 'tags')],
    image: scalar(doc, 'image'),
    draft: bool(doc, 'draft', false),
    weight,
    pinned: bool(doc, 'pinned', false) || pinnedLegacy,
    author: scalar(doc, 'author'),
    toc: bool(doc, 'toc', true),
    math: bool(doc, 'math', false),
    /* Hugo 0.145 起 _build 改名为 build；两种写法都认 */
    hidden: (scalar(doc, 'build.list') || scalar(doc, '_build.list')) === 'never',
  };
}

/**
 * 表单值 → front matter 文本。
 * 未在 KNOWN_KEYS 里的原有条目按解析顺序补在后面。
 */
export function frontFromForm(f: PostForm, doc: FrontDoc): string {
  const lines: string[] = [];
  const push = (key: string, value: string) => lines.push(`${key}: ${value}`);
  const pushList = (key: string, items: string[]) => {
    lines.push(`${key}:`);
    for (const it of items) lines.push(`  - ${yq(it)}`);
  };

  if (f.title.trim()) push('title', yq(f.title.trim()));
  if (f.subtitle.trim()) push('subtitle', yq(f.subtitle.trim()));
  if (f.date) push('date', fromDateInput(f.date));
  // Hugo 只按 front matter 的 lastmod 算 .Lastmod（updated 这个键名它不认，实测 0.165 如此），
  // 所以后台的「修改时间」写回 lastmod；读取时 updated / lastmod 都认，老的写法不会丢。
  if (f.updated) push('lastmod', fromDateInput(f.updated));
  push('draft', f.draft ? 'true' : 'false');
  if (f.description.trim()) push('description', yq(f.description.trim()));
  if (f.summary.trim()) push('summary', yq(f.summary.trim()));
  if (f.categories.length) pushList('categories', f.categories);
  if (f.tags.length) pushList('tags', f.tags);
  if (f.image.trim()) push('image', yq(f.image.trim()));
  if (f.author.trim()) push('author', yq(f.author.trim()));
  // form.weight 声明是 string，但历史上一度被 number 输入框写成数字；这里统一按字符串取，
  // 免得哪天又冒出一个不是 string 的值把整个提交流程炸掉
  const weight = String(f.weight ?? '').trim();
  if (weight) push('weight', weight);
  if (f.pinned) push('pinned', 'true');
  push('toc', f.toc ? 'true' : 'false');
  push('math', f.math ? 'true' : 'false');

  /* 「隐藏」开关独占这三件：勾上就写成「建而不列」（只通过链接访问），
     取消就一个都不写。以前它们躺在 extras 里，而 extras 的回写只拼了 `键: 值`、
     没拼嵌套子行 —— 后台一保存，build/sitemap 就变成空键，文章又回到列表里。 */
  if (f.hidden) {
    lines.push('build:', '  list: never', '  render: always');
    lines.push('sitemap:', '  disable: true');
    push('robots', '"noindex, nofollow"');
  }

  for (const e of doc.extras) {
    /* 这三件已经由 hidden 统一管了；旧文件里残留的写法不再原样带回来，免得两份打架 */
    if (e.key === 'build' || e.key === 'sitemap' || e.key === 'robots' || e.key === '_build') continue;
    if (e.items) {
      pushList(e.key, e.items);
      continue;
    }
    if (e.block) {
      /* 嵌套表（menus / outputs / 自己加的段落）：键头 + 原始缩进行一起写回 */
      lines.push(`${e.key}:`);
      for (const b of e.block) lines.push(b);
      continue;
    }
    push(e.key, e.value);
  }
  return lines.join('\n');
}

export function composeFile(front: string, body: string): string {
  const head = front.trim();
  if (!head) return body;
  return `---\n${head.replace(/\n+$/, '')}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/* ---------------- 日期：datetime-local 与 Hugo ISO 互转 ---------------- */

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 表单显示用：截到分钟；无时区的裸时间原样保留 */
export function toInputDateTime(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    const norm = s.replace(' ', 'T');
    return norm.slice(0, 16);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 16);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 写回仓库：补秒并带上本地时区偏移，避免 Hugo 按构建时区误读 */
export function fromDateInput(v: string): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const withSec = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? `${s}:00` : s;
  if (/(Z|[+-]\d{2}:\d{2})$/.test(withSec)) return withSec;
  const d = new Date(withSec);
  if (Number.isNaN(d.getTime())) return withSec;
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${withSec}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function nowInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** slug：只留字母数字与短横线，中文原样保留（站点里就有中文名文章） */
export function canonSlug(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[/\\?%*:|"<>.]/g, '')
    .slice(0, 80);
}
