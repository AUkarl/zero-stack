/**
 * post-title.ts — 「这篇文章叫什么」只在这一处回答
 *
 * 为什么单独一个文件：同一件事以前有四份手抄 —— 评论提醒信（R65 补的）、
 * 用户主页的点赞/收藏列表、后台文章下拉、发布后的订阅群发，各自 parse 一遍 front matter，
 * 兜底还各不相同（有的回落到文件名，有的回落到**整条仓库路径**）。
 * 站主的文章文件名就是日期串，于是同一篇文章在四封信/四个界面里能有四种名字。
 *
 * 认标题的完整口径都在这里：
 *   1. front matter 的 `title`，其次 `linkTitle`（`titleFromMarkdown`）；
 *   2. 扁平 `content/zh/posts/<名>.md` 与页面包 `<名>/index.md` 两种布局都认；
 *   3. 结果按文章号缓存 24 小时（GitHub 那侧一次评论一封信，不该每封都去读仓库）；
 *      认不到也短暂记一笔（10 分钟），免得无主文章被反复打；
 *   4. 取不到回空串，**怎么兜底由调用方决定**（信里回落到文件名、界面里回落到地址），
 *      但绝不该回落到带目录的整条路径。
 *
 * 这一份刻意不引 `cloudflare:*`：纯 Node 测试要能直接喂真仓库里的 md 验它。
 */
import { kvDelete, kvGet, kvPut } from './kv-cache';
import { postsDir, readRepoFileQuiet, titleFromMarkdown } from './frontmatter';

/** slug 末段 = 文章号（文件名去掉扩展名）；缓存键与仓库路径都以它为准。传整条路径也认 */
export function postStem(slug: string): string {
  const parts = String(slug ?? '').split('/').filter(Boolean);
  let last = parts.length ? decodeURIComponent(parts[parts.length - 1]!) : '';
  last = last.replace(/\.mdx?$/i, '');
  /* 页面包：<名>/index.md 的文章号是上一层目录名 —— 调用方偶尔会连着路径把 index.md 递进来 */
  if (last === 'index' && parts.length > 1) {
    return decodeURIComponent(parts[parts.length - 2]!).replace(/\.mdx?$/i, '');
  }
  return last;
}

/** 缓存键只在这一处拼：写入侧要清的是同一格，抄一份字符串迟早和这边不一致 */
export function postTitleCacheKey(stem: string): string {
  return `zero:post-title:${stem}`;
}

/**
 * 按 slug（`/posts/xxx/` 这种站内地址，或裸文章号）认标题；认不到回空串。
 */
export async function postTitle(env: Env, slug: string): Promise<string> {
  const seg = postStem(slug);
  if (!seg) return '';
  const key = postTitleCacheKey(seg);
  const cached = await kvGet(env, key);
  if (typeof cached === 'string') return cached;
  const dir = await postsDir(env);
  let title = '';
  for (const p of [`${dir}/${seg}.md`, `${dir}/${seg}.mdx`, `${dir}/${seg}/index.md`, `${dir}/${seg}/index.mdx`]) {
    const file = await readRepoFileQuiet(env, p);
    if (!file?.content) continue;
    title = titleFromMarkdown(file.content);
    if (title) break;
  }
  await kvPut(env, key, title, title ? 24 * 3600 : 600);
  return title;
}

/** 一次列表最多认多少篇：再多就够不着「一页评论」的真实规模了，超出的行按地址显示 */
const TITLE_LOOKUP_CAP = 120;
/** 并发宽度：GitHub 那侧每篇是一次 Contents API 往返，串行 100 篇能把一个列表页拖到十几秒 */
const TITLE_LOOKUP_POOL = 8;

/**
 * 一批 slug 的标题：先去重，再按小并发池逐个走缓存。
 * 冷启动一页评论 = 几十个不同文章号，之后 24 小时全命中；认不到的那篇不进气（调用方按地址显示）。
 */
export async function postTitles(env: Env, slugs: Iterable<string>): Promise<Map<string, string>> {
  const want = [...new Set([...slugs].filter(Boolean))].slice(0, TITLE_LOOKUP_CAP);
  const out = new Map<string, string>();
  for (let i = 0; i < want.length; i += TITLE_LOOKUP_POOL) {
    const chunk = want.slice(i, i + TITLE_LOOKUP_POOL);
    const got = await Promise.all(chunk.map((slug) => postTitle(env, slug)));
    chunk.forEach((slug, n) => {
      if (got[n]) out.set(slug, got[n]!);
    });
  }
  return out;
}

/**
 * 改了/删了哪几篇文章 → 清掉这几篇的标题缓存。
 * 加缓存就得配清缓存：后台把标题改了，提醒信与列表不能还挂着旧标题等 24 小时。
 * 只有文章目录里的 .md/.mdx 才有这一格；页面包认 index.md 的上一层目录名。
 */
export async function purgePostTitleCache(env: Env, paths: string[]): Promise<void> {
  const dir = await postsDir(env);
  for (const raw of paths) {
    const rel = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel.startsWith(`${dir}/`) || !/\.mdx?$/i.test(rel)) continue;
    const segs = rel.slice(dir.length + 1).split('/');
    const file = segs.pop() ?? '';
    const stem = /^index\.mdx?$/i.test(file) ? (segs.pop() ?? '') : file.replace(/\.mdx?$/i, '');
    if (stem) await kvDelete(env, postTitleCacheKey(stem));
  }
}
