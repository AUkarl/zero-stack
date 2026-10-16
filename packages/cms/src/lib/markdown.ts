/**
 * markdown.ts — 后台编辑器预览用的极简 Markdown 渲染。
 *
 * 与 packages/comment/src/lib/markdown.ts 同一套规则：前台评论区/时刻区用同一个解析器，
 * 后台预览若与线上不一致，编辑看到的和读者看到的就是两回事。
 * 改语法时两处一起改。
 */

export interface MdOptions {
  /** 短链前缀，默认 /post/ */
  shortBase?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 只允许安全协议与站内路径，挡掉 javascript: / data: 这类注入 */
function safeHref(href: string): string {
  const raw = href.trim();
  if (/^(https?:|mailto:)/i.test(raw)) return raw;
  // //evil.com 与 /\evil.com 是协议相对地址，会跳到外站，一并拒绝
  if (/^\/[^/\\]/.test(raw)) return raw;
  if (/^(\.\/|\.\.\/|#)/.test(raw)) return raw;
  return '';
}

function shortLink(slug: string, base: string): string {
  const raw = slug.trim();
  // 以 / 开头 → 写的是站内绝对路径，原样使用，不再套 shortBase
  if (raw.startsWith('/')) {
    const path = raw.replace(/["'<>\\\s]/g, '');
    return path.startsWith('/') && !path.startsWith('//') ? path : '';
  }
  const clean = raw.replace(/^[/[]+|[]\/]+/g, '').trim();
  if (!clean) return '';
  return `${base}${encodeURIComponent(clean)}/`;
}

/** 行内标记：代码 → 短链 → 图片 → 链接 → 加粗 → 斜体 → 删除线 */
function inline(s: string, base: string): string {
  const codes: string[] = [];
  let out = s.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });

  out = esc(out);

  // 短链要先于普通链接处理，否则 [[a|b]] 会被链接语法截断
  out = out.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, slug, text) => {
    const href = shortLink(slug, base);
    if (!href) return _m;
    return `<a href="${href}" rel="noreferrer">${(text || slug).trim()}</a>`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, src) => {
    const href = safeHref(src);
    return href ? `<img src="${href}" alt="${alt}" loading="lazy" />` : _m;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, text, href) => {
    const ok = safeHref(href);
    return ok ? `<a href="${ok}" target="_blank" rel="noreferrer">${text}</a>` : _m;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${esc(codes[Number(i)] ?? '')}</code>`);
}

/** 把 Markdown 渲染成 HTML 字符串（调用方用 {@html} 输出） */
export function renderMarkdown(src: string, opts: MdOptions = {}): string {
  const base = opts.shortBase ?? '/posts/';
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  let listType: 'ul' | 'ol' | null = null;
  let inCode = false;
  let inQuote = false;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '), base)}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      out.push('</blockquote>');
      inQuote = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (/^\s*```/.test(line)) {
      flushPara();
      closeList();
      closeQuote();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${esc(line)}\n`);
      continue;
    }

    if (!line.trim()) {
      flushPara();
      closeList();
      closeQuote();
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      closeQuote();
      out.push(`<h${h[1].length}>${inline(h[2], base)}</h${h[1].length}>`);
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      flushPara();
      closeList();
      closeQuote();
      out.push('<hr />');
      continue;
    }

    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      closeList();
      if (!inQuote) {
        out.push('<blockquote>');
        inQuote = true;
      }
      out.push(`<p>${inline(q[1], base)}</p>`);
      continue;
    }
    closeQuote();

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (listType && listType !== want) closeList();
      if (!listType) {
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${inline((ul || ol)![1], base)}</li>`);
      continue;
    }
    closeList();

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      out.push(`<table><thead><tr>${cells.map((c) => `<th>${inline(c, base)}</th>`).join('')}</tr></thead><tbody>`);
      continue;
    }
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    if (/^\s*\|.*\|\s*$/.test(line) && out.some((o) => o.includes('<tbody>'))) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      out.push(`<tr>${cells.map((c) => `<td>${inline(c, base)}</td>`).join('')}</tr>`);
      continue;
    }

    para.push(line.trim());
  }

  flushPara();
  closeList();
  closeQuote();
  if (inCode) out.push('</code></pre>');

  return out.join('\n');
}

/** 估算中文 + 英文混排的字数（中文按字，英文按词） */
export function countWords(s: string): number {
  const cn = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const en = (s.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
  return cn + en;
}

/**
 * 拆出 Hugo 的 front matter 与正文：编辑器只需要对正文做预览，
 * 头部交给表单里的字段去改。
 */
export function splitFrontMatter(text: string): { front: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { front: '', body: text };
  return { front: m[1], body: text.slice(m[0].length) };
}
