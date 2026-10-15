/**
 * 统一文章 slug：入库与查询都必须过这里，否则同一篇文章会有两种写法。
 *
 * 坑在哪：Hugo 的 `.RelPermalink` 是 URL 编码过的（/posts/%E7%9F%A5%E6%AD%A2），
 * 而 Hono 的 `c.req.path` 拿到的已经是被解码过的（/posts/知止）。
 * 早先写入时直接用编码串、查询时拿的是解码串，两者永远对不上，
 * 表现就是「文章页发了评论却不显示」。
 *
 * 所以这里先统一解码再归一：补前导 /、去尾随 /、折叠重复斜杠、去掉查询串与锚点。
 * 解码失败（残缺的 % 转义）就原样保留那一段，绝不让整条 slug 报废。
 */
export function canonSlug(raw: string): string {
  let s = decodeSlug(String(raw ?? '').trim().replace(/[?#].*$/, ''));
  if (!s) return '/';
  s = s.replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

/** 逐段解码：某一段的转义写坏了也不牵连其他段 */
function decodeSlug(value: string): string {
  if (!value.includes('%')) return value;
  return value
    .split('/')
    .map((seg) => {
      if (!seg.includes('%')) return seg;
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

/**
 * 作者标识：写进 front matter 的 author，同时是 /author/<handle>/ 的路径片段，
 * 只允许小写字母、数字和短横线。中文之类提不出 ASCII 时返回空串，由调用方回退。
 */
export function canonHandle(raw: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
