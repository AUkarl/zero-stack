/**
 * 后台用的那层 KV 小工具：读 / 写 / 删，**任何一个失败都不抛**。
 *
 * 为什么单独一个文件：以前这三份写在 routes/admin.ts 里（私有），文章列表缓存等用它。
 * 现在内容仓的构建结果回报（routes/build-report.ts）也要存一份到同一个 CACHE，
 * 再抄一份「try { await env.CACHE.get(...) } catch { return null }」就是两处实现 ——
 * 那种重复正是这两轮一直在收的东西（一处改了缓存口径，另一处不知道）。
 */
export async function kvGet(env: Env, key: string): Promise<unknown | null> {
  try {
    return await env.CACHE.get(key, 'json');
  } catch {
    return null;
  }
}

export async function kvPut(env: Env, key: string, value: unknown, ttl: number): Promise<void> {
  try {
    await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
  } catch {
    /* 存不上就下次再存，不影响这一次的主流程 */
  }
}

/** 内容写回仓库后清掉文章列表缓存，后台下一次读到的就是刚改过的 */
export async function kvDelete(env: Env, key: string): Promise<void> {
  try {
    await env.CACHE.delete(key);
  } catch {
    /* 清不掉就等 TTL 过期，不影响写入本身 */
  }
}
