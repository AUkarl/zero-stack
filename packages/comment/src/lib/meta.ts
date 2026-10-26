/**
 * meta.ts — 评论的访客维度展示（属地 / 浏览器 / 系统）与头像退化
 *
 * 字段来自后端 visitorMeta()：
 *   country = cf.country（ISO 码，CN/US…）、city = cf.city（CF 给的英文名，缺 city 时是 cf.region）、
 *   browser/os 解析不出来时是 'other'，device 是 mobile|tablet|desktop（前台第三行不展示设备）。
 * 本地 dev 没有 cf 属地就是空串 —— 空就整段不显示，绝不编造。
 */

/**
 * 属地一律「国家代码 + 英文名」，国内外同一格式：`CN Shandong`、`US New York`。
 *
 * 这里以前带一张省级中文表去翻 cf.city：表只有 33 条**省级**区划，字段却是**市级**地名，
 * 于是直辖市恰好命中显示「中国 上海」，地级市表里没有就原样漏拼音显示「中国 Shenzhen」——
 * 同一条规则下中英混排，看的是运气。站长把口径改成不翻译：一张表都不留，
 * 也就不会再有"表不全就漏出另一种文字"这类问题。
 *
 * 名字里出现的中日韩字符一律剔掉（老数据或导入来的行可能存着中文属地）：
 * 这样"这一行只有字母数字与常见标点"对任何输入都成立，而不是只对 CF 今天给的英文成立。
 * 拉丁文的重音字母（São Paulo）算字母，留着。
 */
export function placeLabel(country: string | null | undefined, city: string | null | undefined): string {
  const c = String(country ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  const t = dropCJK(String(city ?? '')).replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 60).trim();
  return [c, t].filter(Boolean).join(' ');
}

/** 中日韩区间的码点：汉字（含扩展 A 与兼容表意）、假名、中日韩标点与全角形式 */
function dropCJK(s: string): string {
  return [...s]
    .filter((ch) => {
      const p = ch.codePointAt(0) ?? 0;
      return !((p >= 0x3000 && p <= 0x30ff) || (p >= 0x3400 && p <= 0x4dbf)
        || (p >= 0x4e00 && p <= 0x9fff) || (p >= 0xf900 && p <= 0xfaff) || (p >= 0xff00 && p <= 0xffef));
    })
    .join('');
}

const BROWSER_ZH: Record<string, string> = {  Chrome: 'Chrome', Edge: 'Edge', Safari: 'Safari', Firefox: 'Firefox',
  Opera: 'Opera', WeChat: '微信', QQ: 'QQ', other: '',
};

const OS_ZH: Record<string, string> = {
  Windows: 'Windows', macOS: 'macOS', iOS: 'iOS', Android: 'Android',
  ChromeOS: 'ChromeOS', Linux: 'Linux', other: '',
};

/** 解析不出来（'other' / 空）就跳过，绝不显示 "other" 这种脏值 */
function cleanName(raw: string | null | undefined, table: Record<string, string>): string {
  const v = String(raw || '').trim();
  if (!v || v === 'other') return '';
  return table[v] ?? v;
}

/**
 * 正文下面那行小字里「位置 · 浏览器 · 系统」这三段（时间由调用方拼在最前面）。
 * 拿不到的一律不塞进去，全拿不到就是空串。
 */
export function infoLine(node: {
  country?: string | null;
  city?: string | null;
  browser?: string | null;
  os?: string | null;
}): string {
  return [
    placeLabel(node.country, node.city),
    cleanName(node.browser, BROWSER_ZH),
    cleanName(node.os, OS_ZH),
  ]
    .filter(Boolean)
    .join(' · ');
}

/* ------------------------------------------------------------------
 * 头像逐级退化：后端 avatar → gravatar → fallbacks（cravatar、QQ 头像）→ 首字母色块
 * 后端给几级就试几级，同一地址重复出现只算一次（后台头像模板常常就是链上那一条）。
 * ----------------------------------------------------------------*/

export function avatarSources(node: {
  avatar?: string | null;
  gravatar?: string | null;
  fallbacks?: string[] | null;
}): string[] {
  const out: string[] = [];
  for (const raw of [node.avatar, node.gravatar, ...(node.fallbacks ?? [])]) {
    const v = String(raw || '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/* 首字母与底色那两件事的唯一一份实现在 ./avatar-style.ts（服务端要复用同一算法，
   而这份文件引了 i18n，Worker 侧不能连一起拖进去）。这里只是原样转出，
   老代码 import { initialOf, fallbackStyle } from '../lib/meta' 照常能用。 */
export { initialOf, fallbackStyle, hueOf, styleFromHue, emailDomainOf, avatarStyleFor, avatarStyleFromNode, avatarInitialFromNode } from './avatar-style';

/** 只放行 http(s) 外链，其它协议（javascript: 之类）一律不渲染成链接 */
export function safeLink(raw: string | null | undefined): string {
  const v = String(raw || '').trim();
  return /^https?:\/\/\S+$/i.test(v) ? v : '';
}
