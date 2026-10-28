import { z } from 'zod';

/**
 * 「人点得开的网址」唯一一份判据。
 *
 * 为什么要收成一处：这条规则在这个仓里被抄过三遍（后台友链新增、公开友链申请、账号侧的友链设置），
 * 三份的措辞与严格程度都不一样，而**后台那一份恰好是漏的** —— 它只调 zod 的 `.url()`，
 * 而 `.url()` 不看协议，于是 `javascript:alert(1)` 存得进库；这一串之后会被主题原样写进
 * `<a href>`（links/list.html 与 JS 渲染那一份），等于把 XSS 入口挂在访客点的友链上。
 * 收成一处之后，加一个键的人只需要问「这是不是一条链接」，不必再想协议该谁管。
 *
 * 判据故意比 `.url()` 紧：必须有 http/https、必须有一个点、中间不能有空格。
 * `mailto:` / `tel:` 这类有正当用途的协议不在友链字段上用得到，先不放行；
 * 真要放就显式加一条，而不是回到「什么协议都收」。
 */
export const isHttpUrl = (v: string): boolean => /^https?:\/\/[^\s]+\.[^\s]+/i.test(v);

export const HTTP_URL_HINT = '需为 http(s) 开头的完整网址（例如 https://example.com）';

/** 缺省这句就够人照着改；字段有上下文（头像 / RSS）时调用方自己补一句 */
export const HTTP_URL_MESSAGE = `${HTTP_URL_HINT} —— 其它协议（javascript: / data: 等）会被原样写进页面链接，点了就在访客的浏览器里执行`;

export function httpUrlField(opts: { max?: number; message?: string } = {}) {
  const { max = 300, message = HTTP_URL_MESSAGE } = opts;
  return z.string().trim().max(max).refine(isHttpUrl, { message });
}

/** 「留空 = 不填」的可选链接：空串仍然放行，填了就必须过上面那条 */
export function optionalHttpUrlField(opts: { max?: number; message?: string } = {}) {
  return httpUrlField(opts).optional().or(z.literal(''));
}
