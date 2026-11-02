/**
 * owners.ts — 匿名访客的评论凭证（ownerKey）本地留存
 *
 * 后端契约（packages/api/src/routes/comments.ts）：
 *   · POST /api/comments 的响应里，匿名评论会带回一次性 ownerKey（登录用户为 null）；
 *   · GET /api/comments/{slug}?owners=… 出示过凭证的待审评论才对本人可见，
 *     且只有出示过的那条才回传 ownerKey 字段；
 *   · PATCH /api/comments/:id 认 body.ownerKey 或 ?owner= 或 X-Comment-Owner；DELETE 认 ?owner= 或 X-Comment-Owner。
 *     R43 起本包**优先发请求头**（凭证不再留在 URL 上），?owner= 仍被服务端接受，
 *     作为老 Worker 与「凭证太长装不进一个头」时的退回；
 *     前提是 Worker 的 CORS allowHeaders 已含 X-Comment-Owner / X-Comment-Owners（部署顺序：先 Worker 后主题）。
 *
 * localStorage 结构按约定以文章分组：
 *   key   = "zero-comment-owners"
 *   value = { "/posts/hello/": { "<commentId>": "<ownerKey>" } }
 * 取列表时把内层那份 { commentId: ownerKey } 原样 JSON 化塞进 ?owners=（后端 parseOwners 认 JSON 对象）。
 */

const STORE_KEY = 'zero-comment-owners';
/** 单篇文章最多留多少条凭证，防 localStorage 无限膨胀 */
const MAX_PER_SLUG = 200;

type Store = Record<string, Record<string, string>>;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function read(): Store {
  if (!isBrowser()) return {};
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [slug, map] of Object.entries(parsed as Record<string, unknown>)) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      const inner: Record<string, string> = {};
      for (const [id, key] of Object.entries(map as Record<string, unknown>)) {
        if (typeof key === 'string' && key && id) inner[id] = key;
      }
      out[slug] = inner;
    }
    return out;
  } catch {
    return {};
  }
}

function write(store: Store): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // 隐私模式 / 配额不足：只是看不到自己的待审评论，不该影响发评论
  }
}

/** 某篇文章下我持有的凭证（已登录时后端不需要它，带上也无害） */
export function ownersOf(slug: string): Record<string, string> {
  return read()[slug] ?? {};
}

/** 拼成 ?owners= 需要的 JSON 串；没有凭证返回空串，请求里就不带这个参数 */
export function ownersParam(slug: string): string {
  const map = ownersOf(slug);
  return Object.keys(map).length ? JSON.stringify(map) : '';
}

export function ownerKeyOf(slug: string, id: string): string {
  return ownersOf(slug)[id] ?? '';
}

export function hasOwnerKey(slug: string, id: string): boolean {
  return Boolean(ownerKeyOf(slug, id));
}

export function saveOwnerKey(slug: string, id: string, key: string): void {
  if (!slug || !id || !key) return;
  const store = read();
  const map = store[slug] ?? {};
  map[id] = key;
  const entries = Object.entries(map);
  store[slug] = Object.fromEntries(
    entries.length > MAX_PER_SLUG ? entries.slice(entries.length - MAX_PER_SLUG) : entries,
  );
  write(store);
}

export function dropOwnerKey(slug: string, id: string): void {
  const store = read();
  const map = store[slug];
  if (!map || !(id in map)) return;
  delete map[id];
  write(store);
}
