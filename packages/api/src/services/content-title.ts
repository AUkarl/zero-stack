/**
 * content-title.ts — 「这条内容叫什么」只在这一处回答
 *
 * 为什么单独一个文件：同一件事以前有五份手抄 —— 评论提醒信、用户主页的点赞/收藏、
 * 后台文章下拉、发布后的订阅群发，各自 parse 一遍 front matter，兜底还各不相同
 * （有的回落到文件名，有的回落到**整条仓库路径**）。站长的文件名是日期串、时刻的 id 是随机十六进制，
 * 于是同一条内容在四封信/四个界面里能有五种名字。
 *
 * 认名字的完整口径都在这里：
 *   1. 先按地址分**种类**：`/moments/…` 是时刻（在 `githubMomentsDir` 下），其余按文章（`githubPostsDir`）；
 *      以前只有文章那一份，时刻的评论提醒因此永远查不到，信里就写 `06a652a8f19e` 这种 id。
 *   2. front matter 的 `title`，其次 `linkTitle`（`frontTitle`）；
 *   3. 时刻本来就可能没有标题（朋友圈式动态），再退到**正文第一行**截断；
 *   4. 扁平 `<名>.md` 与页面包 `<名>/index.md` 两种布局都认；
 *   5. 结果按「种类 + 文章号」缓存 24 小时（GitHub 那侧一次评论一封信，不该每封都去读仓库）；
 *      认不到也短暂记一笔（10 分钟），免得无主内容被反复打；
 *   6. 全认不到时回空串，**怎么兜底由调用方决定**（信里回落到地址），但绝不该回落到带目录的整条路径。
 *
 * 这一份刻意不引 `cloudflare:*`：纯 Node 测试要能直接喂真仓库里的 md 验它。
 */
import { kvDelete, kvGet, kvPut } from './kv-cache';
import { momentsDir, postsDir, readRepoFileQuiet, titleFromMarkdown } from './frontmatter';

export type ContentKind = 'post' | 'moment';

/** 地址或仓库路径 → 种类：路径里出现 moments/ 才算时刻，其余按文章 */
export function contentKind(pathOrSlug: string): ContentKind {
  return /(^|\/)moments\//.test(String(pathOrSlug ?? '').replace(/\\/g, '/')) ? 'moment' : 'post';
}

/** 末段 = 文章号（去掉扩展名）；站内地址、裸文件名、整条路径、页面包 index.md 都取到同一个 */
export function contentStem(pathOrSlug: string): string {
  const parts = String(pathOrSlug ?? '').split('/').filter(Boolean);
  let last = parts.length ? decodeURIComponent(parts[parts.length - 1]!) : '';
  last = last.replace(/\.mdx?$/i, '');
  /* 页面包：<名>/index.md 的名字是上一层目录名 —— 调用方偶尔会连着路径把 index.md 递进来 */
  if (last === 'index' && parts.length > 1) {
    return decodeURIComponent(parts[parts.length - 2]!).replace(/\.mdx?$/i, '');
  }
  return last;
}

/** 缓存键只在这一处拼：写入侧要清的是同一格，抄一份字符串迟早和这边不一致。种类进键，时刻与文章同名也不撞 */
export function titleCacheKey(kind: ContentKind, stem: string): string {
  return `zero:${kind === 'moment' ? 'moment' : 'post'}-title:${stem}`;
}

/** 时刻没有标题是常态（朋友圈式动态），正文第一行比随机 id 有用得多 */
function firstLine(md: string): string {
  const body = String(md ?? '').replace(/^---[\s\S]*?\n---\s*/, '');
  const line = body.split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
  if (!line) return '';
  const clean = line.replace(/![[^]]*]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`>#]/g, '').trim();
  return clean.length > 30 ? `${clean.slice(0, 30)}…` : clean;
}

/**
 * 按地址认名字（文章或时刻自动分）；全认不到回空串。
 */
export async function contentTitle(env: Env, slug: string): Promise<string> {
  const stem = contentStem(slug);
  if (!stem) return '';
  const kind = contentKind(slug);
  const key = titleCacheKey(kind, stem);
  const cached = await kvGet(env, key);
  if (typeof cached === 'string') return cached;
  const dir = kind === 'moment' ? await momentsDir(env) : await postsDir(env);
  let title = '';
  for (const p of [`${dir}/${stem}.md`, `${dir}/${stem}.mdx`, `${dir}/${stem}/index.md`, `${dir}/${stem}/index.mdx`]) {
    const file = await readRepoFileQuiet(env, p);
    if (!file?.content) continue;
    title = titleFromMarkdown(file.content);
    if (!title && kind === 'moment') title = firstLine(file.content);
    if (title) break;
  }
  await kvPut(env, key, title, title ? 24 * 3600 : 600);
  return title;
}

/** 旧名保留一个别名，调用点读起来更顺（文章那几处一直在用 postTitle 这个名字） */
export const postTitle = contentTitle;

/** 一次列表最多认多少条：再多就够不着「一页评论」的真实规模了，超出的行按地址显示 */
const TITLE_LOOKUP_CAP = 120;
/** 并发宽度：GitHub 那侧每条是一次 Contents API 往返，串行 100 条能把一个列表页拖到十几秒 */
const TITLE_LOOKUP_POOL = 8;

/**
 * 一批地址的名字：先去重，再按小并发池逐个走缓存。
 * 冷启动一页评论 = 几十个不同条目，之后 24 小时全命中；认不到的那条不进气（调用方按地址显示）。
 */
export async function contentTitles(env: Env, slugs: Iterable<string>): Promise<Map<string, string>> {
  const want = [...new Set([...slugs].filter(Boolean))].slice(0, TITLE_LOOKUP_CAP);
  const out = new Map<string, string>();
  for (let i = 0; i < want.length; i += TITLE_LOOKUP_POOL) {
    const chunk = want.slice(i, i + TITLE_LOOKUP_POOL);
    const got = await Promise.all(chunk.map((slug) => contentTitle(env, slug)));
    chunk.forEach((slug, n) => {
      if (got[n]) out.set(slug, got[n]!);
    });
  }
  return out;
}

/**
 * 改了/删了哪几篇内容 → 清掉这几条的名字缓存。
 * 加缓存就得配清缓存：后台把标题改了，提醒信与列表不能还挂着旧的等 24 小时。
 * 只有文章目录与时刻目录里的 .md/.mdx 才有这一格（数据文件、友链那些不用管）；
 * 页面包认 index.md 的上一层目录名。
 */
export async function purgeContentTitleCache(env: Env, paths: string[]): Promise<void> {
  const [postDir, momentDir] = [await postsDir(env), await momentsDir(env)];
  for (const raw of paths) {
    const rel = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!/\.mdx?$/i.test(rel)) continue;
    const kind: ContentKind | '' = rel.startsWith(`${momentDir}/`) ? 'moment' : rel.startsWith(`${postDir}/`) ? 'post' : '';
    if (!kind) continue;
    const segs = rel.slice((kind === 'moment' ? momentDir : postDir).length + 1).split('/');
    const file = segs.pop() ?? '';
    const stem = /^index\.mdx?$/i.test(file) ? (segs.pop() ?? '') : file.replace(/\.mdx?$/i, '');
    if (stem) await kvDelete(env, titleCacheKey(kind, stem));
  }
}
