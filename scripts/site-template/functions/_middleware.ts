/**
 * functions/_middleware.ts — 后台关掉的功能，边缘直接 404
 *
 * 为什么要这一层：主题原本只在浏览器里按 /api/config 把入口 hidden 掉（js/zero-switches.js），
 * 于是旧地址照样能直接打开、搜索引擎也照旧收录。要同时做到「站内不显示、旧链接打不开、爬虫别收」，
 * 只能在 Pages 的边缘这一层做。
 *
 * 这份文件由 pnpm create:site 生成到内容仓库里，__ZERO_API_BASE__ 已经换成填好的接口地址。
 * 单独放在 zero-stack/scripts/site-template 下是源模板，改逻辑改这份，重新生成站点即可带上。
 *
 * 三条硬约束：
 *   · 读的是接口自己的 /api/config，结果在边缘缓存 60 秒 —— 后台打开关最迟一分钟后生效，不用重建站点
 *   · 拿不到配置（后端挂了、超时、返回非 200）时一律按「默认开」放行，绝不把整站变 404
 *   · /admin、/posts、图片与 RSS 这些不在表里的路径完全不经过任何判断，性能与行为都和没有这个文件时一致
 *
 * 想再多管一个页面：往 GATED 里加一行「路径前缀 → 开关键」，键必须真是 /api/config 暴露出来的那个
 * （后台「设置」里得有对应的开关，否则这里判不到关，页面照旧正常出）。
 */
const API_BASE = '__ZERO_API_BASE__';

/** 路径前缀 → 控制它的后台开关键（键名以 /api/config 返回的那些为准） */
const GATED: Array<[string, string]> = [
  ['/links/', 'friendsEnabled'],
  ['/moments/', 'momentsEnabled'],
  ['/subscribe/', 'subscribeEnabled'],
  ['/account/', 'accountSystemEnabled'],
  ['/tools/', 'toolsEnabled'],
  ['/work/', 'workEnabled'],
  ['/about/', 'aboutEnabled'],
];

const CACHE_MS = 60_000;
let cache: { at: number; data: Record<string, unknown> } | null = null;

/** 取一次公开配置；失败时退回上一次拿到的值（从没成功过就是 null） */
async function switches(): Promise<Record<string, unknown> | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  try {
    /* cf.cacheTtl 是 Pages/Workers 自己的扩展字段，标准的 RequestInit 类型里没有，
       这里按 RequestInit 断言一下（pnpm check 会连这个文件一起 typecheck） */
    const res = await fetch(
      API_BASE.replace(/\/+$/, '') + '/api/config',
      {
        headers: { accept: 'application/json' },
        // 同一个 PoP 上 60 秒内的第二次请求不再回接口打这一枪
        cf: { cacheTtl: 60, cacheKey: 'zero-api-config' },
      } as RequestInit,
    );
    if (!res.ok) return cache ? cache.data : null;
    const body = (await res.json()) as { data?: Record<string, unknown> };
    const data = body && body.data ? body.data : null;
    if (data) cache = { at: Date.now(), data: data };
    return data;
  } catch {
    return cache ? cache.data : null;
  }
}

/** 与主题 js/zero-switches.js 里的 isOn 同一套判定：只有明确写成关才算关 */
function isOff(v: unknown): boolean {
  return v === false || v === 'false' || v === 0 || v === '0';
}

function gatedKey(pathname: string): string {
  for (const [prefix, key] of GATED) {
    // /links 与 /links/ 两种写法都要命中（Hugo 会把不带斜杠的那条重定向到带斜杠的）
    if (pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix)) return key;
  }
  return '';
}

/** Pages 给中间件的三个方法；写成局部类型，这个文件不依赖任何全局 workers 类型 */
interface PagesContext {
  request: Request;
  next: () => Promise<Response>;
  fetch: (input: Request) => Promise<Response>;
}

export const onRequest = async (context: PagesContext) => {
  const pathname = new URL(context.request.url).pathname;
  const key = gatedKey(pathname);
  if (!key) return context.next();

  const data = await switches();
  if (!data || !isOff(data[key])) return context.next();

  /* 关掉：取站点自己那份 404 页当响应体，但状态码要真是 404，并明确告诉爬虫别收。
     直接 new Response('404') 会让访客看到一个空白页，主题那个 404 页才是该有的样子。 */
  const fallback = await context.fetch(new Request(new URL('/404.html', context.request.url), { headers: context.request.headers }));
  const headers = new Headers();
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.set('cache-control', 'public, max-age=60');
  return new Response(fallback.body, { status: 404, headers });
};
