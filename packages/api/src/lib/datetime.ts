/**
 * 内容里写出来的时间一律用东八区 +08:00。
 *
 * 为什么需要这个函数：投稿审核、定时发布这些动作跑在 Worker 里，运行时是 UTC，
 * 直接 `new Date(...).toISOString()` 会写出 `2026-10-02T15:07:00Z`；
 * 而后台编辑器保存时用的是浏览器本地偏移（国内就是 +08:00）。
 * 同一份内容里混着两种时区写法，JSON-LD、日期显示、跨零点的排序都会跟着不一致。
 *
 * 换算保持「时刻不变」：只是把同一瞬间换成 +08:00 的写法。
 */
export function isoDateCst(tsSec: number): string {
  const shifted = new Date((tsSec + 8 * 3600) * 1000);
  return shifted.toISOString().replace(/\.\d{3}Z$/, '+08:00');
}
