/**
 * 后台待办数量：layout 每 5 分钟、切页时刷新一次，仪表盘直接读，
 * 不再为四张待办卡片各发一遍请求。
 */
export const pendingCounts = $state({
  comments: 0,
  applications: 0,
  drafts: 0,
  authors: 0,
});
