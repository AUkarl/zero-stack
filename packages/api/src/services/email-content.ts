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

/** 表情图库的中文 tab 名（与评论组件 EmojiPicker 那一份一致）：屏蔽图片时要拿它拼一句人话 */
const EMOJI_PACK_LABELS: Record<string, string> = { weibo: '微博', bb: 'B站', qq: 'QQ', tieba: '贴吧' };

/** `[weibo:smile]` → 「微博表情 smile」：邮件客户端屏蔽图片时显示的就是这段字，不能是 token 原文 */
function emojiLabel(token: string): string {
  const m = /^\[(\w+):([A-Za-z0-9_-]+)\]$/.exec(token);
  if (!m) return token;
  return `${EMOJI_PACK_LABELS[m[1]] ?? m[1]}表情 ${m[2]}`;
}

/**
 * 邮件里的图片只用内联样式：表情按行高缩一下，正文图不许撑破信宽。
 *
 * 顺手把 `loading="lazy"` / `decoding="async"` 去掉 —— 它们在网页里是为了省流量，
 * 邮件里没有任何流量可省（信已经下载完了），留着反而会让认这个属性的客户端
 * 「等滚动到可见才加载」，表现就是表情位置一片空白，用户以为没发出去。
 * 表情那张 img 带的 `data-chain` / `onerror`（换备用图床用的内联脚本）也一并剥掉：
 * 邮件正文里不该有脚本，图被屏蔽时该看的 alt 已经写成人话了。
 */
function styleImages(html: string): string {
  /* 非贪婪吃到标签尾，顺手吃掉自闭合的 `/`：留着它会拼出 `<img … / style="…">` 这种脏标签 */
  return html.replace(/<img\b([^>]*?)\s*\/?>/g, (_m, attrs: string) => {
    const isEmoji = /zc-emoji-img/.test(attrs);
    const style = isEmoji ? 'max-height:22px;vertical-align:-3px' : 'max-width:100%;height:auto;border-radius:6px';
    const clean = attrs.replace(/\s(?:loading|decoding|onerror|data-chain)="[^"]*"/g, '');
    if (!isEmoji) return `<img${clean} style="${style}">`;
    /** alt/title 换成中文标签；data-emoji 留着（前台/排查按它认原文）。
        值里只有「库中文名 表情 名字」，名字被 EMOJI_TOKEN_RE 限定在 [A-Za-z0-9_-]，不会带引号 */
    const token = (/data-emoji="([^"]*)"/.exec(clean) || [])[1] ?? '';
    const label = escAttr(emojiLabel(token));
    return `<img${clean.replace(/alt="[^"]*"/, `alt="${label}"`).replace(/title="[^"]*"/, `title="${label}"`)} style="${style}">`;
  });
}

/** 注进 HTML 属性前一律转义（正文图那条链路上的 alt 是用户可写的） */
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 评论里以 `>` 开头的行会被渲染成 `<blockquote>`，而 `<blockquote>` / `type="cite"` / 左缩进
 * 正是邮件客户端判定"这是引用"并挂上「隐藏引用 / 折叠引用」的入口。站主要的是信里内容一定全部可见，
 * 所以只在**邮件这一侧**把它换成观感一样的 `<div>`（前台评论组件不动，那边折叠与否归前台管）。
 */
const QUOTE_DIV =
  '<div style="margin:12px 0;padding:10px 14px;background:#f5f6f6;border-left:3px solid #c9ced6;border-radius:0 8px 8px 0">';

/**
 * 评论正文 → 邮件 HTML。
 * siteBase 为空（站点地址还没配）时站内相对路径原样留着：那种链接点开必然 404，
 * 但正文本身（表情、图片、代码）不因此变差，好过为了拼地址把整段渲染跳过。
 */
export function commentEmailHtml(src: string, siteBase: string): string {
  const base = siteBase.replace(/\/+$/, '');
  const html = renderMarkdown(String(src ?? ''), { shortBase: base ? `${base}/posts/` : '/posts/' })
    .replace(/<blockquote>/g, QUOTE_DIV)
    .replace(/<\/blockquote>/g, '</div>');
  const absolute = base ? html.replace(/(href|src)="\/(?!\/)/g, `$1="${base}/`) : html;
  const styled = styleImages(absolute);
  /* 远程图被客户端屏蔽时，行内 alt 只有一个词，容易被看成「没发出去」，所以补一句说明。
     这句里不给裸网址、也不做成链接（站长定的措辞）：信本来就在评论页那个按钮上方，
     再放一行域名只是多一处可点、还可能被客户端切成奇怪的样子。 */
  if (/zc-emoji-img/.test(styled)) {
    return `${styled}<p style="margin:.5rem 0 0;font-size:.82em;color:#8a8a8a">邮件中含表情图片，如邮件客户端未显示，点击下方按钮查看完整内容。</p>`;
  }
  return styled;
}
