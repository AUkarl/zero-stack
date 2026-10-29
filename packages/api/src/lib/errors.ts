import { HTTPException } from 'hono/http-exception';

/**
 * 统一错误响应：前端只认 { error, message } 两个字段。
 *
 * 503 是「**这项没开通**」的专用码（构建回报没配 Secret、GitHub OAuth 没配…）。
 * 以前 build-report 用 500、GitHub 那一档用 501，两种都在说同一件事，脚本分不清
 * 「服务器坏了」与「站长还没开」；内容仓 CI 每次构建都调回报口，没开通时那一步就该是明确跳过而不是红。
 * 真正服务内部出错仍然用 500，别混用。
 */
export function fail(status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503, message: string, headers?: Record<string, string>): never {
  throw new HTTPException(status, { res: Response.json({ error: status, message }, { status, headers }) });
}

export function ok<T>(data: T): Response {
  return Response.json({ data });
}

/**
 * 列表口的统一取数键。
 *
 * 台架 2026-10-29 实测：同一类回包有三种形状 —— `GET /api/admin/comments` 是 `{data:[…]}`、
 * `GET /api/admin/users` 是 `{data:{total,data:[…]}}`（data 里又叫 data）、`/api/admin/media/list`
 * 是 `{data:{objects:[…]}}`。四套自测脚本都因为按错键名取数产生过「列表是空的」假红，
 * 后台每一页也各写一套取数。
 *
 * 这一条不改任何已有键名（旧读者照旧读 `data`），只在**顶层**补 `items` 与 `total`：
 * 从今往后管理列表口一律可以 `body.items` 取到那一页的行、`body.total` 取到总数。
 * `inside` 给「本来就是个对象」的旧形状（`{total,data}` / `{objects}`）里也补上 `items`，
 * 两种取法都指向同一份数组。
 */
export function okRows<T>(rows: T[], inside?: Record<string, unknown> | null): Response {
  /* 顶层 total：调用点自己给了总数（比如媒体列表按 cap 截过）就以它为准，否则等于本次行数 */
  const total = typeof inside?.total === 'number' ? inside.total : rows.length;
  const data = inside ? { ...inside, items: rows, total } : rows;
  return Response.json({ data, items: rows, total });
}

export function errorMessage(e: unknown): string {
  if (e instanceof HTTPException) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
