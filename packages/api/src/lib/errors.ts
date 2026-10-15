import { HTTPException } from 'hono/http-exception';

/** 统一错误响应：前端只认 { error, message } 两个字段 */
export function fail(status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502, message: string): never {
  throw new HTTPException(status, { res: Response.json({ error: status, message }, { status }) });
}

export function ok<T>(data: T): Response {
  return Response.json({ data });
}

export function errorMessage(e: unknown): string {
  if (e instanceof HTTPException) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
