/**
 * 邮件里的富文本正文。
 *
 * 为什么需要这一层：评论通知原来把用户原文直接塞进转义后的引用块，于是信里看到的是
 * `[weibo:smile]`、`![](https://…/a.png)` 这种字面标记 —— 前台明明是一张表情和一张图。
 * 这里复用评论组件那一套渲染（同一份代码，不会出现「邮件和前台渲染结果不一致」），
 * 再把站内相对路径补成绝对地址、给图片补内联样式：邮件客户端既不认 class 也常屏蔽远程图，
 * 被屏蔽时至少 alt 文字与链接还在。
 */
import { renderMarkdown } from '../../../comment/src/lib/markdown';

/** 邮件里图片只用内联样式：表情按行高缩一下，正文图不许撑破信宽 */
function styleImages(html: string): string {
  /* 非贪婪吃到标签尾，顺手吃掉自闭合的 `/`：留着它会拼出 `<img … / style="…">` 这种脏标签 */
  return html.replace(/<img\b([^>]*?)\s*\/?>/g, (_m, attrs: string) => {
    const style = /zc-emoji-img/.test(attrs) ? 'max-height:22px;vertical-align:-3px' : 'max-width:100%;height:auto;border-radius:6px';
    return `<img${attrs} style="${style}">`;
  });
}

/**
 * 评论正文 → 邮件 HTML。
 * siteBase 为空（站点地址还没配）时站内相对路径原样留着：那种链接点开必然 404，
 * 但正文本身（表情、图片、代码）不因此变差，好过为了拼地址把整段渲染跳过。
 */
export function commentEmailHtml(src: string, siteBase: string): string {
  const base = siteBase.replace(/\/+$/, '');
  const html = renderMarkdown(String(src ?? ''), { shortBase: base ? `${base}/posts/` : '/posts/' });
  const absolute = base ? html.replace(/(href|src)="\/(?!\/)/g, `$1="${base}/`) : html;
  return styleImages(absolute);
}
