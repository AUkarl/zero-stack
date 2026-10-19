/**
 * markdown.ts — 评论区 / 时刻用的极简 Markdown 渲染
 *
 * 这些内容直接渲染给所有访客看，所以安全优先：
 *   1. 整段先转义 HTML，用户写的 <script> 只会变成字面文本；
 *   2. 链接地址只放行 http(s) / mailto / 站内相对路径；
 *   3. 支持的语法是常用子集（标题、列表、引用、代码、粗斜体、链接、图片、表格、短链、表情）。
 *
 * 短链写法：[[slug]] 或 [[slug|显示文字]]，解析成 shortBase + slug + '/'，
 * 默认站内文章路径 /post/，让读者在评论里引用文章不必贴整串 URL。
 * 也可以直接写站内绝对路径：[[/posts/some-post/|显示文字]] 原样使用，不套前缀。
 *
 * 图片表情写法：[weibo:smile] 这类 token，只有 emoji-packs 的白名单表里查得到才出 <img>，
 * 查不到就原样留字面文本（邮件通知、RSS 这些纯文本场景拿到的始终是 token 原文）。
 * 出图时一张表情带几个备选图床地址，取不到就在浏览器里依次换，全取不到才退回 token 原文。
 */

import { EMOJI_TOKEN_RE, emojiImageOf, emojiImgHtml } from './emoji-packs';

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

/** 行内标记：代码 → 表情 → 短链 → 图片 → 链接 → 加粗 → 斜体 → 删除线 */
function inline(s: string, base: string): string {
  const codes: string[] = [];
  let out = s.replace(/`([^`]+)`/g, (_m, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });

  out = esc(out);

  /* 表情先占位再交给后面的行内规则：白名单里查不到的 [x:y] 原样留作文本，
   * 占位符也不会被链接/加粗那类语法二次吃掉。能查到的那张 <img> 由 emoji-packs 一处生成，
   * 备选图床与退图逻辑都在里面（正文、表情面板、后台、个人中心出的是同一枚 img）。 */
  const images: string[] = [];
  out = out.replace(EMOJI_TOKEN_RE, (m, set: string, name: string) => {
    const img = emojiImageOf(`${set}:${name}`);
    if (!img) return m;
    images.push(emojiImgHtml(img));
    return `\u0001${images.length - 1}\u0001`;
  });

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

  // 表情要赶在 code 还原之前回填，否则 ` [weibo:smile] ` 这种字面写法会被当成表情
  out = out.replace(/\u0001(\d+)\u0001/g, (_m, i) => images[Number(i)] ?? '');
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${esc(codes[Number(i)] ?? '')}</code>`);
}

/** 把 Markdown 渲染成 HTML 字符串（调用方用 {@html} 输出） */
export function renderMarkdown(src: string, opts: MdOptions = {}): string {
  const base = opts.shortBase ?? '/post/';
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

    // 代码块
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

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      closeList();
      closeQuote();
      out.push(`<h${h[1].length}>${inline(h[2], base)}</h${h[1].length}>`);
      continue;
    }

    // 分隔线
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      flushPara();
      closeList();
      closeQuote();
      out.push('<hr />');
      continue;
    }

    // 引用
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

    // 列表
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

    // 表格（只认最简单的表头 + 分隔行写法）
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

