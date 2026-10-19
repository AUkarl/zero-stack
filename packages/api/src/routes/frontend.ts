import { Hono } from 'hono';
import { z } from 'zod';
import { deleteRepoFile, readRepoFile, repoBackend, writeRepoFile } from '../services/repo';
import { getConfig, setConfig } from '../services/config';
import { requireAdmin } from '../middleware/auth';
import { buildReceipt, triggerPagesBuild } from '../services/git';
import { clientIp } from '../lib/http';
import { fail, ok } from '../lib/errors';
import type { AppEnv } from '../lib/app';

/**
 * 前端管理：基本信息 / 导航 / 首页 / 页脚 / 关于 / 工坊 / 时刻 / 友链申请 / SEO。
 *
 * 内容写进站点的 data/*.json（Hugo 原生读 data 目录），主题优先读这些文件、
 * 读不到再回落到 params.toml。之所以不直接改 params.toml：那个文件里全是给人看的
 * 注释，程序一覆盖就没了。一个保存动作写多个文件，但只触发一次 Pages 构建。
 */
const app = new Hono<AppEnv>();

/* ------------------------------------------------------------------ 结构 */

const short = z.string().max(200);
const long = z.string().max(4000);
const href = z.string().max(600);

const navItem = z.object({
  name: short,
  url: href,
  weight: z.number().int().min(-9999).max(9999).default(0),
  icon: short.optional().default(''),
  image: href.optional().default(''),
  iconOnly: z.boolean().optional().default(false),
  external: z.boolean().optional().default(false),
  /** '' = 主菜单；'controls' = 右侧图标区 */
  position: z.enum(['', 'controls']).optional().default(''),
  /** 有子项时必填，子项用 parent 指回来 */
  identifier: short.optional().default(''),
  parent: short.optional().default(''),
  /** 主题据此把这一项渲染成账号入口（登录后换头像），而不是普通链接 */
  zeroAccount: z.boolean().optional().default(false),
});

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
  img: href.optional().default(''),
  link: href,
  /** 深色模式下要不要反色（图片 logo 常见需求） */
  invert: z.boolean().optional().default(false),
  /** 这一条要不要把名字显示在图标旁边；不写就跟着页脚那行的全站默认 */
  showName: z.boolean().optional(),
});

const footerSchema = z.object({
  copyrightText: short,
  showPoweredBy: z.boolean(),
  poweredByText: short,
  poweredByLink: href,
  icpItems: z
    .array(z.object({ text: short, link: href }))
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
    .array(z.object({ label: short, text: short, url: href, external: z.boolean().optional().default(true) }))
    .max(60)
    .default([]),
});

const worksSchema = z.object({
  desc: short,
  items: z
    .array(z.object({ title: short, desc: long, status: short, url: href }))
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
  siteUrl: href.default(''),
  description: long.default(''),
  keywords: z.array(short).max(40).default([]),
  logo: href.default(''),
  showLogo: z.boolean().default(true),
  showName: z.boolean().default(true),
  favicon: href.default(''),
  /**
   * 作者署名与默认作者标识不在这一页编辑：作者资料只有一处真值，
   * 在「我的信息 → 站长作者资料」（写 data/authors.yaml）里维护。
   * defaultAuthor 是本页唯一「不在这页改、但必须保住」的键：主题在构建期按
   * 「data 优先、params 兜底」取它，只存进 site_config 前台是读不到的 ——
   * 所以「站长作者资料」保存时会把它写进这份 site.json。
   * 登记进 schema + 下面保存时带回旧值，免得改一次导航栏就把站长标识抹成空。
   */
  defaultAuthor: short.default(''),
  ogImage: href.default(''),
  /** 落地页（/index，进站第一屏）的背景图：站内路径或完整外链都行，留空用主题自带的 img/bj.png */
  landingImage: href.default(''),
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
  bannerImage: href.default(''),
  showAvatar: z.boolean().default(true),
  showNickname: z.boolean().default(true),
  nickname: short.default(''),
  avatar: href.default(''),
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
  og_image_default: href.default(''),
  publisher_logo: href.default(''),
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
      notice: `${SECTIONS[key].label}：${dataPath(dir, SECTIONS[key].file)} 解析失败（${res.error.issues[0]?.message ?? '格式错误'}），保存会以新内容覆盖。`,
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
  for (const key of Object.keys(SECTIONS) as SectionKey[]) {
    const raw = parsed.data[key];
    if (raw === undefined) continue;
    if (raw === null) {
      pending.push({ key, content: '' });
      continue;
    }
    const res = SECTIONS[key].schema.safeParse(key === 'seo' ? normalizeSeoKeys(raw) : raw);
    if (!res.success) fail(400, `${SECTIONS[key].label}保存失败：${res.error.issues[0]?.message ?? '字段不合法'}`);
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

  const written: string[] = [];
  const failed: string[] = [];
  const message = `zero-cms: 更新前端设置（${pending.map((p) => SECTIONS[p.key].label).join('、')}）`;
  for (const item of pending) {
    const path = dataPath(dir, SECTIONS[item.key].file);
    // 空内容 = 删除该段，主题回到 params.toml 的默认值
    if (item.content === '') {
      const res = await deleteRepoFile(c.env, path, message, { actor: admin, ip: clientIp(c), action: 'params' }).catch(() => null);
      if (res?.success) written.push(path);
      else failed.push(SECTIONS[item.key].label);
      continue;
    }
    const res = await writeRepoFile(c.env, path, item.content, message, { actor: admin, ip: clientIp(c), action: 'params' });
    if (res.success) written.push(path);
    else failed.push(`${SECTIONS[item.key].label}：${res.error ?? '写入失败'}`);
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
  }

  const build = written.length && parsed.data.triggerBuild ? await triggerPagesBuild(c.env) : null;
  if (failed.length && !written.length) fail(502, `前端设置写入失败：${failed.join('；')}`);

  return ok({
    written,
    notice: failed.length ? `部分未保存：${failed.join('；')}` : null,
    build,
    message: written.length ? buildReceipt(build, `已保存 ${written.length} 个文件`) : '未保存任何文件',
  });
});

export default app;
