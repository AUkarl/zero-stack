/**
 * avatar-style.ts — 「一张头像都取不到时，那个首字母色块长什么样」的唯一一份算法
 *
 * 为什么单独一个文件（而不是留在 meta.ts 里）：
 *   公开评论响应里原先带着 `emailDomain`（每个人邮箱的域名），前端拿 `昵称|域名` 去散列出底色。
 *   R43 要把这个字段从公开数据里删掉，但**直接删会让所有人的头像底色集体换一遍** ——
 *   颜色由那串种子决定，换了种子就是换了颜色。
 *   唯一同时做到「不公开域名」与「颜色一格都不变」的办法，是服务端照着同一串 `昵称|域名`
 *   把**色相算出来**再下发（0~359 一个整数，反推不出域名）。而这段算法必须两边共用一份，
 *   否则就是一处改配色、另一处忘改，线上变成「后台预览一种色、前台另一种色」（本项目为手抄两份吃过多次亏）。
 *   meta.ts 里引了 i18n（前台才有），Worker 侧不能连一起拖进来，所以这份保持零依赖。
 */

/** 邮箱里 @ 后面那段；不是合法邮箱就空 */
export function emailDomainOf(email?: string | null): string {
  const mail = String(email ?? '').trim().toLowerCase();
  return mail.includes('@') ? (mail.split('@')[1] ?? '') : '';
}

/** 色相：同一个人稳定，不依赖随机数（改这个算法=改全站已有头像的颜色） */
export function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** 由色相出那对 hsl（浅色底 + 深色字，两档对比都够读） */
export function styleFromHue(hue: number): string {
  return `background:hsl(${hue} 45% 84%);color:hsl(${hue} 55% 26%)`;
}

/** 首字母：有昵称取昵称第一个字，没有就取邮箱域名第一个字母，都没有是「?」 */
export function initialOf(name: string | null | undefined, emailDomain?: string | null): string {
  const n = String(name ?? '').trim();
  if (n) return n.slice(0, 1).toUpperCase();
  const d = String(emailDomain ?? '').trim();
  return d ? d.slice(0, 1).toUpperCase() : '?';
}

/** 老口径（昵称 + 域名自己算），仍留给没有服务端两字段时使用 */
export function fallbackStyle(name: string | null | undefined, emailDomain?: string | null): string {
  return styleFromHue(hueOf(`${String(name ?? '').trim()}|${String(emailDomain ?? '').trim()}`));
}

/**
 * 服务端用：把「这个人该是什么色、该显示哪个字母」算成两个不泄露域名的字段。
 * 入参口径与前端以前自己算的那份**逐字相同**，所以线上颜色一格都不变。
 */
export function avatarStyleFor(name: string | null | undefined, email?: string | null): { avatarHue: number; avatarInitial: string } {
  const domain = emailDomainOf(email);
  const displayName = String(name ?? '').trim();
  return {
    avatarHue: hueOf(`${displayName}|${domain}`),
    avatarInitial: initialOf(displayName, domain),
  };
}

/** 前端用：服务端给了就用服务端的，没给（老回包、第三方评论区）就退回自己算 */
export function avatarStyleFromNode(node: {
  authorName?: string | null;
  emailDomain?: string | null;
  avatarHue?: number | null;
  avatarInitial?: string | null;
}): string {
  if (typeof node.avatarHue === 'number' && node.avatarHue >= 0 && node.avatarHue < 360) return styleFromHue(node.avatarHue);
  return fallbackStyle(node.authorName, node.emailDomain);
}

export function avatarInitialFromNode(node: {
  authorName?: string | null;
  emailDomain?: string | null;
  avatarInitial?: string | null;
}): string {
  const v = String(node.avatarInitial ?? '').trim();
  if (v) return v.slice(0, 1).toUpperCase();
  return initialOf(node.authorName, node.emailDomain);
}
