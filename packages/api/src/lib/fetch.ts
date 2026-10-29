/**
 * fetch.ts — 所有出网请求共用的「带截止时间」的 fetch。
 *
 * 为什么要这一层：`packages/api/src` 里 21 处 `await fetch(` 只有 5 处带 `signal`
 * （头像缓存、Purge、RSS 推送、反垃圾服务商、定时任务）。没带的那些里最要命的是
 * `adapters/github.ts` 的 12 处 —— 「保存文章 / 发布投稿 / 写作者表 / 导出统计」都要等
 * GitHub 回话，GitHub 或网络一旦卡住，用户点下去就是一圈圈的转圈，最后拿到的是一句
 * 网关错误而不是「哪一步、等了多久」。台架 2026-10-29 实测同类问题：SMTP 卡住时
 * 订阅、找回密码、测试发信能一路挂 95 秒不返回。
 *
 * 超时**不抛异常**而是回一个 504 的 Response：调用方本来就按「!res.ok → 组装 error」处理，
 * 这样失败路径与原来的 4xx/5xx 完全一致，不会把某个没包 try/catch 的口变成 500。
 */

/** 默认 10 秒：GitHub Contents API 正常是几百毫秒，翻译服务商一两秒，超过 10 秒就是不对劲 */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

function timeoutResponse(url: string, ms: number): Response {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  return new Response(
    `${host} 在 ${Math.round(ms / 1000)} 秒内没有响应（已按超时中断，避免把这次请求一直挂住）。` +
      '通常是对方服务或网络暂时不通：稍后重试一次；每次都这样就去服务商控制台看接口状态。',
    { status: 504, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
}

/** 与 fetch 同签名，只是必然带着截止时间 */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const url = String(input);
  if (init.signal) return await fetch(url, init);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal });
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    const cause = (e as { cause?: { name?: string } })?.cause?.name ?? '';
    if (name === 'TimeoutError' || name === 'AbortError' || cause === 'TimeoutError' || cause === 'AbortError') {
      return timeoutResponse(url, timeoutMs);
    }
    throw e;
  }
}
