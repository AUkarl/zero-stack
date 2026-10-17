/**
 * 邮件外壳：把正文包成站点统一样式的完整 HTML 文档。
 *
 * 白卡 + 站点名与 Logo + 分割线 + 「亲爱的【昵称】：您好！」+ 正文 +
 * 「谨祝安好！」落款，全部内联样式（邮件客户端会剥掉外部 CSS），
 * 宽度 560、max-width 100%，窄屏自己收窄，手机上不用横向拖动。
 *
 * 站点名 / Logo / 落款取自 site_config 的 siteName / siteLogo / author ——
 * 也就是后台「前端管理 → 基本信息」那几项，改一次全站（前台与邮件）一起变。
 *
 * 四封正文的默认文本与占位符表在 email-defaults.ts（那份不读配置，避免循环引用）。
 */
import { siteAuthorName } from './authors';
import { getConfig } from './config';
import {
  DEFAULT_TEMPLATES,
  TEMPLATE_CONFIG_KEY,
  type TemplateKind,
  fillTemplate,
} from './email-defaults';

export {
  DEFAULT_TEMPLATES,
  EMAIL_BUTTON_STYLE,
  TEMPLATE_CONFIG_KEY,
  TEMPLATE_LABELS,
  TEMPLATE_VARS,
  type TemplateKind,
  fillTemplate,
} from './email-defaults';

/** 外壳里会出现的站点信息与称呼 */
export interface ShellVars {
  siteName: string;
  siteUrl: string;
  logo: string;
  author: string;
  /** 称呼，即「亲爱的 X」那一行；留空写「朋友」 */
  nickname: string;
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Helvetica,Arial,sans-serif";

const esc = (v: unknown): string => fillTemplate('{v}', { v: String(v ?? '') });

/**
 * 正文片段 → 完整邮件文档。
 * opts.title 是白卡里的标题（可空）；opts.actionNote 放在落款下面的小字说明。
 */
export function wrapEmailShell(body: string, v: Partial<ShellVars> = {}, opts: { title?: string; actionNote?: string } = {}): string {
  const siteName = (v.siteName ?? '').trim() || '站点';
  const author = (v.author ?? '').trim() || siteName;
  const nickname = (v.nickname ?? '').trim() || '朋友';
  const heading = opts.title ? `<h2 style="margin:0 0 6px;font-size:19px;font-weight:700;color:#1f2328">${esc(opts.title)}</h2>` : '';
  const logo = (v.logo ?? '').trim()
    ? `<img src="${esc(v.logo!.trim())}" alt="" width="36" height="36" style="width:36px;height:36px;border-radius:8px;display:block">`
    : '';
  const siteLink = (v.siteUrl ?? '').trim()
    ? `<a href="${esc((v.siteUrl ?? '').replace(/\/+$/, ''))}" style="color:#0d8368;text-decoration:none">${esc(siteName)}</a>`
    : esc(siteName);
  const actionNote = opts.actionNote
    ? `<p style="margin:14px 0 0;font-size:12px;color:#8b949e">${esc(opts.actionNote)}</p>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(siteName)}</title>
<style>
  /* 只在窄屏生效的增量；其余样式全部内联，客户端剥掉 style 也不影响阅读 */
  @media only screen and (max-width: 620px) {
    .zero-pad { padding: 20px 16px 8px !important; }
    .zero-shell { width: 100% !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f5f6f6;">
<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background:#f5f6f6;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" class="zero-shell" width="560"
             style="width:560px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;">
        <tr>
          <td class="zero-pad" style="padding:26px 28px 8px;font-family:${FONT};font-size:15px;line-height:1.8;color:#1f2328;">
            <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td style="width:44px;vertical-align:middle;padding:0 10px 0 0">${logo}</td>
                <td style="vertical-align:middle;font-size:16px;font-weight:700;color:#1f2328">${siteLink}</td>
              </tr>
            </table>
            <div style="height:1px;background:#e5e7eb;margin:18px 0 20px"></div>
            ${heading}
            <p style="margin:0 0 4px">亲爱的${esc(nickname)}：</p>
            <p style="margin:0 0 16px">您好！</p>
            ${body}
            <p style="margin:24px 0 4px">谨祝安好！</p>
            <p style="margin:0 0 18px;font-size:18px;font-weight:700;color:#1f2328">${esc(author)}</p>
            ${actionNote}
          </td>
        </tr>
        <tr>
          <td style="padding:14px 28px 20px;border-top:1px solid #e5e7eb;font-family:${FONT};font-size:12px;line-height:1.7;color:#8b949e;">
            这封邮件由 ${siteLink} 自动发出；内容与站内设置不符时，以站内为准。
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0;font-family:${FONT};font-size:11px;color:#9aa4af">${esc(siteName)}</p>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** 外壳变量：站点名 / 地址 / Logo / 落款都来自后台配置，昵称由调用方按收件人传 */
export async function shellVars(env: Env, nickname?: string): Promise<ShellVars> {
  const [siteName, siteUrl, logo, author] = await Promise.all([
    getConfig(env, 'siteName'),
    getConfig(env, 'siteUrl'),
    getConfig(env, 'siteLogo'),
    siteAuthorName(env),
  ]);
  const name = (siteName ?? '').trim() || '站点';
  return {
    siteName: name,
    siteUrl: (siteUrl ?? '').trim(),
    logo: (logo ?? '').trim(),
    author: (author ?? '').trim() || name,
    nickname: (nickname ?? '').trim(),
  };
}

/** 某个种类的邮件：读配置模板 → 填占位符 → 套外壳 */
export async function renderEmail(
  env: Env,
  kind: TemplateKind,
  vars: Record<string, string>,
  opts: {
    title?: string;
    nickname?: string;
    actionNote?: string;
    template?: string;
    /** 这些占位符按原样 HTML 插入（通知类的 {content} 由调用方自己拼好并转义过） */
    rawKeys?: string[];
  } = {},
): Promise<string> {
  const key = TEMPLATE_CONFIG_KEY[kind];
  const configured = opts.template ?? (await getConfig(env, key)) ?? '';
  const shell = await shellVars(env, opts.nickname);
  const raw = configured.trim() ? configured : DEFAULT_TEMPLATES[kind];
  /*
   * 没有 url 就把「带 {url} 的那一整行」整行去掉。fillTemplate 只会把空值替换成空串，
   * 结果留下一枚 `<a href=""></a>`：邮件里是一个看不见字的灰块，点了什么也不发生
   * （友链审核结果信以前就是这样）。整行删掉才是「这封信本来就没有跳转按钮」。
   * 按行处理而不是事后正则删 HTML：后台可以自己改模板，行结构比标签稳定。
   */
  const template = (vars.url ?? '').trim() ? raw : raw.split('\n').filter((line) => !line.includes('{url}')).join('\n');
  const body = fillTemplate(
    template,
    { siteName: shell.siteName, siteUrl: shell.siteUrl, ...vars },
    opts.rawKeys,
  );
  return wrapEmailShell(body, shell, { title: opts.title, actionNote: opts.actionNote });
}
