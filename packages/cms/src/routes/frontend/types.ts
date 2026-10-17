/**
 * 前端管理的数据类型与「表单值 ↔ 接口值」互转。
 *
 * 字段名与上限全部对齐 packages/api/src/routes/frontend.ts 的 zod：
 * 短文本 200 / 链接 600 / 长文本 4000；nav 60、icp 20、bio/declaration/site 各 60、
 * contacts 60、works 80；weight 是 -9999 ~ 9999 的整数。
 * 前端先按这套拦一遍，免得用户点了保存才看到后端报错。
 */

export type SectionKey = 'site' | 'nav' | 'home' | 'footer' | 'about' | 'works' | 'moments' | 'apply' | 'seo';

export interface SiteSection {
  name: string;
  navName: string;
  /** 站点主地址：邮件里的确认 / 退订链接前缀，应与 config.toml 的 baseURL 一致 */
  siteUrl: string;
  description: string;
  keywords: string[];
  logo: string;
  showLogo: boolean;
  showName: boolean;
  favicon: string;
  ogImage: string;
  /** 落地页（/index 进站第一屏）背景图，留空用主题自带的 img/bj.png */
  landingImage: string;
}

export interface NavItem {
  name: string;
  url: string;
  weight: number;
  icon: string;
  image: string;
  iconOnly: boolean;
  external: boolean;
  /** '' = 主菜单；'controls' = 右侧图标区（与主题/语言开关按 weight 一起排序） */
  position: '' | 'controls';
  /** 有子项时必填，子项用 parent 指回来 */
  identifier: string;
  parent: string;
  /** 主题侧的账号入口标记（menus 里的 zero_account） */
  zeroAccount: boolean;
}
export interface NavSection {
  items: NavItem[];
}

export interface HomeSection {
  layout: 'bento' | 'grid';
  desc: string;
  showDesc: boolean;
}

export interface IcpItem {
  text: string;
  link: string;
}
export interface FooterIconItem {
  name: string;
  /** Font Awesome 类名，如 fa-brands fa-github */
  icon: string;
  /** 填了图片路径就用图片，否则用 icon */
  img: string;
  link: string;
  /** 深色模式下反色（图片 logo 常见需求） */
  invert: boolean;
}
export interface FooterSection {
  copyrightText: string;
  showPoweredBy: boolean;
  poweredByText: string;
  poweredByLink: string;
  icpItems: IcpItem[];
  /** 中栏「支持服务」图标行 */
  services: FooterIconItem[];
  /** 右栏两排社交图标 */
  socialRow1: FooterIconItem[];
  socialRow2: FooterIconItem[];
}

export interface ContactItem {
  label: string;
  text: string;
  url: string;
  external: boolean;
}
export interface AboutSection {
  desc: string;
  tagline: string;
  bio: string[];
  declaration: string[];
  site: string[];
  contacts: ContactItem[];
}

export interface WorkItem {
  title: string;
  desc: string;
  status: string;
  url: string;
}
export interface WorksSection {
  desc: string;
  items: WorkItem[];
}

/** 「我的信息 / 提交示例」的一行：前台一行一条，复制按钮按这个顺序取纯文本 */
export interface ApplyRow {
  label: string;
  value: string;
}
/**
 * 友链页「申请友链」那三块（data/apply.json）。
 * 名单本身在 data/links.yaml（后台「友链」维护），这一页只管三段说明文字。
 */
export interface ApplySection {
  intro: string;
  requirements: string[];
  myInfo: ApplyRow[];
  submitExample: ApplyRow[];
}

export interface MomentsSection {
  paginate: number;
  showLocation: boolean;
  defaultLocation: string;
  bannerShowBackground: boolean;
  bannerImage: string;
  showAvatar: boolean;
  showNickname: boolean;
  nickname: string;
  avatar: string;
}

/**
 * SEO（data/seo.json）。
 * 表单里用驼峰，落盘统一转成 snake_case —— 那份文件要和 params.toml 的 [seo] 段
 * 逐键对应（Hugo 会把 params 的键小写化，两种拼法混用会留下两个键）。
 */
export interface SeoSection {
  defaultDescription: string;
  defaultKeywords: string[];
  descriptionLength: number;
  titleSeparator: string;
  siteAuthor: string;
  ogImageDefault: string;
  publisherLogo: string;
  enableCanonical: boolean;
  enableRobots: boolean;
  robotsDefault: string;
  robotsDisallow: string[];
  robotsAllow: string[];
  enableRobotsSitemap: boolean;
  robotsCrawlDelay: number;
  robotsHost: string;
  enableKeywords: boolean;
  enableOg: boolean;
  enableTwitter: boolean;
  twitterSite: string;
  twitterCreator: string;
  enableJsonld: boolean;
  enableBreadcrumb: boolean;
  enableSearchAction: boolean;
  themeColorLight: string;
  themeColorDark: string;
  colorScheme: string;
}

/** GET /api/admin/frontend 的 data */
export interface FrontendData {
  site: SiteSection | null;
  nav: NavSection | null;
  home: HomeSection | null;
  footer: FooterSection | null;
  about: AboutSection | null;
  works: WorksSection | null;
  moments: MomentsSection | null;
  apply: ApplySection | null;
  seo: SeoSection | null;
  dataDir: string;
  notice: string | null;
}

/** POST /api/admin/frontend 的 data */
export interface SaveResult {
  written: string[];
  notice: string | null;
  /** triggerPagesBuild 的返回：没配 Pages 重建 Hook 时 triggered=false 并带原因 */
  build: { triggered?: boolean; error?: string } | null;
  message: string;
}

/** 各段共用这一个形状，方便统一做脏检查 / 载荷拼装 */
export interface Forms {
  site: SiteSection;
  nav: NavSection;
  home: HomeSection;
  footer: FooterSection;
  about: AboutSection;
  works: WorksSection;
  moments: MomentsSection;
  apply: ApplySection;
  seo: SeoSection;
}

/** 一条本地校验问题：section 决定它显示在哪个子标签、能不能点跳转 */
export interface Issue {
  section: SectionKey;
  message: string;
}

export const SECTION_KEYS: SectionKey[] = ['site', 'nav', 'home', 'footer', 'about', 'works', 'moments', 'apply', 'seo'];

/**
 * 每一段的中文名、落盘文件名、子标签文字，以及「这一份 data 文件删掉之后前台改读什么」。
 * 八段回落 params.toml，只有「友链申请」回落的是友链页自己的正文
 * （content/links/_index.md 里手写的 .apply-col），所以那一句得单独写，不然界面会骗人。
 */
export const SECTION_META: Record<SectionKey, { label: string; file: string; tab: string; fallback: string }> = {
  site: { label: '基本信息', file: 'site.json', tab: '基本信息', fallback: 'params.toml' },
  nav: { label: '导航栏', file: 'nav.json', tab: '导航栏', fallback: 'params.toml' },
  home: { label: '首页', file: 'home.json', tab: '首页', fallback: 'params.toml' },
  footer: { label: '页脚', file: 'footer.json', tab: '页脚', fallback: 'params.toml' },
  about: { label: '关于页', file: 'about.json', tab: '关于页', fallback: 'params.toml' },
  works: { label: '工坊', file: 'works.json', tab: '工坊', fallback: 'params.toml' },
  moments: { label: '时刻页', file: 'moments.json', tab: '时刻页', fallback: 'params.toml' },
  apply: { label: '友链申请', file: 'apply.json', tab: '友链申请', fallback: '友链页正文' },
  seo: { label: 'SEO', file: 'seo.json', tab: 'SEO', fallback: 'params.toml' },
};

export const LIMIT = { short: 200, href: 600, long: 4000, weightMin: -9999, weightMax: 9999 };

export const CAP: Record<'nav' | 'icp' | 'icons' | 'paragraph' | 'contacts' | 'works' | 'requirements' | 'infoRow', number> = {
  nav: 60,
  icp: 20,
  /** 页脚三组图标行各自的上限，与后端 footerSchema 的 max(20) 一致 */
  icons: 20,
  paragraph: 60,
  contacts: 60,
  works: 80,
  /** 友链要求的条数上限，与后端 applySchema 的 max(30) 一致 */
  requirements: 30,
  /** 「我的信息」「提交示例」各自行数上限，与后端 max(20) 一致 */
  infoRow: 20,
};

/* ---------------------------------------------------------------- 基础读取 */

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const bool = (v: unknown, d = false): boolean =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d;
const int = (v: unknown, d = 0): number => {
  const raw = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(raw)) return d;
  return Math.min(LIMIT.weightMax, Math.max(LIMIT.weightMin, Math.trunc(raw)));
};
const trimmed = (v: unknown, fallback: string): string => {
  const s = str(v).trim();
  return s || fallback;
};

/* -------------------------------------------------------------- 空白模板 */

export const blankNavItem = (): NavItem => ({
  name: '',
  url: '',
  weight: 0,
  icon: '',
  image: '',
  iconOnly: false,
  external: false,
  position: '',
  identifier: '',
  parent: '',
  zeroAccount: false,
});

/**
 * 空白模板的默认值。
 * 注意：后台没有 TOML 解析，这些值不代表 params.toml 的当前内容，只是「新建一份配置」时
 * 最不容易出错的起点（页面上也照实这么告诉用户）。
 */
export const blankForms = (): Forms => ({
  site: {
    name: '',
    navName: '',
    siteUrl: '',
    description: '',
    keywords: [],
    logo: '',
    showLogo: true,
    showName: true,
    favicon: '',
    ogImage: '',
    landingImage: '',
  },
  nav: { items: [blankNavItem()] },
  home: { layout: 'bento', desc: '', showDesc: true },
  footer: { copyrightText: '', showPoweredBy: true, poweredByText: '', poweredByLink: '', icpItems: [], services: [], socialRow1: [], socialRow2: [] },
  about: { desc: '', tagline: '', bio: [''], declaration: [''], site: [''], contacts: [] },
  works: { desc: '', items: [{ title: '', desc: '', status: '', url: '' }] },
  moments: {
    paginate: 10,
    showLocation: true,
    defaultLocation: '',
    bannerShowBackground: true,
    bannerImage: '',
    showAvatar: true,
    showNickname: true,
    nickname: '',
    avatar: '',
  },
  // 空白模板 = 三段全空：前台这一段就退回「读不到 data 时」的样子（页面正文）
  apply: {
    intro: '',
    requirements: [''],
    myInfo: [{ label: '', value: '' }],
    submitExample: [{ label: '', value: '' }],
  },
  // 空白模板 = params.toml 里 [seo] 的那一份默认值，主题不依赖这一层也能跑
  seo: {
    defaultDescription: '',
    defaultKeywords: [],
    descriptionLength: 160,
    titleSeparator: '·',
    siteAuthor: '',
    ogImageDefault: '',
    publisherLogo: '',
    enableCanonical: true,
    enableRobots: true,
    robotsDefault: 'index, follow',
    robotsDisallow: ['/account/', '/admin/', '/api/'],
    robotsAllow: [],
    enableRobotsSitemap: true,
    robotsCrawlDelay: 0,
    robotsHost: '',
    enableKeywords: true,
    enableOg: true,
    enableTwitter: true,
    twitterSite: '',
    twitterCreator: '',
    enableJsonld: true,
    enableBreadcrumb: true,
    enableSearchAction: false,
    themeColorLight: '#ffffff',
    themeColorDark: '#1e1e1e',
    colorScheme: 'light dark',
  },
});

/* ------------------------------------------------------------ 规整（读取） */

export function normNav(raw: unknown): NavSection {
  return {
    items: arr(rec(raw).items).map((x) => {
      const o = rec(x);
      return {
        name: str(o.name),
        url: str(o.url),
        weight: int(o.weight, 0),
        icon: str(o.icon),
        image: str(o.image),
        iconOnly: bool(o.iconOnly),
        external: bool(o.external),
        position: o.position === 'controls' ? 'controls' : '',
        identifier: str(o.identifier),
        parent: str(o.parent),
        zeroAccount: bool(o.zeroAccount),
      };
    }),
  };
}

export function normHome(raw: unknown): HomeSection {
  const o = rec(raw);
  return { layout: o.layout === 'grid' ? 'grid' : 'bento', desc: str(o.desc), showDesc: bool(o.showDesc) };
}

const normFooterIcon = (x: unknown): FooterIconItem => {
  const o = rec(x);
  return { name: str(o.name), icon: str(o.icon), img: str(o.img), link: str(o.link), invert: o.invert === true };
};

export function normFooter(raw: unknown): FooterSection {
  const o = rec(raw);
  return {
    copyrightText: str(o.copyrightText),
    showPoweredBy: bool(o.showPoweredBy),
    poweredByText: str(o.poweredByText),
    poweredByLink: str(o.poweredByLink),
    icpItems: arr(o.icpItems).map((x) => ({ text: str(rec(x).text), link: str(rec(x).link) })),
    services: arr(o.services).map(normFooterIcon),
    socialRow1: arr(o.socialRow1).map(normFooterIcon),
    socialRow2: arr(o.socialRow2).map(normFooterIcon),
  };
}

export function normAbout(raw: unknown): AboutSection {
  const o = rec(raw);
  return {
    desc: str(o.desc),
    tagline: str(o.tagline),
    bio: arr(o.bio).map(str),
    declaration: arr(o.declaration).map(str),
    site: arr(o.site).map(str),
    contacts: arr(o.contacts).map((x) => {
      const c = rec(x);
      return { label: str(c.label), text: str(c.text), url: str(c.url), external: bool(c.external, true) };
    }),
  };
}

export function normWorks(raw: unknown): WorksSection {
  const o = rec(raw);
  return {
    desc: str(o.desc),
    items: arr(o.items).map((x) => {
      const w = rec(x);
      return { title: str(w.title), desc: str(w.desc), status: str(w.status), url: str(w.url) };
    }),
  };
}

export function normApply(raw: unknown): ApplySection {
  const o = rec(raw);
  const rows = (v: unknown): ApplyRow[] => arr(v).map((x) => ({ label: str(rec(x).label), value: str(rec(x).value) }));
  return {
    intro: str(o.intro),
    requirements: arr(o.requirements).map(str),
    myInfo: rows(o.myInfo),
    submitExample: rows(o.submitExample),
  };
}

export function normSite(raw: unknown): SiteSection {
  const o = rec(raw);
  return {
    name: str(o.name),
    navName: str(o.navName),
    siteUrl: str(o.siteUrl),
    description: str(o.description),
    keywords: arr(o.keywords).map(str).filter(Boolean),
    logo: str(o.logo),
    showLogo: bool(o.showLogo, true),
    showName: bool(o.showName, true),
    favicon: str(o.favicon),
    ogImage: str(o.ogImage),
    landingImage: str(o.landingImage),
  };
}

export function normMoments(raw: unknown): MomentsSection {
  const o = rec(raw);
  return {
    paginate: Math.min(100, Math.max(1, int(o.paginate, 10) || 10)),
    showLocation: bool(o.showLocation, true),
    defaultLocation: str(o.defaultLocation),
    bannerShowBackground: bool(o.bannerShowBackground, true),
    bannerImage: str(o.bannerImage),
    showAvatar: bool(o.showAvatar, true),
    showNickname: bool(o.showNickname, true),
    nickname: str(o.nickname),
    avatar: str(o.avatar),
  };
}

/** 落盘的 snake_case → 表单的驼峰 */
export function normSeo(raw: unknown): SeoSection {
  const o = rec(raw);
  const b = blankForms().seo;
  return {
    defaultDescription: str(o.default_description),
    defaultKeywords: arr(o.default_keywords).map((x) => str(x).trim()).filter(Boolean),
    descriptionLength: Math.min(400, Math.max(40, int(o.description_length, b.descriptionLength) || b.descriptionLength)),
    titleSeparator: trimmed(o.title_separator, b.titleSeparator),
    siteAuthor: str(o.site_author),
    ogImageDefault: str(o.og_image_default),
    publisherLogo: str(o.publisher_logo),
    enableCanonical: bool(o.enable_canonical, true),
    enableRobots: bool(o.enable_robots, true),
    robotsDefault: trimmed(o.robots_default, b.robotsDefault),
    robotsDisallow: arr(o.robots_disallow).map((x) => str(x).trim()).filter(Boolean),
    robotsAllow: arr(o.robots_allow).map((x) => str(x).trim()).filter(Boolean),
    enableRobotsSitemap: bool(o.enable_robots_sitemap, true),
    robotsCrawlDelay: Math.min(100, Math.max(0, int(o.robots_crawl_delay, 0))),
    robotsHost: str(o.robots_host),
    enableKeywords: bool(o.enable_keywords, true),
    enableOg: bool(o.enable_og, true),
    enableTwitter: bool(o.enable_twitter, true),
    twitterSite: str(o.twitter_site),
    twitterCreator: str(o.twitter_creator),
    enableJsonld: bool(o.enable_jsonld, true),
    enableBreadcrumb: bool(o.enable_breadcrumb, true),
    enableSearchAction: bool(o.enable_search_action, false),
    themeColorLight: trimmed(o.theme_color_light, b.themeColorLight),
    themeColorDark: trimmed(o.theme_color_dark, b.themeColorDark),
    colorScheme: trimmed(o.color_scheme, b.colorScheme),
  };
}

const NORMALIZERS: Record<SectionKey, (raw: unknown) => Forms[SectionKey]> = {
  site: normSite,
  nav: normNav,
  home: normHome,
  footer: normFooter,
  about: normAbout,
  works: normWorks,
  moments: normMoments,
  apply: normApply,
  seo: normSeo,
};

/** 接口返回的一格 → 表单值；非法/缺失一律退回空白模板，不让页面崩 */
export function normalizeSection(key: SectionKey, raw: unknown): Forms[SectionKey] {
  return raw === null || raw === undefined ? blankForms()[key] : NORMALIZERS[key](raw);
}

export function readFrontendData(payload: unknown): FrontendData {
  const d = rec(payload);
  return {
    site: d.site === null || d.site === undefined ? null : normSite(d.site),
    nav: d.nav === null || d.nav === undefined ? null : normNav(d.nav),
    home: d.home === null || d.home === undefined ? null : normHome(d.home),
    footer: d.footer === null || d.footer === undefined ? null : normFooter(d.footer),
    about: d.about === null || d.about === undefined ? null : normAbout(d.about),
    works: d.works === null || d.works === undefined ? null : normWorks(d.works),
    moments: d.moments === null || d.moments === undefined ? null : normMoments(d.moments),
    apply: d.apply === null || d.apply === undefined ? null : normApply(d.apply),
    seo: d.seo === null || d.seo === undefined ? null : normSeo(d.seo),
    dataDir: trimmed(d.dataDir, 'data'),
    notice: typeof d.notice === 'string' && d.notice.trim() ? d.notice.trim() : null,
  };
}

/* ------------------------------------------------------------ 规整（写入） */

/** 图标条目写出去之前统一去空格；空行由调用方滤掉（主题本来也不渲染没地址的条目） */
const cleanFooterIcon = (x: FooterIconItem) => ({
  name: x.name.trim(),
  icon: x.icon.trim(),
  img: x.img.trim(),
  link: x.link.trim(),
  invert: x.invert === true,
});


/**
 * 提交前清洗：去首尾空格；丢掉「整行都是空」的条目（主题本来也不显示空条目）。
 * 返回值的字段名严格按接口契约，多余的键不写出去。
 */
export function payloadOf(key: SectionKey, form: Forms[SectionKey]): unknown {
  if (key === 'site') {
    const f = form as SiteSection;
    return {
      name: f.name.trim(),
      navName: f.navName.trim(),
      siteUrl: f.siteUrl.trim(),
      description: f.description.trim(),
      keywords: f.keywords.map((x) => x.trim()).filter(Boolean),
      logo: f.logo.trim(),
      showLogo: !!f.showLogo,
      showName: !!f.showName,
      favicon: f.favicon.trim(),
      ogImage: f.ogImage.trim(),
      landingImage: f.landingImage.trim(),
    };
  }
  if (key === 'moments') {
    const f = form as MomentsSection;
    return {
      paginate: Math.min(100, Math.max(1, int(f.paginate, 10) || 10)),
      showLocation: !!f.showLocation,
      defaultLocation: f.defaultLocation.trim(),
      bannerShowBackground: !!f.bannerShowBackground,
      bannerImage: f.bannerImage.trim(),
      showAvatar: !!f.showAvatar,
      showNickname: !!f.showNickname,
      nickname: f.nickname.trim(),
      avatar: f.avatar.trim(),
    };
  }
  if (key === 'seo') {
    const f = form as SeoSection;
    // 落盘全部 snake_case，与 params.toml 的 [seo] 段同名，主题合成时才是同一个键
    return {
      default_description: f.defaultDescription.trim(),
      default_keywords: f.defaultKeywords.map((x) => x.trim()).filter(Boolean),
      description_length: Math.min(400, Math.max(40, int(f.descriptionLength, 160) || 160)),
      title_separator: f.titleSeparator.trim() || '·',
      site_author: f.siteAuthor.trim(),
      og_image_default: f.ogImageDefault.trim(),
      publisher_logo: f.publisherLogo.trim(),
      enable_canonical: !!f.enableCanonical,
      enable_robots: !!f.enableRobots,
      robots_default: f.robotsDefault.trim() || 'index, follow',
      robots_disallow: f.robotsDisallow.map((x) => x.trim()).filter(Boolean),
      robots_allow: f.robotsAllow.map((x) => x.trim()).filter(Boolean),
      enable_robots_sitemap: !!f.enableRobotsSitemap,
      robots_crawl_delay: Math.min(100, Math.max(0, int(f.robotsCrawlDelay, 0))),
      robots_host: f.robotsHost.trim(),
      enable_keywords: !!f.enableKeywords,
      enable_og: !!f.enableOg,
      enable_twitter: !!f.enableTwitter,
      twitter_site: f.twitterSite.trim(),
      twitter_creator: f.twitterCreator.trim(),
      enable_jsonld: !!f.enableJsonld,
      enable_breadcrumb: !!f.enableBreadcrumb,
      enable_search_action: !!f.enableSearchAction,
      theme_color_light: f.themeColorLight.trim() || '#ffffff',
      theme_color_dark: f.themeColorDark.trim() || '#1e1e1e',
      color_scheme: f.colorScheme.trim() || 'light dark',
    };
  }
  if (key === 'nav') {
    const f = form as NavSection;
    return {
      items: f.items.map((it) => ({
        name: it.name.trim(),
        url: it.url.trim(),
        weight: int(it.weight, 0),
        icon: it.icon.trim(),
        image: it.image.trim(),
        iconOnly: !!it.iconOnly,
        external: !!it.external,
        position: it.position === 'controls' ? 'controls' : '',
        identifier: it.identifier.trim(),
        parent: it.parent.trim(),
        zeroAccount: !!it.zeroAccount,
      })),
    };
  }
  if (key === 'home') {
    const f = form as HomeSection;
    return { layout: f.layout === 'grid' ? 'grid' : 'bento', desc: f.desc.trim(), showDesc: !!f.showDesc };
  }
  if (key === 'footer') {
    const f = form as FooterSection;
    return {
      copyrightText: f.copyrightText.trim(),
      showPoweredBy: !!f.showPoweredBy,
      poweredByText: f.poweredByText.trim(),
      poweredByLink: f.poweredByLink.trim(),
      icpItems: f.icpItems
        .map((x) => ({ text: x.text.trim(), link: x.link.trim() }))
        .filter((x) => x.text || x.link),
      services: f.services.map(cleanFooterIcon).filter((x) => x.name || x.link),
      socialRow1: f.socialRow1.map(cleanFooterIcon).filter((x) => x.name || x.link),
      socialRow2: f.socialRow2.map(cleanFooterIcon).filter((x) => x.name || x.link),
    };
  }
  if (key === 'about') {
    const f = form as AboutSection;
    return {
      desc: f.desc.trim(),
      tagline: f.tagline.trim(),
      bio: f.bio.map((x) => x.trim()).filter(Boolean),
      declaration: f.declaration.map((x) => x.trim()).filter(Boolean),
      site: f.site.map((x) => x.trim()).filter(Boolean),
      contacts: f.contacts
        .map((x) => ({ label: x.label.trim(), text: x.text.trim(), url: x.url.trim(), external: !!x.external }))
        .filter((x) => x.text || x.url),
    };
  }
  if (key === 'apply') {
    const f = form as ApplySection;
    /** 标签与内容都空的行丢掉：主题那一行本来就不输出，留着只会让「复制」出来的文本多空行 */
    const rows = (list: ApplyRow[]) =>
      list
        .map((x) => ({ label: x.label.trim(), value: x.value.trim() }))
        .filter((x) => x.label || x.value);
    return {
      intro: f.intro.trim(),
      requirements: f.requirements.map((x) => x.trim()).filter(Boolean),
      myInfo: rows(f.myInfo),
      submitExample: rows(f.submitExample),
    };
  }
  const f = form as WorksSection;
  return {
    desc: f.desc.trim(),
    items: f.items.map((x) => ({ title: x.title.trim(), desc: x.desc.trim(), status: x.status.trim(), url: x.url.trim() })),
  };
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 上移 / 下移之后按新顺序重排 weight，界面里的顺序就是前台顺序 */
export function renumberWeights(items: NavItem[], group: '' | 'controls'): NavItem[] {
  let i = 0;
  return items.map((it) => (it.position === group ? { ...it, weight: ++i } : it));
}

/** 构建 Hook 没配不等于「前端不会更新」：Pages 连着 Git 集成时，这次提交本身就是触发器。
    旧文案把后端的短原因和页面自己那句建议拼在一起，读起来是「等下一次自动构建，等下一次自动构建」。 */
export function buildNote(reason?: string | null): string {
  return `没有走构建 Hook（${reason || '未配置'}）：内容仓库若连着 Cloudflare Pages 的 Git 集成，这次提交本身就会触发构建；没连的话去 Pages 项目里手动 Trigger 一次。`;
}
