/**
 * 友链数据文件（data/links.yaml）的写回。
 *
 * 前台「左邻右舍 / 站点联盟」是构建期按这份文件渲染的，D1 只是后台管理与检测用的那份。
 * 所以后台每次新增 / 改网址 / 换分组 / 删除都要同步它，否则会出现
 * 「库里删掉了、页面还在」或「新加的站跑到别的板块里」。
 *
 * 写不回时不静默：把原因原样带回接口，后台列表上直接显示，
 * 管理员至少知道「这条只改了数据库，站点上还没变」。
 */

import { getConfig } from './config';
import { readFile, repoTarget, writeFile } from './git';
import type { BuildHealth, RepoTarget } from './repo';
import { appendFriends, normalizeFriendUrl, parseLinksYaml, removeFriend, replaceFriend, type NewFriend } from './links-yaml';

export interface LinksFileResult {
  /** 是否真的提交了一次改动 */
  synced: boolean;
  /**
   * `synced:false` 到底是哪一种「没写成」—— 台架 2026-10-29 报的就是这条：
   * 三种情况（本来就没有变化 / 没配仓库 / 提交失败）以前只靠 `error` 的文字区分，
   * 界面一律读成「同步失败」，站主以为改动丢了。
   *   · `unchanged` 仓库里已经是这个样子，没有任何待提交的差异；
   *   · `not-found` 要改的那一条根本不在数据文件里（删除时最常见）；
   *   · `no-repo`   站点仓库没配好，本次只动了数据库；
   *   · `failed`    读 / 写仓库真的失败了，`error` 里是服务商原文。
   */
  reason?: 'unchanged' | 'not-found' | 'no-repo' | 'failed';
  /** 没写成时给管理员看的原因 */
  error: string | null;
  /** 这一版文件的 blob 号，下次乐观锁要比对的就是它（没提交时为 null） */
  sha?: string | null;
  /**
   * 这次写入后的构建体检（本地后端才有；线上 workerd 起不了子进程时为 null）。
   * 这份文件是 Hugo 构建期读的数据文件，写坏了是整站构建失败，所以同步成功也必须把体检带回去 ——
   *  applications 那条路早就这么做了，友链管理页那四条写入路径是漏的。
   */
  buildHealth?: BuildHealth | null;
}

/**
 * 友链数据文件在仓库里的位置 —— 全站唯一一处算这个路径的地方。
 *
 * 以前 scheduler 自己按 githubDataDir 拼、写入侧按 githubLinksFile 取，两处各算各的：
 * 把 data 目录挪走（比如 site/data）就会出现「后台改的是 A，定时任务写的是 B」。
 * 现在统一：githubLinksFile 填了就用它，没填就落在数据目录里，两条腿走的是同一个文件。
 */
export async function linksFilePath(env: Env): Promise<string> {
  const fromKey = ((await getConfig(env, 'githubLinksFile')) ?? '').trim();
  if (fromKey) return fromKey.replace(/^\/+/, '');
  const dir = ((await getConfig(env, 'githubDataDir')) || 'data').replace(/^\/+|\/+$/g, '');
  return `${dir}/links.yaml`;
}

/** 站点第一次配置就撞上一个空仓库 / 没有这份文件，是很常见的事 —— 按主题认的两段建骨架 */
const LINKS_SEED = '# 友链数据文件：前台「左邻右舍 / 站点联盟」在构建期读它。\n# 条目按 kind 落到对应的段里，由 zero-cms 在第一次写入时创建。\nfriends:\nalliance:\n';

/** mutator 拿到的可能是 null（文件还不存在），要写新条目的先从骨架起手 */
const orSeed = (text: string | null) => text ?? LINKS_SEED;

/**
 * 读文件 → 改 → 写回。文件还不存在时把 null 交给 mutator，由它从骨架开始写：
 * 空仓库里第一次通过一条友链申请，就该顺手把这份数据文件建出来，而不是回一句
 * 「仓库里没有 data/links.yaml」然后只改数据库 —— 那正是申请「显示成功但站点没变」的成因。
 */
async function patch(
  env: Env,
  message: string,
  mutator: (text: string | null) => { text: string; note: string | null } | null,
): Promise<LinksFileResult> {
  let settings: RepoTarget;
  try {
    settings = await repoTarget(env);
  } catch {
    return { synced: false, reason: 'no-repo', error: '未配置站点仓库，本次只改了数据库', sha: null };
  }
  const path = await linksFilePath(env);
  try {
    const file = await readFile({ ...settings, path });
    const before = file?.content ?? null;
    const out = mutator(before);
    if (!out) return { synced: false, reason: 'not-found', error: `仓库里的 ${path} 没有这一条，无需改动`, sha: null };
    // 行切片重组后结尾换行容易丢，补回来：数据文件少这一个字节，Git 上就是一条无谓的改动
    const next = out.text.endsWith('\n') ? out.text : out.text + '\n';
    if (before !== null && next === before) return { synced: false, reason: 'unchanged', error: out.note ?? '内容没有变化', sha: null };
    const res = await writeFile({ ...settings, path, content: next, message });
    if (!res.success) return { synced: false, reason: 'failed', error: res.error ?? '提交失败', sha: null };
    return { synced: true, error: null, sha: res.sha ?? null };
  } catch (e) {
    return { synced: false, reason: 'failed', error: e instanceof Error ? e.message : String(e), sha: null };
  }
}

/**
 * 数据文件里到底有没有这一条（按规范化后的 URL 比）。读不到文件返回 null。
 *
 * 删除前要先问这一句：文件里有、却没能把那条清掉时不能继续删库 ——
 * 前台那两个板块是构建期读文件渲染的，库里删了、文件里留着，
 * 这条链接就成了后台再也管不到的僵尸（就是「多出的友链」）。
 */
export async function linksFileHas(env: Env, url: string): Promise<boolean | null> {
  let settings: RepoTarget;
  try {
    settings = await repoTarget(env);
  } catch {
    return null;
  }
  try {
    const file = await readFile({ ...settings, path: await linksFilePath(env) });
    if (!file) return null;
    const target = normalizeFriendUrl(url);
    return parseLinksYaml(file.content).some((s) => normalizeFriendUrl(s.url) === target);
  } catch {
    return null;
  }
}

/** 新增（换组移动也走这里：先把旧位置那一条删掉，再写进目标段落） */
export async function addFriendToLinksFile(
  env: Env,
  entry: NewFriend,
  opts: { alsoRemoveUrl?: string } = {},
): Promise<LinksFileResult> {
  return patch(env, `zero-cms: 友链新增 ${entry.name}`, (text) => {
    const seeded = orSeed(text);
    const base = opts.alsoRemoveUrl ? removeFriend(seeded, opts.alsoRemoveUrl).text : seeded;
    const appended = appendFriends(base, [entry]);
    if (!appended.added.length) return { text: base, note: appended.message ?? '该站点已在数据文件里' };
    return { text: appended.text, note: null };
  });
}

/** 改写了已有条目（原位替换；换了分组就搬到目标段落末尾）；文件里没这条时补写一条 */
export async function updateFriendInLinksFile(env: Env, oldUrl: string, entry: NewFriend): Promise<LinksFileResult> {
  return patch(env, `zero-cms: 友链更新 ${entry.name}`, (text) => {
    const seeded = orSeed(text);
    const replaced = replaceFriend(seeded, oldUrl, entry);
    if (!replaced.replaced) {
      const appended = appendFriends(seeded, [entry]);
      return { text: appended.text, note: appended.message ?? '该站点已在数据文件里' };
    }
    return { text: replaced.text, note: null };
  });
}

/** 删除：文件还没有就说明这条也不在里面，不用改动 */
export async function removeFriendFromLinksFile(env: Env, url: string, name: string): Promise<LinksFileResult> {
  return patch(env, `zero-cms: 友链删除 ${name}`, (text) => {
    if (text === null) return null;
    const out = removeFriend(text, url);
    return out.removed ? { text: out.text, note: null } : null;
  });
}
