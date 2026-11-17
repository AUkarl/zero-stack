/**
 * markdown.ts — 后台用的 Markdown 渲染入口。
 *
 * 渲染只有一份实现，在 packages/comment/src/lib/markdown.ts：前台评论区/时刻区、
 * 接口包的邮件正文、这里，全都引它。以前这份是手抄的，抄的那份没有表情，
 * 于是「后台评论管理看不到表情」「编辑器预览和读者看到的不一样」都出自这个分叉。
 * 要改语法就改评论包那一处；这个文件只留后台自己需要的两个工具函数。
 */

export { renderMarkdown } from '../../../comment/src/lib/markdown';
export type { MdOptions } from '../../../comment/src/lib/markdown';

/**
 * 字数：中文字符各算 1，连续的英文/数字算 1 个词；标点与空白不计。
 * 与前台模板 partials/zero/word-count.html 同一口径 —— 两边对不上时读者会先发现。
 * 链接只算可见的链接文字，图片（alt 不显示）不计。
 */
export function countWords(s: string): number {
  const text = String(s ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ');
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  const latin = (text.replace(/\p{Script=Han}/gu, ' ').match(/[A-Za-z0-9]+/g) || []).length;
  return han + latin;
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
