/**
 * 邮件模板的零依赖部分：占位符替换与四封正文的默认文本。
 *
 * 单独一个文件是因为循环引用：config.ts 的 STATIC_DEFAULTS 要在模块加载时拿到
 * 这几串文本，而 email-templates.ts 又要从 config 读站点名与 Logo。
 * 把「不读配置的那一半」放这里，两边都只依赖它，就不会出现初始化时的空值。
 */

export type TemplateKind = 'code' | 'subscribe' | 'comment' | 'notice';

/** 模板种类 → site_config 里的配置键 */
export const TEMPLATE_CONFIG_KEY: Record<
  TemplateKind,
  'emailTemplateCode' | 'emailTemplateSubscribe' | 'emailTemplateComment' | 'emailTemplateNotice'
> = {
  code: 'emailTemplateCode',
  subscribe: 'emailTemplateSubscribe',
  comment: 'emailTemplateComment',
  notice: 'emailTemplateNotice',
};

export const TEMPLATE_LABELS: Record<TemplateKind, string> = {
  code: '验证码',
  subscribe: '订阅确认',
  comment: '新评论提醒',
  notice: '其它通知',
};

/** 每种模板能用的占位符，后台页与预览接口都按这份表说明 */
export const TEMPLATE_VARS: Record<TemplateKind, { name: string; desc: string }[]> = {
  code: [
    { name: '{code}', desc: '6 位验证码' },
    { name: '{minutes}', desc: '有效分钟数' },
    { name: '{siteName}', desc: '站点名称' },
  ],
  subscribe: [
    { name: '{url}', desc: '确认订阅的链接' },
    { name: '{siteName}', desc: '站点名称' },
    { name: '{email}', desc: '待确认的邮箱' },
  ],
  comment: [
    { name: '{author}', desc: '评论者昵称' },
    { name: '{where}', desc: '位置：文章标题或「时刻」' },
    { name: '{parent}', desc: '被回复的那条原评论（整段：小标题 + 灰底块，不会被客户端折叠）；不是回复时为空，这一行也就不会留下空壳' },
    { name: '{content}', desc: '评论正文' },
    { name: '{url}', desc: '这条评论的锚点链接' },
    { name: '{title}', desc: '被评论的内容标题' },
    { name: '{siteName}', desc: '站点名称' },
  ],
  notice: [
    { name: '{intro}', desc: '开头一句话' },
    { name: '{content}', desc: '正文（可以是多段 HTML，群发与新文章推送都走这里）' },
    { name: '{title}', desc: '标题（文章名 / 审核对象）' },
    { name: '{url}', desc: '按钮链接' },
    { name: '{action}', desc: '按钮文字，留空则不显示按钮' },
    { name: '{siteName}', desc: '站点名称' },
  ],
};

const escape = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * 只替换 vars 里给过的 {key}，其余花括号原样留着（正文里可能带 CSS 片段）。
 * rawKeys 点名的变量原样插入不转义 —— 通知类邮件的正文是调用方自己拼好的 HTML 段落，
 * 转义一次就会在信里看到一整排 &lt;p&gt;。除了 {content} 这类明确是 HTML 的键，别用这个口子。
 */
export function fillTemplate(template: string, vars: Record<string, string>, rawKeys: string[] = []): string {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = vars[name];
    if (v === undefined || v === '') return '';
    return rawKeys.includes(name) ? v : escape(v);
  });
}

/** 正文里那个主按钮的内联样式（邮件客户端只认内联） */
export const EMAIL_BUTTON_STYLE =
  'display:inline-block;padding:10px 22px;background:#0d8368;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600';

/**
 * 四封正文的默认文本。后台「恢复默认」填回的就是这份，配置为空时代码也兜到这份，
 * 两处共用一个常量，不会出现「后台显示的默认」和「实际发出的兜底」不一样。
 */
export const DEFAULT_TEMPLATES: Record<TemplateKind, string> = {
  code: `<p>你的验证码是 <strong style="font-size:20px;letter-spacing:2px;color:#0d8368">{code}</strong>，{minutes} 分钟内有效。</p>
<p>如果不是你本人操作，请直接忽略这封邮件，也不要把它告诉任何人。</p>`,

  subscribe: `<p>感谢订阅 <strong>{siteName}</strong>。点击下方按钮确认之后，站内发布新文章时你会收到一封汇总。</p>
<p style="margin:22px 0"><a href="{url}" style="${EMAIL_BUTTON_STYLE}">确认订阅</a></p>
<p>不是你本人的订阅请求？忽略这封邮件即可，我们不会保存任何信息。</p>`,

  /*
   * 两段正文都用带边框的 `<div>`，**不用 `<blockquote>`、不加 `type="cite"`、不做左缩进**：
   * 那三条正是邮件客户端判定"这是引用"并自动挂上「隐藏引用 / 折叠引用」的启发式入口
   * （Gmail 还会按 margin-left 的缩进量认引用）。站长要的是两段内容一定全部可见，
   * 所以这里刻意不给自己留"看起来更标准但其实会被折叠"的写法。
   */
  comment: `{parent}<p><strong>{author}</strong> 在{where}留下一条新评论：</p>
<div style="margin:14px 0;padding:12px 16px;background:#f5f6f6;border-left:3px solid #0d8368;border-radius:0 8px 8px 0">{content}</div>
<p style="margin:18px 0"><a href="{url}" style="${EMAIL_BUTTON_STYLE}">去看这条评论</a></p>
<p style="font-size:12px;color:#8b949e">原文出处：{title}</p>`,

  notice: `<p>{intro}</p>
{content}
<p style="margin:18px 0"><a href="{url}" style="${EMAIL_BUTTON_STYLE}">{action}</a></p>`,
};
