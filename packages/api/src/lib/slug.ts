/**
 * 统一文章 slug：入库与查询都必须过这里，否则同一篇文章会有两种写法。
 *
 * 坑在哪（都是真实踩过的）：
 * 1. Hugo 的 `.RelPermalink` 是 URL 编码过的（/posts/%E7%9F%A5%E6%AD%A2），
 *    而 Hono 的 `c.req.path` 拿到的已经是解码过的（/posts/知止）。
 *    早先写入用编码串、查询用解码串，两者永远对不上，表现为「发了评论却不显示」。
 * 2. 第三方评论系统（Waline / Twikoo / …）导出的地址**带不带尾斜杠不统一**，
 *    有的还是完整 URL（https://本站/posts/x/）。导入时自己造一套归一（补尾斜杠）、
 *    读取时走这里（去尾斜杠），结果导进来的每一条评论前台都查不到。
 *
 * 所以统一在这里：先剥掉协议与域名、去查询串与锚点、逐段解码，再补前导 /、去尾随 /、
 * 折叠重复斜杠。解码失败（残缺的 % 转义）就原样保留那一段，绝不让整条 slug 报废。
 */
export function canonSlug(raw: string): string {
  let s = decodeSlug(String(raw ?? '').trim().replace(/[?#].*$/, ''));
  s = stripOrigin(s);
  if (!s) return '/';
  s = s.replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

/** 完整 URL（导出文件、后台手填的地址）只取路径部分；解析不出路径就当没有域名处理 */
function stripOrigin(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const path = new URL(value).pathname;
    return path === '/' ? '/' : path;
  } catch {
    return value.replace(/^https?:\/\/[^/]+/i, '');
  }
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
