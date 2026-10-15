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
import type { RepoTarget } from './repo';
import { appendFriends, normalizeFriendUrl, parseLinksYaml, removeFriend, replaceFriend, type NewFriend } from './links-yaml';

export interface LinksFileResult {
  /** 是否真的提交了一次改动 */
  synced: boolean;
  /** 没写成时给管理员看的原因 */
  error: string | null;
}

const OK: LinksFileResult = { synced: true, error: null };

async function linksPath(env: Env): Promise<string> {
  return (await getConfig(env, 'githubLinksFile')) ?? 'data/links.yaml';
}

/** 读文件 → 改 → 写回；mutator 返回 null 表示无需改动 */
async function patch(
  env: Env,
  message: string,
  mutator: (text: string) => { text: string; note: string | null } | null,
): Promise<LinksFileResult> {
  let settings: RepoTarget;
  try {
    settings = await repoTarget(env);
  } catch {
    return { synced: false, error: '未配置站点仓库，本次只改了数据库' };
  }
  const path = await linksPath(env);
  try {
    const file = await readFile({ ...settings, path });
    if (!file) return { synced: false, error: `仓库里没有 ${path}` };
    const out = mutator(file.content);
    if (!out) return { synced: false, error: `仓库里的 ${path} 没有这一条，无需改动` };
    // 行切片重组后结尾换行容易丢，补回来：数据文件少这一个字节，Git 上就是一条无谓的改动
    const next = out.text.endsWith('\n') ? out.text : out.text + '\n';
    if (next === file.content) return { synced: false, error: out.note ?? '内容没有变化' };
    const res = await writeFile({ ...settings, path, content: next, message });
    if (!res.success) return { synced: false, error: res.error ?? '提交失败' };
    return OK;
  } catch (e) {
    return { synced: false, error: e instanceof Error ? e.message : String(e) };
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
    const file = await readFile({ ...settings, path: await linksPath(env) });
    if (!file) return null;
    const target = normalizeFriendUrl(url);
    return parseLinksYaml(file.content).some((s) => normalizeFriendUrl(s.url) === target);
  } catch {
    return null;
  }
}

/** 新增（换组移动也走这里：先把旧位置那一条删掉，再写进目标段落） */export async function addFriendToLinksFile(
  env: Env,
  entry: NewFriend,
  opts: { alsoRemoveUrl?: string } = {},
): Promise<LinksFileResult> {
  return patch(env, `zero-cms: 友链新增 ${entry.name}`, (text) => {
    const base = opts.alsoRemoveUrl ? removeFriend(text, opts.alsoRemoveUrl).text : text;
    const appended = appendFriends(base, [entry]);
    if (!appended.added.length) return { text: base, note: appended.message ?? '该站点已在数据文件里' };
    return { text: appended.text, note: null };
  });
}

/** 改写了已有条目（原位替换；换了分组就搬到目标段落末尾）；文件里没这条时补写一条 */
export async function updateFriendInLinksFile(env: Env, oldUrl: string, entry: NewFriend): Promise<LinksFileResult> {
  return patch(env, `zero-cms: 友链更新 ${entry.name}`, (text) => {
    const replaced = replaceFriend(text, oldUrl, entry);
    if (!replaced.replaced) {
      const appended = appendFriends(text, [entry]);
      return { text: appended.text, note: appended.message ?? '该站点已在数据文件里' };
    }
    return { text: replaced.text, note: null };
  });
}

/** 删除 */
export async function removeFriendFromLinksFile(env: Env, url: string, name: string): Promise<LinksFileResult> {
  return patch(env, `zero-cms: 友链删除 ${name}`, (text) => {
    const out = removeFriend(text, url);
    return out.removed ? { text: out.text, note: null } : null;
  });
}
