/**
 * target-cache.ts — 「这一页在站上真的存在吗」那一份探测结果的缓存：读、写、作废全在这一处。
 *
 * 为什么要单独一个文件：评论与点赞都用 `targetExists()` 挡幽灵地址，探一次仓库不便宜，
 * 于是结果在 KV 存 6 分钟 —— 但上一版**只有写、没有任何清除点**，实测出两个方向各 6 分钟的空窗：
 *   · 文章还没发布时有人往那个地址探一次（评论被拒），正式发布后 6 分钟内评论口仍回
 *     「这一页在站上不存在」—— 刚发出去的文章评论区直接报错；
 *   · 文章已经删掉，缓存还说它存在，6 分钟内继续收评论与点赞 —— 攒下挂在不存在页面上的
 *     孤儿数据，还给站长发提醒信。
 * 站长定的规矩是「加缓存必须同时配清缓存」。作废点挂在**往仓库写的共用收尾**
 * （services/git.ts 的 finishRepoWrites）上：新增写入口自动带上，不需要有人记得再抄一遍。
 * 这里刻意清整族而不是只清改过的那一篇 —— 写入频率很低（人手动保存），而每一格都只是
 * 一次仓库探测，换掉「路径→slug」那套容易写错的映射更划算。
 */
import { getConfig } from './config';

/** 缓存键前缀：读写与作废都从这里拼，别在别处再写一遍字面量 */
export const TARGET_PREFIX = 'zero:target:';
/** 6 分钟：与上一版一致，只是现在有作废点了 */
export const TARGET_TTL_SECONDS = 360;

/** 文章/时刻目录：探活与作废共用一份，避免两处读到不同的目录配置 */
export async function contentDirs(env: Env): Promise<{ posts: string; moments: string }> {
  const posts = ((await getConfig(env, 'githubPostsDir'))?.trim() || 'content/zh/posts').replace(/^\/+|\/+$/g, '');
  const moments = ((await getConfig(env, 'githubMomentsDir'))?.trim() || 'content/zh/moments').replace(/^\/+|\/+$/g, '');
  return { posts, moments };
}

/** 读一次探活结果：'1' 存在、'0' 不存在、null 没缓存过（KV 读不到就当没缓存，别拦住正常评论） */
export async function readTargetFlag(env: Env, clean: string): Promise<string | null> {
  try {
    return await env.CACHE.get(TARGET_PREFIX + clean, { type: 'text' });
  } catch {
    return null;
  }
}

/** 写一次探活结果 */
export async function writeTargetFlag(env: Env, clean: string, exists: boolean): Promise<void> {
  try {
    await env.CACHE.put(TARGET_PREFIX + clean, exists ? '1' : '0', { expirationTtl: TARGET_TTL_SECONDS });
  } catch {
    /* 写不进去只是下次多探一次仓库，不影响正确性 */
  }
}

/**
 * 内容或站点数据发生写入后，把这一族探活结果整族作废。
 * 返回清掉的格数（调用方不强制读，只为判据与日志能看见「确实清了」）。
 */
export async function purgeTargetCache(env: Env): Promise<number> {
  let cleared = 0;
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const listed = await env.CACHE.list({ prefix: TARGET_PREFIX, cursor, limit: 1000 });
      for (const k of listed.keys) {
        try {
          await env.CACHE.delete(k.name);
          cleared++;
        } catch {
          /* 单格清不掉最差就是 6 分钟空窗，不该拦住写入本身 */
        }
      }
      if (!listed.list_complete) cursor = listed.cursor;
      else break;
    }
  } catch {
    /* KV 列举失败（额度、临时故障）同样只是退回 6 分钟空窗 */
  }
  return cleared;
}
