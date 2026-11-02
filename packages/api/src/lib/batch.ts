/**
 * D1 一条语句能绑的参数有限（~100 个），`in (...)` 里塞多了整条查询直接报错，
 * 接口就回 500 —— 而调用方只是多问了几十个地址而已。所以批量口一律：
 *   · 先按上限截断（超出部分按「没数据」回，不报错，免得列表页整块空白）；
 *   · 再按批切开发出去。
 */
export const MAX_BATCH_KEYS = 500;
export const IN_BATCH = 50;

export function chunk<T>(items: T[], size = IN_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 把逗号串切成键列表：去空、截断到上限 */
export function parseKeys(v: string | undefined, cap = MAX_BATCH_KEYS): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, cap);
}

/** 逐批查并把结果并起来 */
export async function mapChunks<T, R>(items: T[], fn: (part: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (const part of chunk(items)) out.push(...(await fn(part)));
  return out;
}
