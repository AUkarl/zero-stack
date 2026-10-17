/**
 * meta.ts — 评论的访客维度展示（属地 / 浏览器 / 系统）与头像退化
 *
 * 字段来自后端 visitorMeta()：
 *   country = cf.country（ISO 码，CN/US…）、city = cf.city（英文名）、
 *   browser/os 解析不出来时是 'other'，device 是 mobile|tablet|desktop（前台第三行不展示设备）。
 * 本地 dev 没有 cf 属地就是空串 —— 空就整段不显示，绝不编造。
 */

import { isEnglish } from './i18n';

const COUNTRY_ZH: Record<string, string> = {
  CN: '中国', HK: '中国香港', MO: '中国澳门', TW: '中国台湾',
  US: '美国', CA: '加拿大', MX: '墨西哥', BR: '巴西', AR: '阿根廷',
  JP: '日本', KR: '韩国', SG: '新加坡', MY: '马来西亚', TH: '泰国',
  VN: '越南', PH: '菲律宾', ID: '印度尼西亚', IN: '印度', IL: '以色列',
  AE: '阿联酋', SA: '沙特阿拉伯', RU: '俄罗斯', UA: '乌克兰', TR: '土耳其',
  GB: '英国', IE: '爱尔兰', FR: '法国', DE: '德国', IT: '意大利', ES: '西班牙',
  PT: '葡萄牙', NL: '荷兰', BE: '比利时', CH: '瑞士', AT: '奥地利', SE: '瑞典',
  NO: '挪威', DK: '丹麦', FI: '芬兰', IS: '冰岛', PL: '波兰', CZ: '捷克',
  GR: '希腊', HU: '匈牙利', RO: '罗马尼亚', AU: '澳大利亚', NZ: '新西兰',
  ZA: '南非', EG: '埃及', NG: '尼日利亚',
};

const COUNTRY_EN: Record<string, string> = {
  CN: 'China', US: 'United States', JP: 'Japan', KR: 'South Korea', GB: 'United Kingdom',
  FR: 'France', DE: 'Germany', CA: 'Canada', AU: 'Australia', SG: 'Singapore',
};

function countryName(code: string, lang?: string): string {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return '';
  if (isEnglish(lang)) return COUNTRY_EN[c] || c;
  return COUNTRY_ZH[c] || c;
}

/**
 * 第三行次要信息里的「位置」：属地国家名 + 城市（cf 给的是英文城市/省名，中文下翻译一遍）。
 * 拿不到的一律不塞进去，全拿不到就是空串。
 */
export function placeLabel(country: string | null | undefined, city: string | null | undefined, lang?: string): string {
  const c = countryName(String(country || '').trim(), lang);
  const t = cityLabel(String(city || '').trim(), lang);
  // 中文按「国家 城市」顺排，英文按惯用的「City, Country」
  return isEnglish(lang) ? [t, c].filter(Boolean).join(', ') : [c, t].filter(Boolean).join(' ');
}

/**
 * cf 的 city 对国内 IP 给的是拼音/英文名，中文站直接贴出来很出戏，先过一层一级区划翻译；
 * 表里没有的（境外城市等）原样显示，绝不瞎猜。
 */
const CITY_ZH: Record<string, string> = {
  Beijing: '北京', Shanghai: '上海', Tianjin: '天津', Chongqing: '重庆',
  Guangdong: '广东', Jiangsu: '江苏', Zhejiang: '浙江', Shandong: '山东',
  Henan: '河南', Hebei: '河北', Shanxi: '山西', Anhui: '安徽',
  Fujian: '福建', Jiangxi: '江西', Hunan: '湖南', Hubei: '湖北',
  Sichuan: '四川', Guizhou: '贵州', Yunnan: '云南', Shaanxi: '陕西',
  Gansu: '甘肃', Qinghai: '青海', Hainan: '海南', Liaoning: '辽宁',
  Jilin: '吉林', Heilongjiang: '黑龙江', Guangxi: '广西', Inner: '内蒙古',
  Ningxia: '宁夏', Xinjiang: '新疆', Xizang: '西藏', Tibet: '西藏',
  Hong: '香港', Kowloon: '九龙', Macau: '澳门', Taipei: '台北', Kaohsiung: '高雄',
};

function cityLabel(raw: string, lang?: string): string {
  const v = raw.trim();
  if (!v || isEnglish(lang)) return v;
  // "Inner Mongolia" 这种带空格的，先按第一段查表
  const hit = CITY_ZH[v] ?? CITY_ZH[v.split(' ')[0]];
  return hit ?? v;
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
export function infoLine(
  node: {
    country?: string | null;
    city?: string | null;
    browser?: string | null;
    os?: string | null;
  },
  lang?: string,
): string {
  return [
    placeLabel(node.country, node.city, lang),
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

export function initialOf(name: string | null | undefined, emailDomain?: string | null): string {
  const n = String(name || '').trim();
  if (n) return n.slice(0, 1).toUpperCase();
  const d = String(emailDomain || '').trim();
  return d ? d.slice(0, 1).toUpperCase() : '?';
}

/** 名字（其次邮箱域名）散列出色相：同一个人颜色稳定，不依赖随机数 */
export function fallbackStyle(name: string | null | undefined, emailDomain?: string | null): string {
  const seed = `${String(name || '').trim()}|${String(emailDomain || '').trim()}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `background:hsl(${hue} 45% 84%);color:hsl(${hue} 55% 26%)`;
}

/** 只放行 http(s) 外链，其它协议（javascript: 之类）一律不渲染成链接 */
export function safeLink(raw: string | null | undefined): string {
  const v = String(raw || '').trim();
  return /^https?:\/\/\S+$/i.test(v) ? v : '';
}
