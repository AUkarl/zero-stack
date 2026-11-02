import { inArray } from 'drizzle-orm';
import { createDb } from '../db/client';
import { comments } from '../db/schema';

/**
 * 删除一条评论及其整棵子树。
 *
 * 逐层收集再一次性删：按节点递归删除在评论较深时会产生几十次 D1 往返，
 * 中途失败会留下半棵树。层数等于深度，往返次数可控。
 */
export async function deleteCommentSubtree(env: Env, id: string): Promise<number> {
  const db = createDb(env);
  const ids = [id];
  let frontier = [id];

  while (frontier.length) {
    const rows = await db.select({ id: comments.id }).from(comments).where(inArray(comments.parentId, frontier));
    frontier = rows.map((r) => r.id).filter((child) => !ids.includes(child));
    ids.push(...frontier);
  }

  for (let i = 0; i < ids.length; i += 100) {
    await db.delete(comments).where(inArray(comments.id, ids.slice(i, i + 100)));
  }
  return ids.length;
}
