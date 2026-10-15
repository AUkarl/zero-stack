import { Hono } from 'hono';
import { z } from 'zod';
import { deleteRepoFile, readRepoFile, repoBackend, writeRepoFile } from '../services/repo';
import { getConfig, setConfig } from '../services/config';
import { requireAdmin } from '../middleware/auth';
import { triggerPagesBuild } from '../services/git';
import { clientIp } from '../lib/http';
import { fail, ok } from '../lib/errors';
import type { AppEnv } from '../lib/app';

/**
 * 前端管理：导航 / 首页 / 页脚 / 关于 / 工坊。
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

const footerSchema = z.object({
  copyrightText: short,
  showPoweredBy: z.boolean(),
  poweredByText: short,
  poweredByLink: href,
  icpItems: z
    .array(z.object({ text: short, link: href }))
    .max(20)
    .default([]),
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
 * 基本信息（站点名 / Logo / 图标 / 作者 / 简介）。
 * Hugo 的 baseURL 与 title 兜底仍在 config.toml —— 那是站点级配置，改它要重写
 * config.toml（里面有注释），这里只管 params 能管的那几样。
 *
 * siteUrl 是邮件里确认 / 退订链接的前缀，也是后台仪表盘的跳转地址，应与 config.toml
 * 的 baseURL 写成同一个。保存这一段时顺手同步进 site_config 的同名键
 * （siteName / siteUrl / siteDescription / siteLogo / siteFavicon / author），
 * 免得前台改了名字而邮件、群发与备份文件里还是旧的。
 */
const siteSchema = z.object({
  name: short,
  navName: short.default(''),
  siteUrl: href.default(''),
  description: long,
  keywords: z.array(short).max(40).default([]),
  logo: href,
  showLogo: z.boolean().default(true),
  showName: z.boolean().default(true),
  favicon: href,
  /** 作者署名与默认作者标识不在这一页：作者资料只有一处真值，
      在「我的信息 → 站长作者资料」（写 data/authors.yaml）里维护 */
  ogImage: href.default(''),
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
  seo: { file: 'seo.json', schema: seoSchema, label: 'SEO' },
} as const;

type SectionKey = keyof typeof SECTIONS;

async function dataDir(env: Env): Promise<string> {
  const dir = (await getConfig(env, 'githubDataDir')) || 'data';
  return dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

const dataPath = (dir: string, file: string) => `${dir}/${file}`;

/** 读一个 data 文件；不存在返回 null（主题走 params 回落），解析失败给提示 */
async function readSection(env: Env, dir: string, key: SectionKey): Promise<{ value: unknown; notice: string } | null> {
  let file: Awaited<ReturnType<typeof readRepoFile>> = null;
  try {
    file = await readRepoFile(env, dataPath(dir, SECTIONS[key].file));
  } catch (e) {
    // 读失败和「文件不存在」是两回事：前者要让前台知道自己在看的是回落后 params 的旧值
    return { value: null, notice: `${SECTIONS[key].label}：读 ${dataPath(dir, SECTIONS[key].file)} 失败（${e instanceof Error ? e.message : String(e)}），本页显示为空，保存会覆盖该文件。` };
  }
  if (!file || file.content.trim() === '') return null;
  try {
    return { value: SECTIONS[key].schema.parse(JSON.parse(file.content)), notice: '' };
  } catch (e) {
    return {
      value: null,
      notice: `${SECTIONS[key].label}：${dataPath(dir, SECTIONS[key].file)} 解析失败（${e instanceof Error ? e.message : '格式错误'}），保存会以新内容覆盖。`,
    };
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
  const pending: { key: SectionKey; content: string }[] = [];
  for (const key of Object.keys(SECTIONS) as SectionKey[]) {
    const raw = parsed.data[key];
    if (raw === undefined) continue;
    if (raw === null) {
      pending.push({ key, content: '' });
      continue;
    }
    const res = SECTIONS[key].schema.safeParse(raw);
    if (!res.success) fail(400, `${SECTIONS[key].label}保存失败：${res.error.issues[0]?.message ?? '字段不合法'}`);
    pending.push({ key, content: JSON.stringify(res.data, null, 2) + '\n' });
  }
  if (!pending.length) fail(400, '没有要保存的内容');

  const dir = await dataDir(c.env);
  const written: string[] = [];
  const failed: string[] = [];
  const message = `zero-cms: 更新前端设置（${pending.map((p) => SECTIONS[p.key].label).join('、')}）`;
  for (const item of pending) {
    const path = dataPath(dir, SECTIONS[item.key].file);
    // 空内容 = 删除该段，主题回到 params.toml 的默认值
    if (item.content === '') {
      const res = await deleteRepoFile(c.env, path, message, { actor: admin, ip: clientIp(c), action: 'config' }).catch(() => null);
      if (res?.success) written.push(path);
      else failed.push(SECTIONS[item.key].label);
      continue;
    }
    const res = await writeRepoFile(c.env, path, item.content, message, { actor: admin, ip: clientIp(c), action: 'config' });
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
    message: written.length ? `已保存 ${written.length} 个文件${build?.triggered ? '，已触发站点构建' : ''}` : '未保存任何文件',
  });
});

export default app;
