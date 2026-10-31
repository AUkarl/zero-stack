import { Hono } from 'hono';
import { z } from 'zod';
import { buildHealthReceipt, commitRepoFiles, readRepoFile, repoBackend, runLocalBuildCheck, writeRepoFile } from '../services/repo';
import { parse as parseToml } from 'smol-toml';
import { getAllConfig, getConfig, setConfig } from '../services/config';
import { requireAdmin } from '../middleware/auth';
import { buildReceipt, triggerPagesBuild } from '../services/git';
import { invalidateSiteNameCache } from '../services/site-name';
import {
  applyConnectOriginsToHeaders,
  applyManagedOriginsToMiddleware,
  commentConnectOrigins,
  readManagedOrigins,
} from '../services/csp-connect';
import { clientIp } from '../lib/http';
import { fail, ok } from '../lib/errors';
import type { AppEnv } from '../lib/app';
import { zodZh } from '../lib/zmsg';

/**
 * 前端管理：基本信息 / 导航 / 首页 / 页脚 / 关于 / 工坊 / 时刻 / 友链申请 / SEO。
 *
 * 内容写进站点的 data/*.json（Hugo 原生读 data 目录），主题优先读这些文件、
 * 读不到再回落到 params.toml。之所以不直接改 params.toml：那个文件里全是给人看的
 * 注释，程序一覆盖就没了。一个保存动作写多个文件，但只触发一次 Pages 构建。
 */
const app = new Hono<AppEnv>();

/* ------------------------------------------------------------------ 结构 */

/** 短文本一律先 trim 再限长：以前首尾空格照样落盘，后台看着像「保存成功但显示多一格」 */
const short = z.string().trim().max(200);
const long = z.string().max(4000);
/**
 * 只被当纯文本拼进模板、不参与跳转的串（robots.txt 的各行、robots_host）。
 * 地址类字段以前也共用这一条，于是「什么都查不出来」，见下面 linkUrl / imageUrl 的分法。
 */
const href = z.string().max(600);

/**
 * 「点了会跳过去」的地址：导航项、页脚与社交图标的 link、备案链接、poweredBy、联系方式、作品地址。
 *
 * 为什么要把老规矩 `startsWith('/')` 收紧：`//evil.example.com/x` 也以 / 开头，
 * 可浏览器把它当**协议相对的站外地址**用 —— 提示语写着「站内路径」，实际放行的是跳到别人域名
 * （还跟着站点的 http/https 走）。`/\host` 同理（部分浏览器会规范成 //host），一并拒掉。
 * javascript: / vbscript: / data:text/html 这类原来就拒（Hugo 渲染时会消毒成 #ZgotmplZ，
 * 不构成 XSS，但会存成一条谁都点不开的死链，而且要到前台才发现），现在照旧在入库这一层拒。
 * `/../x` 这种「以 / 开头但往上跳」的也拒：它写的就是站内某个不存在的地址，点必死链，
 * 而后台与前台都不会报错 —— 与 R34 那批堵 `//站外` 是同一类「看着像站内其实不是」。
 * 空串是允许的：「没链接又没有标识」那种整项无用的情况由 navItem 的 refine 管（下拉分组只有标识）。
 */
/**
 * 「以 / 开头但其实要往上跳/跳到站外」的判断，**原样与解码后各看一遍**。
 *
 * 为什么要看解码后的：R39 只挡了字面量 `/../x`，而 `/tags/%2e%2e/` 一样能写进库、
 * 浏览器与边缘会先解码再规范路径 —— 体检实测这条写入 200 且落盘，线上点进去 404（一条死链）。
 * `%2f%2f` 同理（解码后是协议相对，会跳到别人的域名）。
 * 反过来**不能**把空白/引号那条判据也套到解码后的串上：`/tags/%20a%2eb/` 这种
 * 正常中文/含空格路径解码出来就带空格，那样会把好地址打死（体检报告里点名的坑）。
 * decodeURIComponent 遇到坏百分号会抛，抛了就当没解码（原样那条判据仍在）。
 */
function looksLikeTraversal(v: string): boolean {
  const bare = /^\/\/|\/\\/.test(v) || /\/\.\.(\/|$)/.test(v);
  if (bare) return true;
  let decoded = '';
  try {
    decoded = decodeURIComponent(v);
  } catch {
    return false;
  }
  if (decoded === v) return false;
  return /^\/\/|\/\\/.test(decoded) || /\/\.\.(\/|$)/.test(decoded);
}

const linkUrl = z
  .string()
  .max(600)
  .transform((v) => v.trim())
  .refine(
    (v) =>
      !v ||
      /^https?:\/\//i.test(v) ||
      /^mailto:/i.test(v) ||
      (v.startsWith('/') && !looksLikeTraversal(v) && !/[\s"'<>`]/.test(v)),
    '地址要嘛是以 / 开头的站内路径（注意：以 // 或 /\\ 开头是跳到别人的域名，不算站内；带 ../ 或 %2e%2e 往上跳的也不算站内），要嘛写成 http:// 或 https:// 开头的完整地址，或者 mailto: 开头的邮箱',
  );

/**
 * 只填进 `<img src>` 的地址：logo / favicon / ogImage / 落地页背景 / 时刻横幅 / 头像 / 图标。
 *
 * 这里**不能**套 linkUrl 的规矩：出厂的 data/site.json 与 data/moments.json 就写着不带前导斜杠的
 * 相对路径（`landingImage: "img/bj2.png"`），一刀切会把每个新站的默认配置判成非法。
 * 只挡「放进 src 里可能执行东西」的协议，其余（站内、相对、//CDN、http(s)、data:image/… 内联）照旧放行。
 */
const imageUrl = z
  .string()
  .max(600)
  .transform((v) => v.trim())
  .refine((v) => !/^(javascript|vbscript|livescript|data:text\/html|data:application)/i.test(v), '图片地址只能是站内/相对路径、http(s) 外链或 data:image/… 内联，不能是可执行协议');

/** 站点根地址：邮件里的确认/退订链接与后台跳转都要它带协议，所以比 linkUrl 更严 */
const absoluteUrl = z
  .string()
  .max(600)
  .transform((v) => v.trim())
  .refine((v) => !v || /^https?:\/\//i.test(v), '这里要写成带 http:// 或 https:// 的完整站点地址（邮件里的确认链接要在它前面拼）');

const navItem = z
  .object({
    /** 名称是这一项唯一的可读文字（也是 iconOnly 时的鼠标提示与 aria-label），空着存进去前台就是一条没有名字的菜单 */
    name: short
      .pipe(z.string())
      .transform((v) => v.trim())
      .refine((v) => v.length > 0, '名称不能为空'),
    url: linkUrl,
    weight: z.number().int().min(-9999).max(9999).default(0),
    icon: short.optional().default(''),
    image: imageUrl.optional().default(''),
    iconOnly: z.boolean().optional().default(false),
    external: z.boolean().optional().default(false),
    /** '' = 主菜单；'controls' = 右侧图标区 */
    position: z.enum(['', 'controls']).optional().default(''),
    /** 有子项时必填，子项用 parent 指回来 */
    identifier: short.optional().default(''),
    parent: short.optional().default(''),
    /** 主题据此把这一项渲染成账号入口（登录后换头像），而不是普通链接 */
    zeroAccount: z.boolean().optional().default(false),
  })
  .refine((it) => !!it.url || !!it.identifier.trim(), '这一项既没有链接也没有标识：只有下拉分组（填了 identifier、子项用 parent 指回来）才允许链接留空');

const navSchema = z.object({ items: z.array(navItem).max(60) });

const homeSchema = z.object({
  layout: z.enum(['bento', 'grid']),
  desc: short,
  showDesc: z.boolean(),
});

/** 页脚图标条目：键名与主题 params.toml 的 [[footer.services]] / social_row1/2 一致，
    模板 data 优先、params 兜底，所以后台填了就不必再动 params.toml。 */
const footerIconItem = z.object({
  /** 这条链接唯一的可读名（title 与 aria-label 都用它），空着读屏就只念得出「链接」，所以不许为空 */
  name: short.pipe(z.string().transform((v) => v.trim()).refine((v) => v.length > 0, '名称不能为空')),
  icon: short.optional().default(''),
  img: imageUrl.optional().default(''),
  link: linkUrl,
  /** 深色模式下要不要反色（图片 logo 常见需求） */
  invert: z.boolean().optional().default(false),
  /** 这一条要不要把名字显示在图标旁边；不写就跟着页脚那行的全站默认 */
  showName: z.boolean().optional(),
});

const footerSchema = z.object({
  copyrightText: short,
  showPoweredBy: z.boolean(),
  poweredByText: short,
  poweredByLink: linkUrl,
  icpItems: z
    .array(z.object({ text: short, link: linkUrl }))
    .max(20)
    .default([]),
  /** 「支持服务」那行的全站默认：条目自己写了 showName 就以条目为准 */
  showServiceName: z.boolean().optional().default(true),
  /** 中栏的服务图标行 */
  services: z.array(footerIconItem).max(20).optional(),
  /** 右栏两排社交图标 */
  socialRow1: z.array(footerIconItem).max(20).optional(),
  socialRow2: z.array(footerIconItem).max(20).optional(),
});

const aboutSchema = z.object({
  desc: short,
  tagline: short,
  bio: z.array(long).max(60),
  declaration: z.array(long).max(60),
  site: z.array(long).max(60),
  contacts: z
    .array(z.object({ label: short, text: short, url: linkUrl, external: z.boolean().optional().default(true) }))
    .max(60)
    .default([]),
});

const worksSchema = z.object({
  desc: short,
  items: z
    .array(z.object({ title: short, desc: long, status: short, url: linkUrl }))
    .max(80)
    .default([]),
});

/**
 * 友链页「申请友链」那一栏的三段说明（data/apply.json）。
 *
 * 名单本身在 data/links.yaml（由后台「友链」增删改同步），这一份只管三段文字：
 * 友链要求 / 我的信息 / 提交示例。主题按「data 优先、读不到才回落页面正文」渲染，
 * 所以站点没建过这个文件时，content/links/_index.md 里手写的那几块照常显示。
 * 「我的信息」与「提交示例」是 标签 + 内容 的行列表：前台一行一条，
 * 「复制」按钮取的是整块的纯文本，行的顺序就是复制到剪贴板的顺序。
 */
const infoRow = z.object({ label: short, value: short });

const applySchema = z.object({
  /** 「友链要求」标题下那段引导语 */
  intro: long.default(''),
  /** 要求条目：一行一条，前台排成有序列表 */
  requirements: z.array(long).max(30).default([]),
  myInfo: z.array(infoRow).max(20).default([]),
  submitExample: z.array(infoRow).max(20).default([]),
});

/**
 * 基本信息（站点名 / Logo / 图标 / 作者 / 简介）。
 * Hugo 的 baseURL 与 title 兜底仍在 config.toml —— 那是站点级配置，改它要重写
 * config.toml（里面有注释），这里只管 params 能管的那几样。
 *
 * siteUrl 是邮件里确认 / 退订链接的前缀，也是后台仪表盘的跳转地址，应与 config.toml
 * 的 baseURL 写成同一个。保存这一段时顺手同步进 site_config 的同名键
 * （siteName / siteUrl / siteDescription / siteLogo / siteFavicon / author），
 * 免得前台改了名字而邮件、群发与备份文件里还是旧的。
 */
/*
 * 站点基本信息（data/site.json）。
 *
 * 键全部带默认值：这份文件可能由人手写过、也可能只被「站长作者资料」写过一行
 * defaultAuthor，缺键要让 schema 补默认，否则 GET 解析失败 → 页面显示空白 →
 * 下一次保存把仓库里已有的内容整份覆盖掉。主题侧是按键 `| default` 回落 params.toml 的
 * （partials/site-config.html），空串等于「这一项没在 data 里定」，不会盖掉 params。
 */
const siteSchema = z.object({
  name: short.default(''),
  navName: short.default(''),
  siteUrl: absoluteUrl.default(''),
  description: long.default(''),
  keywords: z.array(short).max(40).default([]),
  logo: imageUrl.default(''),
  showLogo: z.boolean().default(true),
  showName: z.boolean().default(true),
  favicon: imageUrl.default(''),
  /**
   * 作者署名与默认作者标识不在这一页编辑：作者资料只有一处真值，
   * 在「我的信息 → 站长作者资料」（写 data/authors.yaml）里维护。
   * defaultAuthor 是本页唯一「不在这页改、但必须保住」的键：主题在构建期按
   * 「data 优先、params 兜底」取它，只存进 site_config 前台是读不到的 ——
   * 所以「站长作者资料」保存时会把它写进这份 site.json。
   * 登记进 schema + 下面保存时带回旧值，免得改一次导航栏就把站长标识抹成空。
   */
  defaultAuthor: short.default(''),
  ogImage: imageUrl.default(''),
  /** 落地页（/index，进站第一屏）的背景图：站内路径或完整外链都行，留空用主题自带的 img/bj.png */
  landingImage: imageUrl.default(''),
});

/**
 * 时刻页配置（卡片之外的页面级开关）。
 * 每时刻自己的 位置/正文/图片 写在 content/zh/moments/*.md 的 front matter，
 * 这一份只管：每页几条、显不显示位置、横幅、顶部身份栏、副标题。
 * 时刻评论区用哪套评论系统（momentCommentProvider）也在这一页改，但它是 site_config
 * 里的运行期开关（改了不用重建），不写进 data/moments.json。
 */
const momentsSchema = z.object({
  paginate: z.number().int().min(1).max(100).default(10),
  showLocation: z.boolean().default(true),
  defaultLocation: short.default(''),
  bannerShowBackground: z.boolean().default(true),
  bannerImage: imageUrl.default(''),
  showAvatar: z.boolean().default(true),
  showNickname: z.boolean().default(true),
  nickname: short.default(''),
  avatar: imageUrl.default(''),
});

/**
 * SEO 那一份（data/seo.json）：键名与 params.toml 的 [seo] 段一一对应，
 * 主题按「data 优先、params 兜底」合成（见 partials/seo-config.html）。
 * 键全部 snake_case —— params 的键会被 Hugo 小写化，而 JSON 保持原样，
 * 混用驼峰会让同一个参数在合成后出现两个键。
 */
const seoSchema = z.object({
  default_description: long.default(''),
  default_keywords: z.array(short).max(40).default([]),
  description_length: z.number().int().min(40).max(400).default(160),
  title_separator: short.default('·'),
  site_author: short.default(''),
  og_image_default: imageUrl.default(''),
  publisher_logo: imageUrl.default(''),
  enable_canonical: z.boolean().default(true),
  enable_robots: z.boolean().default(true),
  robots_default: short.default('index, follow'),
  robots_disallow: z.array(href).max(40).default(['/account/', '/admin/', '/api/']),
  robots_allow: z.array(href).max(40).default([]),
  enable_robots_sitemap: z.boolean().default(true),
  robots_crawl_delay: z.number().int().min(0).max(100).default(0),
  robots_host: href.default(''),
  enable_keywords: z.boolean().default(true),
  enable_og: z.boolean().default(true),
  enable_twitter: z.boolean().default(true),
  twitter_site: short.default(''),
  twitter_creator: short.default(''),
  enable_jsonld: z.boolean().default(true),
  enable_breadcrumb: z.boolean().default(true),
  enable_search_action: z.boolean().default(false),
  theme_color_light: short.default('#ffffff'),
  theme_color_dark: short.default('#1e1e1e'),
  color_scheme: short.default('light dark'),
});

const SECTIONS = {
  site: { file: 'site.json', schema: siteSchema, label: '基本信息' },
  nav: { file: 'nav.json', schema: navSchema, label: '导航栏' },
  home: { file: 'home.json', schema: homeSchema, label: '首页' },
  footer: { file: 'footer.json', schema: footerSchema, label: '页脚' },
  about: { file: 'about.json', schema: aboutSchema, label: '关于页' },
  works: { file: 'works.json', schema: worksSchema, label: '工坊' },
  moments: { file: 'moments.json', schema: momentsSchema, label: '时刻页' },
  apply: { file: 'apply.json', schema: applySchema, label: '友链申请' },
  seo: { file: 'seo.json', schema: seoSchema, label: 'SEO' },
} as const;

type SectionKey = keyof typeof SECTIONS;

/** schema 登记过的键（其余键属于「本站自己加的」，出盘时必须原样留着） */
function knownKeys(schema: (typeof SECTIONS)[SectionKey]['schema']): Set<string> {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  return new Set(Object.keys(shape ?? {}));
}

/**
 * data/seo.json 的键名归一：主题 exampleSite 早年那份带的是驼峰（defaultDescription…），
 * 而这里的 schema 与主题的模板只认下划线。不归一的话后台一打开就是二十几个默认值，
 * 站主随手点一次保存，把他填过的描述、关键词、OG 图、站长 logo 全抹成空。
 *
 * 两种拼法同时出现时以下划线那份为准（它是现在的规范写法）。
 * 只用在 seo 这一段：site.json 的 defaultAuthor、footer.json 的 socialRow1 本来就是驼峰，
 * 那些段的键名是另一套口径，不能一起转。
 */
function normalizeSeoKeys(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const entries = Object.entries(input as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) if (!/[A-Z]/.test(k)) out[k] = v;
  for (const [k, v] of entries) {
    const to = k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (!(to in out)) out[to] = v;
  }
  return out;
}

async function dataDir(env: Env): Promise<string> {
  const dir = (await getConfig(env, 'githubDataDir')) || 'data';
  return dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

const dataPath = (dir: string, file: string) => `${dir}/${file}`;

/** 读一个 data 文件；不存在返回 null（主题走 params 回落），解析失败给提示 */
async function readSection(
  env: Env,
  dir: string,
  key: SectionKey,
): Promise<{ value: unknown; extras: Record<string, unknown>; notice: string } | null> {
  let file: Awaited<ReturnType<typeof readRepoFile>> = null;
  try {
    file = await readRepoFile(env, dataPath(dir, SECTIONS[key].file));
  } catch (e) {
    // 读失败和「文件不存在」是两回事：前者要让前台知道自己在看的是回落后 params 的旧值
    return { value: null, extras: {}, notice: `${SECTIONS[key].label}：读 ${dataPath(dir, SECTIONS[key].file)} 失败（${e instanceof Error ? e.message : String(e)}），本页显示为空，保存会覆盖该文件。` };
  }
  if (!file || file.content.trim() === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(file.content);
  } catch (e) {
    return {
      value: null,
      extras: {},
      notice: `${SECTIONS[key].label}：${dataPath(dir, SECTIONS[key].file)} 解析失败（${e instanceof Error ? e.message : '格式错误'}），保存会以新内容覆盖。`,
    };
  }
  const input = key === 'seo' ? normalizeSeoKeys(raw) : raw;
  const res = SECTIONS[key].schema.safeParse(input);
  if (!res.success) {
    return {
      value: null,
      extras: {},
      notice: `${SECTIONS[key].label}：${dataPath(dir, SECTIONS[key].file)} 解析失败（${zodZh(res.error, '格式错误，这一份文件里哪个字段不对')}），保存会以新内容覆盖。`,
    };
  }
  const known = knownKeys(SECTIONS[key].schema);
  const extras = Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([k]) => !known.has(k)));
  const notice = Object.keys(extras).length
    ? `${SECTIONS[key].label}：这份文件里有 ${Object.keys(extras).length} 个面板没登记的键（${Object.keys(extras).slice(0, 5).join('、')}），面板上不显示，但保存会原样留着`
    : '';
  return { value: res.data, extras, notice };
}

/**
 * 把站长标识写进 data/site.json 的 defaultAuthor。
 *
 * 主题是在构建期取这个键的（data 优先、params 兜底），只存进 site_config 前台看不到，
 * 署名会一直顶着主题自带的占位作者。所以「我的信息 → 站长作者资料」保存时要落到这里。
 *
 * 只增改 defaultAuthor 这一个键，其余键原样留着：这份文件可能带着本站自己填过的值，
 * 甚至可能有 schema 没登记的键（siteSchema 是给「基本信息」表单校验用的，parse 会把
 * 没登记的键整条抹掉），所以这里不能拿 schema 过一遍。文件不存在就只写这一行，
 * 主题其它键照旧回落 params.toml。
 */
export async function setSiteDefaultAuthor(env: Env, handle: string): Promise<{ ok: boolean; detail: string }> {
  const dir = await dataDir(env);
  const path = dataPath(dir, SECTIONS.site.file);
  const existing = await readRepoFile(env, path).catch(() => null);
  let merged: Record<string, unknown> = {};
  if (existing?.content.trim()) {
    try {
      const parsed: unknown = JSON.parse(existing.content);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, detail: `${path} 不是对象，没敢覆盖` };
      }
      merged = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, detail: `${path} 不是合法 JSON，没敢覆盖` };
    }
  }
  if (String(merged.defaultAuthor ?? '') === handle) return { ok: true, detail: `${path} 已是该标识` };
  const res = await writeRepoFile(
    env,
    path,
    JSON.stringify({ ...merged, defaultAuthor: handle }, null, 2) + '\n',
    `zero-cms: 默认作者标识 ${handle}`,
    { action: 'params' },
  );
  return { ok: res.success, detail: res.success ? path : res.error ?? '写入失败' };
}

/**
 * 把站长的账号资料（昵称 + 头像）落到 data/owner.json，供前台关于页顶部取用。
 *
 * 后台「我的信息 → 账号资料」一保存就调这里一次：主题 about-content.html 读 data/owner.json 的
 * name / avatar（读不到才回落 params.aboutName / aboutAvatar），所以改完昵称头像不用再去
 * 动 params.toml，等一次站点构建就跟上。
 *
 * 为什么不并进 about.json：那份文件整份归「前端管理 → 关于页」的表单，它提交的是表单
 * schema 里的那些键，一起写就会在下次保存关于页时把同步过来的头像抹掉。owner.json 只有
 * 这一个写入方，主题侧也就不必判断谁覆盖了谁。
 *
 * 值没变就不写：一次保存等于一次提交 + 一轮 Pages 构建，白白费额度。changed=false 时调用方
 * 连带把构建也跳过，用户看到的提示才是「本来就是这样」而不是「又重建了一回」。
 */
export async function setOwnerProfile(
  env: Env,
  profile: { name: string; avatar: string },
): Promise<{ ok: boolean; changed: boolean; detail: string }> {
  if ((await repoBackend(env)) === 'none') return { ok: false, changed: false, detail: '未配置内容仓库，账号资料没处可写' };
  const dir = await dataDir(env);
  const path = dataPath(dir, 'owner.json');
  const existing = await readRepoFile(env, path).catch(() => null);
  const next = JSON.stringify({ name: profile.name, avatar: profile.avatar }, null, 2) + '\n';
  if (existing?.content.trim() === next.trim()) return { ok: true, changed: false, detail: `${path} 本来就是这份内容` };
  const res = await writeRepoFile(env, path, next, 'zero-cms: 同步站长账号资料到关于页', { action: 'params' });
  return { ok: res.success, changed: res.success, detail: res.success ? path : res.error ?? '写入失败' };
}

/**
 * 开关快照：把「凡是 *Enabled 的布尔配置」烘一份写进站点的 data/switches.json。
 *
 * 为什么要有这份文件：主题的 zero-switches.js 原本只能等 /api/config 回来才决定
 * 带 data-zero-switch 的区块露不露（构建期先写 hidden，免得关闭态闪一下）。
 * 线上实测 /about/ 的依赖链是 HTML → zero-switches.js → /api/config（4.8 秒），
 * 而 LCP 那段正文本来就在 HTML 里 —— 等于让一次网络往返拖住了已经在手的内容。
 * 有了这份快照，模板把它烘成 window.__zeroSwitches，脚本在 DOMContentLoaded 就定状态；
 * 运行期那路 /api/config 照样保留并覆盖它，所以后台改开关仍然当场生效，不会晚。
 *
 * 键按后缀自动收（不写死清单）：以后新增 xxxEnabled 开关不用两头改。
 * 值缺失或空串一律当「开」，与 zero-switches.js 的 isOn() 和 config 默认值同一口径。
 */
export const SWITCH_SNAPSHOT_FILE = 'switches.json';

export async function writeSwitchSnapshot(
  env: Env,
): Promise<{ written: boolean; path?: string; keys?: number; error?: string }> {
  if ((await repoBackend(env)) === 'none') return { written: false, error: '未配置内容仓库，开关快照没处写' };
  const dir = await dataDir(env);
  const all = await getAllConfig(env);
  const snap: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(all)) {
    if (!/Enabled$/.test(key)) continue;
    snap[key] = !(value === 'false' || value === '0' || value === '');
  }
  const path = dataPath(dir, SWITCH_SNAPSHOT_FILE);
  const next = JSON.stringify(snap, null, 2) + '\n';
  /** 内容一样就不提交：后台每次存设置都插一条 commit 会淹掉仓库历史 */
  const existing = await readRepoFile(env, path).catch(() => null);
  if (existing && existing.content.trim() === next.trim()) return { written: false, path, keys: Object.keys(snap).length };
  const res = await writeRepoFile(env, path, next, 'zero-cms: 同步开关快照（首屏不必等 /api/config）', { action: 'params' });
  return res.success
    ? { written: true, path, keys: Object.keys(snap).length }
    : { written: false, path, error: res.error ?? '写入失败' };
}

/**
 * 把「当前在用的第三方评论系统的接口域」同步进 CSP 的那两份文件。
 *
 * 为什么必须有这一件：CSP 的 connect-src 只放了接口自己的域与同父域通配，
 * 切到 waline / artalk / twikoo 之后脚本与样式都进得来（jsdelivr 在 script/style 白名单里），
 * 唯独它们往自己服务器发的那几个请求被拦 —— 页面照常出、评论区一直转圈，
 * 控制台一句 CSP 违规。文档里原本写着让人手补（DEPLOYMENT 的排查表），这里改成保存时就补上。
 *
 * 两份一起提交（一次 commit、一次 Pages 重建）：只改一份会出现「文章页评论正常、
 * 时刻页空白」这种半好半坏，比不改更难查。
 * 摘除只摘我们自己写进去的那些域（账本在中间件的 marker 里），人手补的域一个不碰。
 */
export async function syncCommentCsp(
  env: Env,
  actor?: { id?: string | null; name?: string | null } | null,
  ip?: string,
): Promise<{ written: string[]; origins: string[]; notes: string[]; error?: string }> {
  const backend = await repoBackend(env);
  if (backend === 'none') return { written: [], origins: [], notes: [], error: '没配内容仓库，CSP 没处改' };

  const provider = (await getConfig(env, 'commentProvider')) ?? 'zero';
  const momentProvider = (await getConfig(env, 'momentCommentProvider')) ?? 'zero';
  const providersJson = (await getConfig(env, 'commentProviders')) ?? '';
  const { origins, notes } = commentConnectOrigins({ provider, momentProvider, providersJson });

  const mw = await readRepoFile(env, 'functions/_middleware.ts').catch(() => null);
  const hd = await readRepoFile(env, 'static/_headers').catch(() => null);
  /* marker 里那份就是「我们补过哪些域」的账本。老站文件里没有 marker 时账本是空的，
     于是这次只会往里加、不会误删任何东西；而两家评论区都回到 zero 且文件本来没 marker，
     就什么都不做（不能为了「补一段结构」给一个从不用第三方评论的站插一条空提交）。 */
  const managed = mw ? (readManagedOrigins(mw.content) ?? []) : [];
  if (!mw) notes.push('这个站没有 functions/_middleware.ts（生成站点时还没配接口地址）—— 这次的域只补进 static/_headers。');
  if (!hd) notes.push('没读到 static/_headers，这次只改了边缘中间件那一份。');

  const add = origins.filter((o) => !managed.includes(o));
  const remove = managed.filter((o) => !origins.includes(o));
  if (!add.length && !remove.length) return { written: [], origins, notes };

  const files: { path: string; content: string }[] = [];
  if (mw && (add.length || remove.length)) {
    /* 走到这里要么有新域要写、要么 marker 里有过域要摘，
       不会出现「给一个从不用第三方评论的站补一段空结构」——那种情况上面已经提前返回了。 */
    const r = applyManagedOriginsToMiddleware(mw.content, origins);
    if (r.changed) files.push({ path: 'functions/_middleware.ts', content: r.text });
    else if (r.reason) notes.push(r.reason);
  }
  if (hd) {
    const r = applyConnectOriginsToHeaders(hd.content, add, remove);
    if (r.changed) files.push({ path: 'static/_headers', content: r.text });
    else if (r.reason) notes.push(r.reason);
  }
  if (!files.length) return { written: [], origins, notes };

  const msg = `zero-cms: 评论接口域进 CSP（补 ${add.join(' ') || '无'}${remove.length ? ` / 摘 ${remove.join(' ')}` : ''}）`;
  const res = await commitRepoFiles(env, files, msg, { actor: actor ?? null, ip, action: 'params' });
  if (!res.success) return { written: [], origins, notes: [...notes, `CSP 没写进去：${res.error ?? '提交失败'}`] };
  return { written: files.map((f) => f.path), origins, notes };
}

/** 页脚图标在 params.toml 里的回落值（与主题 cms/list.html 的规则一致：data 为空才用 params） */
async function paramsFooterIcons(env: Env): Promise<Record<string, unknown[]>> {
  const empty = { services: [], socialRow1: [], socialRow2: [] };
  let content = '';
  for (const path of ['config/_default/params.toml', 'config/params.toml', 'params.toml']) {
    const file = await readRepoFile(env, path).catch(() => null);
    if (file?.content?.trim()) { content = file.content; break; }
  }
  if (!content) return empty;
  try {
    const parsed = parseToml(content) as { footer?: Record<string, unknown> };
    const f = parsed.footer;
    if (!f || typeof f !== 'object') return empty;
    const norm = (v: unknown) => {
      if (!Array.isArray(v)) return [];
      return v.flatMap((x) => {
        if (!x || typeof x !== 'object') return [];
        const o = x as Record<string, unknown>;
        const name = String(o.name ?? '').trim();
        const link = String(o.link ?? o.url ?? '').trim();
        if (!name || !link) return [];
        return [{
          name,
          icon: String(o.icon ?? ''),
          img: String(o.img ?? o.image ?? ''),
          link,
          invert: Boolean(o.invert),
          ...(typeof o.showName === 'boolean' ? { showName: o.showName } : {}),
        }];
      });
    };
    return {
      services: norm(f.services),
      socialRow1: norm(f.socialRow1 ?? f.social_row1),
      socialRow2: norm(f.socialRow2 ?? f.social_row2),
    };
  } catch {
    return empty;
  }
}

app.get('/', async (c) => {
  requireAdmin(c);
  const dir = await dataDir(c.env);
  const out: Record<string, unknown> = {};
  const notices: string[] = [];
  for (const key of Object.keys(SECTIONS) as SectionKey[]) {
    const hit = await readSection(c.env, dir, key);
    out[key] = hit?.value ?? null;
    if (hit?.notice) notices.push(hit.notice);
  }
  /* 页脚三组图标在 data/footer.json 里为空时，前台会回落到 params.toml；后台也把这份
     实际生效的值带回来，否则站主会看到「前台有图标、后台是空的」，以为设置丢了。 */
  const footer = out.footer as Record<string, unknown> | null;
  if (footer && typeof footer === 'object') {
    const missing = ['services', 'socialRow1', 'socialRow2'].filter((k) => !Array.isArray(footer[k]) || (footer[k] as unknown[]).length === 0);
    if (missing.length) {
      const fallback = await paramsFooterIcons(c.env);
      let filled = false;
      for (const k of missing) {
        const v = fallback[k];
        if (Array.isArray(v) && v.length) {
          footer[k] = v;
          filled = true;
        }
      }
      if (filled) notices.push('页脚图标/社交链接在 data/footer.json 里为空，这里显示的是 params.toml 的回落值；保存后会写进 data/footer.json');
    }
  }
  return ok({ ...out, dataDir: dir, notice: notices.join('；') || null });
});

const saveSchema = z.object({
  site: z.unknown().optional(),
  nav: z.unknown().optional(),
  home: z.unknown().optional(),
  footer: z.unknown().optional(),
  about: z.unknown().optional(),
  works: z.unknown().optional(),
  moments: z.unknown().optional(),
  apply: z.unknown().optional(),
  seo: z.unknown().optional(),
  triggerBuild: z.boolean().optional().default(true),
});

app.post('/', async (c) => {
  const admin = requireAdmin(c);
  const parsed = saveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '没有要保存的内容');

  if ((await repoBackend(c.env)) === 'none') {
    fail(500, '未配置内容仓库（githubOwner/githubRepo + GITHUB_TOKEN，或本地 GIT_LOCAL_DIR），无法写入前端设置');
  }

  // 先整体校验，任何一段不合法都不落盘，免得存一半
  const dir = await dataDir(c.env);
  const pending: { key: SectionKey; content: string }[] = [];
  /** 站点地址改前/改后的值：改完要连带把 hugo.toml 的 baseURL 与友链申请页的两条地址一起写掉 */
  let siteUrlOld = '';
  let siteUrlNew = '';
  /** 这次请求里带了、但 schema 没登记过的键。zod 会把它们静默丢掉而回执仍是 200，
      调用方只能靠猜（T7 体检实测：写成 siteName / author 而不是 name / defaultAuthor 时，
      值没进去而屏幕上看不出任何异常）。这里不改判定、不学 /api/admin/config 那样整批 400
      （后台面板和脚本可能带冗余字段，突然报错等于制造新故障），只把它们点名回出去。 */
  const ignored: string[] = [];
  for (const key of Object.keys(SECTIONS) as SectionKey[]) {
    const raw = parsed.data[key];
    if (raw === undefined) continue;
    if (raw === null) {
      pending.push({ key, content: '' });
      continue;
    }
    const probe = (key === 'seo' ? normalizeSeoKeys(raw) : raw) as Record<string, unknown>;
    if (probe && typeof probe === 'object' && !Array.isArray(probe)) {
      const known = knownKeys(SECTIONS[key].schema);
      for (const k of Object.keys(probe)) if (!known.has(k)) ignored.push(`${SECTIONS[key].label}.${k}`);
    }
    const res = SECTIONS[key].schema.safeParse(probe);
    if (!res.success) fail(400, `${SECTIONS[key].label}保存失败：${zodZh(res.error, '字段不合法')}`);
    const prev = await readSection(c.env, dir, key);
    /* 出盘不能用「过完 schema 的对象」这一份：schema 只登记面板上那些键，
       本站自己往 data/*.json 里加的键会被 z.object 整条抹掉。所以先把不认识的键垫在下面，
       再用校验过的值盖上去。同一文件里 site / footer 还要带现值，也顺手复用这一次读取。 */
    let value = { ...(prev?.extras ?? {}), ...(res.data as Record<string, unknown>) };
    if (key === 'site' && !String(value.defaultAuthor ?? '').trim()) {
      // 基本信息页没有这个输入框：保存时带回仓库里的现值，别把它抹成空串
      const old = (prev?.value as { defaultAuthor?: string } | undefined)?.defaultAuthor ?? '';
      if (old) value = { ...value, defaultAuthor: old };
    }
    if (key === 'site') {
      siteUrlOld = String((prev?.value as { siteUrl?: string } | undefined)?.siteUrl ?? '').trim();
      siteUrlNew = String((value as { siteUrl?: string }).siteUrl ?? '').trim();
    }
    if (key === 'footer') {
      /** 这三组键是可选的：面板没送（旧版面板、或别的页面整段保存）时
          必须把仓库里的现值带回去，否则一次保存就把服务图标与社交链接整段抹掉。 */
      const before = prev?.value as Record<string, unknown> | undefined;
      for (const k of ['services', 'socialRow1', 'socialRow2'] as const) {
        if (value[k] === undefined && Array.isArray(before?.[k])) value = { ...value, [k]: before[k] };
      }
      /** showServiceName 在 schema 里有默认值 true，所以「面板没送」和「用户明确关掉」
          过完 schema 长得一样 —— 只能看送进来的原文，没写这条时沿用仓库现值。 */
      if ((raw as Record<string, unknown>)?.showServiceName === undefined && typeof before?.showServiceName === 'boolean') {
        value = { ...value, showServiceName: before.showServiceName };
      }
    }
    pending.push({ key, content: JSON.stringify(value, null, 2) + '\n' });
  }
  if (!pending.length) fail(400, '没有要保存的内容');

  /* 站点地址一变，连带改两处 —— 否则就是「后台改了地址，前台 canonical 还是旧域名」：
       ① hugo.toml 的 baseURL：canonical / og:url / sitemap / RSS / robots 全部由它生成；
       ② 友链申请页（data/apply.json）里「链接」「RSS」两条展示值（只替换与旧地址完全相同的值）。
     `siteUrlOld` 为空也算「要跟着改」：新站的第一次填地址（site.json 里那一份本来就是空的）
     同样得把 hugo.toml 的 baseURL 定下来，不然第一版站点永远建在 create:site 写的占位域名上。 */
  const extra: { path: string; content: string }[] = [];
  if (siteUrlNew && siteUrlNew !== siteUrlOld) {
    const norm = (u: string) => u.replace(/\/+$/, '');
    const oldBase = norm(siteUrlOld);
    const newBase = norm(siteUrlNew);

    const hugo = await readRepoFile(c.env, 'hugo.toml').catch(() => null);
    if (hugo?.content && /^baseURL\s*=\s*"[^"]*"/m.test(hugo.content) && !hugo.content.includes(`baseURL = "${newBase}/"`)) {
      extra.push({ path: 'hugo.toml', content: hugo.content.replace(/^baseURL\s*=\s*"[^"]*"/m, `baseURL = "${newBase}/"`) });
    }

    const applyPath = dataPath(dir, 'apply.json');
    const applyFile = await readRepoFile(c.env, applyPath).catch(() => null);
    /* 旧地址为空时**不**动 apply.json：那几处替换按「与旧地址完全相同」命中，
       空串会撞上留空的展示项，把不相干的两行改掉。 */
    if (oldBase && applyFile?.content) {
      try {
        const j = JSON.parse(applyFile.content) as { myInfo?: { label?: string; value?: string }[] };
        let touched = false;
        for (const it of j.myInfo ?? []) {
          const v = norm(String(it.value ?? '').trim());
          if (v === oldBase) {
            it.value = `${newBase}/`;
            touched = true;
          } else if (v === `${oldBase}/index.xml`) {
            it.value = `${newBase}/index.xml`;
            touched = true;
          }
        }
        if (touched) extra.push({ path: applyPath, content: JSON.stringify(j, null, 2) + '\n' });
      } catch {
        /* apply.json 内容坏了就不碰它，别把整次保存拖垮 */
      }
    }
  }

  const written: string[] = [];
  const failed: string[] = [];
  const files = [
    ...pending.filter((p) => p.content !== '').map((p) => ({ path: dataPath(dir, SECTIONS[p.key].file), content: p.content })),
    ...extra,
  ];
  // 空内容 = 删除该段，主题回到 params.toml 的默认值
  const deletes = pending.filter((p) => p.content === '').map((p) => dataPath(dir, SECTIONS[p.key].file));
  const message = `zero-cms: 更新前端设置（${pending.map((p) => SECTIONS[p.key].label).join('、')}）`;
  if (files.length || deletes.length) {
    /* 一次提交写全部：每个提交都会触发一次 Pages 构建，逐个写等于把「一次保存」拆成好几次构建 */
    const res = await commitRepoFiles(c.env, files, message, { actor: admin, ip: clientIp(c), action: 'params', deletes });
    if (res.success) written.push(...files.map((f) => f.path), ...deletes);
    else failed.push(res.error ?? '写入失败');
  }

  // 基本信息同步一份进 site_config：邮件里的站点名与链接前缀、群发、备份文件名、
  // 后台仪表盘的跳转读的都是那几个键，不同步就会出现前台改了名而信里还是旧的。
  const siteItem = pending.find((p) => p.key === 'site' && p.content !== '');
  if (siteItem) {
    const s = siteSchema.parse(JSON.parse(siteItem.content));
    // 没填的项保持 site_config 里的现值，别用空串把邮件里的地址前缀抹掉
    if (s.name.trim()) await setConfig(c.env, 'siteName', s.name.trim());
    if (s.siteUrl.trim()) await setConfig(c.env, 'siteUrl', s.siteUrl.trim());
    if (s.description.trim()) await setConfig(c.env, 'siteDescription', s.description.trim());
    if (s.logo.trim()) await setConfig(c.env, 'siteLogo', s.logo.trim());
    if (s.favicon.trim()) await setConfig(c.env, 'siteFavicon', s.favicon.trim());
    /** 名字刚被站主改掉：site-name.ts 有一份 60 秒的 isolate 缓存，不清就会出现
     *  「后台已改名、接下来一分钟的信还是旧名字」这种自己骗自己的窗口。 */
    invalidateSiteNameCache();
  }

  const build = written.length && parsed.data.triggerBuild ? await triggerPagesBuild(c.env) : null;
  if (failed.length && !written.length) fail(502, `前端设置写入失败：${failed.join('；')}`);
  /* 这一条通道写的就是 data/*.json：非标量字段（head_html 那种）会让 Hugo 整站失败，
     而回执以前只说「已保存 N 个文件」。与文章保存共用同一个体检，别再各写一份口径。 */
  const health = written.length ? await runLocalBuildCheck(c.env) : null;

  return ok({
    written,
    notice: failed.length ? `部分未保存：${failed.join('；')}` : null,
    /** 面板/脚本这次送的、schema 没登记的键（形如「基本信息.siteName」）：它们没有落盘。空数组=一切有效 */
    ignored,
    build,
    buildHealth: health,
    message: (written.length
      ? buildReceipt(build, `已保存 ${written.length} 个文件`) + (ignored.length ? `；另有 ${ignored.length} 个字段本站面板不认识，未保存` : '')
      : '未保存任何文件') + buildHealthReceipt(health),
  });
});

export default app;
