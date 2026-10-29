/**
 * 站点仓库坐标与 Pages 重建：内容发布、params 回写、友链数据回写共用同一套配置。
 *
 * 真正的读写实现已经搬到 repo.ts（GitHub Contents API 与 GIT_LOCAL_DIR 本地目录两套后端），
 * 这里只做一层兼容外壳：既有的 repoTarget / readFile / writeFile / deleteFile / listDir /
 * triggerPagesBuild 签名和调用形状全部保持不变，其它路由不用改写法就能跟着走本地回退。
 */

import { getConfig } from './config';
import { purgeTargetCache } from './target-cache';
import { deleteViaTarget, listDirViaTarget, readFileFrom, repoBackend, resolveRepoTarget, runLocalBuildCheck, buildHealthReceipt, targetFromInput, writeViaTarget } from './repo';
import type { RepoEntry, RepoFile, RepoFileResult, RepoTarget } from './repo';
import { fetchWithTimeout } from '../lib/fetch';

/** 历史导出名，调用方遍布后台各路由，保留 */
export async function repoTarget(env: Env): Promise<RepoTarget> {
  return resolveRepoTarget(env);
}

/** 兼容旧调用形状：既接受 repoTarget() 吐出来的完整目标，也接受手写的 owner/repo/branch/token */
export interface GitFileInput {
  owner?: string;
  repo?: string;
  branch?: string;
  token?: string;
  dir?: string;
  backend?: RepoTarget['backend'];
  env?: Env;
  path: string;
}

export interface GitContentInput extends GitFileInput {
  content: string;
  message: string;
}

export interface GitCommitInput extends GitFileInput {
  message: string;
}

export async function readFile(input: GitFileInput): Promise<RepoFile | null> {
  return readFileFrom(targetFromInput(input), input.path);
}

export async function writeFile(input: GitContentInput): Promise<RepoFileResult> {
  // 目标对象自带 env，本地后端的审计留痕靠它；git.ts 这层不额外记流水，调用方各有业务 detail
  return writeViaTarget(targetFromInput(input), input.path, input.content, input.message, {});
}

export async function deleteFile(input: GitCommitInput): Promise<RepoFileResult> {
  return deleteViaTarget(targetFromInput(input), input.path, input.message, {});
}

export async function listDir(input: GitFileInput): Promise<RepoEntry[]> {
  return listDirViaTarget(targetFromInput(input), input.path);
}

/**
 * Pages 构建 Hook 是可选加速路径：没配或失败都不影响提交已成功的事实。
 *
 * 内容仓库接了 Pages 的 Git 集成（或仓库里自带部署工作流）时，这次提交本身就是构建
 * 触发器，所以「没配 Hook」不是失败。以前这里回一句「未配置 Pages 构建 Hook」，
 * 被 buildReceipt 拼成「已推送 N 篇，但站点重建没起来：未配置 Pages 构建 Hook」，
 * 站主每次发文都看到一句吓人的话，而站点其实照常重建了。
 * viaCommit 就是把这个区别说清楚：没去调 Hook，但提交会自己触发。
 */
export async function triggerPagesBuild(env: Env): Promise<{ triggered: boolean; viaCommit?: boolean; error?: string; backend?: 'github' | 'local' | 'none' }> {
  const backend = await repoBackend(env);
  const hook = await getConfig(env, 'cloudflarePagesBuildHook');
  // error 仍然给一句短原因：后台有几处是直接打印它的，留空会退化成「接口没回结果」这种更吓人的话
  if (!hook) return { triggered: false, viaCommit: backend === 'github', error: backend === 'github' ? '没配 Pages 构建 Hook' : '本地后端不产生 Git 提交', backend };
  try {
    const res = await fetchWithTimeout(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) return { triggered: false, error: `Pages 返回 ${res.status}`, backend };
    return { triggered: true, backend };
  } catch (e) {
    return { triggered: false, error: e instanceof Error ? e.message : String(e), backend };
  }
}

/**
 * 写盘之后要给后台的那半句回执。
 *
 * 以前不管 Hook 有没有真的调起来都写「站点构建已请求」，前台就一直是旧页面 ——
 * 静态站不重建等于什么都没发生，这句必须按实际结果拼。
 */
export function buildReceipt(
  build: { triggered?: boolean; viaCommit?: boolean; error?: string; backend?: 'github' | 'local' | 'none' } | null,
  savedText: string,
): string {
  if (!build) return `${savedText}，没请求站点重建（前台要等下次自动构建）`;
  if (build.triggered) return `${savedText}，已请求站点重建`;
  if (build.backend === 'local') {
    return `${savedText}，已写入本地目录（本地后端不产生 Git 提交；站点由 hugo server 按文件变化重建）`;
  }
  if (build.viaCommit) {
    return `${savedText}，站点按 Git 集成随这次提交重建（若前台几分钟内没变，说明你的 Pages 不是 Git 集成构建，需在后台填「Pages 构建 Hook」）`;
  }
  return `${savedText}，但站点重建没起来：${build.error ?? '未知原因'}`;
}

/**
 * 写完之后统一做的收尾：清后台列表缓存（调用方自己做）→ 按需请求站点重建 → 跑一次构建体检。
 *
 * 上一轮这个收尾叫 finishContentWrite，只在文章那两条路上有；实测还有 6 个会触发重建的入口
 * 完全不体检（投稿审核、友链申请、个人中心写稿、整篇翻译、备份恢复、每天 02:00 的 cron）。
 * 挂在这里，任何写仓库的路径都只需调这一个函数，不用再自己决定要不要体检。
 *
 * 体检**整批一次**：每文件跑一次 hugo 会把保存拖成分钟级。
 * 线上没有本地桥，buildHealth 为 null，回执里也就不加那句话（详见 services/repo.ts 的说明）。
 */
export async function finishRepoWrites(
  env: Env,
  changed: number,
  triggerBuild = true,
): Promise<{ build: { triggered?: boolean; viaCommit?: boolean; error?: string } | null; buildHealth: Awaited<ReturnType<typeof runLocalBuildCheck>> }> {
  if (!changed) return { build: null, buildHealth: null };
  /* 探活缓存跟着一起作废：评论/点赞的 targetExists 结果存 6 分钟，不清就会出现
     「刚发布的文章说这一页不存在」与「删掉的文章还收评论」两个方向各 6 分钟的空窗。
     判据与键都在 services/target-cache.ts，清除点只有这一个。 */
  await purgeTargetCache(env);
  const build = triggerBuild ? await triggerPagesBuild(env) : null;
  return { build, buildHealth: await runLocalBuildCheck(env) };
}

/** 给调用方拼回执用的完整一句：重建 + 体检 */
export function writeReceipt(
  envText: string,
  build: Parameters<typeof buildReceipt>[0],
  health: Awaited<ReturnType<typeof runLocalBuildCheck>>,
): string {
  return buildReceipt(build, envText) + buildHealthReceipt(health);
}
