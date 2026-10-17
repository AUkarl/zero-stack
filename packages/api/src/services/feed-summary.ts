/**
 * feed-summary.ts — RSS 摘要入库前的清洗
 *
 * 对方站点的 <description> 往往是整篇正文（Hugo 默认给全文），末尾还带着主题自己那截页脚 ——
 * 「站点名 · [订阅更新](/posts/xxx//subscribe/) · [退订](/posts/xxx/#unsubscribe)」这一行，
 * 原样进订阅邮件与朋友动态就是两行看不懂的东西：markdown 没渲染、地址还是相对那篇文章的。
 *
 * 两条链路共用这里：订阅推送（services/feed-push.ts）与朋友动态抓取（services/scheduler.ts）。
 * 我们自己在邮件末尾拼的那行「不再想收到本站邮件？点这里退订」是模板加的，拼在这一步之后，不受影响。
 */

/**
 * 页脚那一整截：可选的「站点名 ·」+ 关键词 + 后面到行尾的内容。
 * 关键词前面必须有分隔符或空格，正文里那句「他要退订这件事很难」才不会被腰斩。
 * 站点名限 24 字，且这一段必须紧跟在句读或空格之后 —— 不然正文里随便一句 24 字以内的话
 * 也会被当成页脚名吃掉，一整句就没了。名字中间允许空格（英文站名），首字符不允许。
 */
const FOOTER_TAIL =
  /(^|[。！？；：，,、.!?;:\s])(?:[^\s·|—。！？；：，,、.!?;:][^·|—。！？；：，,、.!?;:]{0,23}\s*[·|—]\s*)?(?:订阅更新|订阅管理|退订|unsubscribe|subscribe)(?:[^\n]{0,60})?$/i;

export function cleanSummary(s: string): string {
  const out = s.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1');
  return out
    .replace(FOOTER_TAIL, '$1')
    .replace(/[·|—\-,,、\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
