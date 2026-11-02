/**
 * sanitize.ts — 渲染结果出门前的第二层净化（只在浏览器里跑）
 *
 * markdown.ts 出来的 HTML 本来就不该有可执行内容：整段先转义、链接只走协议白名单、
 * 表情图只认构建期那张白名单表。这里补的是「万一上游哪天漏了一条」那一层，
 * 白名单按渲染器实际会产出的标签与属性来写，多一个都不给。
 *
 * 唯一的例外是表情图那串 onerror（备用图床依次换、全失败退成 token 原文）：
 * DOMPurify 会剥掉所有 on*，所以净化完再按 emoji-packs 的常量把它贴回去。
 * 贴的值是常量、不来自正文，正文里任何写法都决定不了它。
 */

import DOMPurify from 'dompurify';
import type { DOMPurify as Purifier } from 'dompurify';
import { EMOJI_ONERROR } from './emoji-packs';

/** lib/markdown.ts 的渲染器会产出的全部标签，一字不多 */
const ALLOWED_TAGS = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'code', 'a', 'img', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'strong', 'em', 'del',
];

/** data-emoji / data-chain 是表情图退图要读的，其余 data-*、aria-* 一律不进 */
const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class', 'rel', 'target',
  'loading', 'decoding', 'data-emoji', 'data-chain',
];

let instance: Purifier | null = null;

function purifier(): Purifier | null {
  // Worker 发邮件、Node 侧构建跑这段时没有 DOM：原样返回，那份 HTML 本来也不落地渲染。
  // 这里探 globalThis 而不写 window，是因为 packages/api 的 tsconfig 不带 DOM lib。
  const g = globalThis as unknown as { document?: unknown };
  if (!g.document || !DOMPurify.isSupported) return null;
  if (!instance) {
    // 独立实例：挂在默认单例上加钩子会波及同页面其它可能的 DOMPurify 用法
    const p = DOMPurify();
    p.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName !== 'IMG') return;
      const token = node.getAttribute('data-emoji');
      if (!token || !node.hasAttribute('data-chain')) return;
      node.setAttribute('onerror', EMOJI_ONERROR);
    });
    instance = p;
  }
  return instance;
}

/** 把渲染出来的 HTML 再过一遍白名单；无 DOM 的环境原样返回 */
export function sanitizeHtml(html: string): string {
  const p = purifier();
  if (!p) return html;
  return p.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOWED_NAMESPACES: ['http://www.w3.org/1999/xhtml'],
    KEEP_CONTENT: true,
  });
}
