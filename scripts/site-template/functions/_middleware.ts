/**
 * functions/_middleware.ts — 边缘这一层管两件事
 *   1. 后台关掉的功能，旧地址直接 404，并且不再出现在站点地图里
 *   2. 全站补上安全响应头（含 CSP，策略在下面 CSP 那一段里逐条写了理由）
 *
 * 为什么要这一层：主题原本只在浏览器里按 /api/config 把入口 hidden 掉（js/zero-switches.js），
 * 于是旧地址照样能直接打开、搜索引擎也照旧收录。要同时做到「站内不显示、旧链接打不开、爬虫别收」，
 * 只能在 Pages 的边缘这一层做。
 *
 * 这份文件由 pnpm create:site 生成到内容仓库里，__ZERO_API_BASE__ 已经换成填好的接口地址。
 * 单独放在 zero-stack/scripts/site-template 下是源模板，改逻辑改这份，重新生成站点即可带上。
 *
 * 五条硬约束：
 *   · 读的是接口自己的 /api/config，结果在边缘缓存 60 秒 —— 后台打开关最迟一分钟后生效，不用重建站点
 *   · 拿不到配置（后端挂了、超时、返回非 200）时一律按「默认开」放行，绝不把整站变 404
 *   · 判定为「关掉」时只能出 404，任何意外都不许出 5xx
 *   · 除 /sitemap.xml 以外，任何路径都不为了拿配置而多跑一次网络请求：
 *     只有「这条路径归 GATED 管」或「这是站点地图」才会去 fetch /api/config；
 *     图片、CSS、文章这些不归管的请求只是原样把响应递出去、顺手补三个头
 *   · CSP 里 connect-src 的那组域名是从上面的 API_BASE 推出来的：接口换成别的父域、
 *     或者评论后端（waline/twikoo 的 serverUrl）放到另一个域上，就要在这里补一行域名 ——
 *     漏补的现象是页面正常出、评论区一直转或统计一直零，浏览器控制台里能看到 CSP 拦的那条
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

/** 关掉的那几条路径，前缀按当前配置算出来（站点地图用） */
function offPrefixes(data: Record<string, unknown>): string[] {
  return GATED.filter(([, key]) => isOff(data[key])).map(([prefix]) => prefix);
}

/**
 * CSP（分级硬策略）。两条来历写在这里，免得下次有人以为是偷懒：
 *
 * 为什么 script/style 还留着 'unsafe-inline'（实测出来的，不是嫌麻烦）：
 *   · 主题每页都烘 9~13 段可执行内联脚本（功能开关、组件懒加载、图片备用链、播放器占位）；
 *     静态站要禁内联，只能给每段脚本算 hash 写进头里（改一个模板就得重算），或在边缘改写每页 HTML 注 nonce。
 *   · /links/ 一页有 62 个 onerror —— 朋友动态、左邻右舍、站点联盟那些徽章靠它换图床兜底，
 *     写法在第三方自己的代码里，禁内联事件等于把这三块直接打断。
 *   · Font Awesome 靠 media=print + onload 异步启用样式；Cloudflare 也会往页面里注一段同源脚本。
 * 其余指令按硬来写：外部脚本注入、base 劫持、表单劫持、插件对象、被外站框住、把数据发往陌生域，都挡住。
 *
 * connect-src 从 API_BASE 推：接口本身 + 与接口同父域的一组子域
 * （媒体桶、自托管的 waline/twikoo 后端通常挂在这组子域上）。localhost / IP 不生成通配。
 */
const API_ORIGIN = (() => {
  try {
    const u = new URL(API_BASE);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
})();

const API_SIBLINGS = (() => {
  if (!API_ORIGIN) return '';
  const host = new URL(API_ORIGIN).hostname;
  if (host === 'localhost' || /^[0-9.]+$/.test(host)) return '';
  const apex = host.split('.').slice(-2).join('.');
  return ` https://*.${apex} wss://*.${apex}`;
})();

/** 主题里写死的那几个外部脚本源（第三方评论、数学公式、404 页的寻人启事）；短代码再引别家 CDN 就来这里补一行 */
const EXTERNAL_SCRIPTS =
  'https://cdn.jsdelivr.net https://fastly.jsdelivr.net https://gcore.jsdelivr.net https://unpkg.com https://giscus.app https://qzonestyle.gtimg.cn';
const EXTERNAL_STYLES = 'https://cdn.jsdelivr.net https://unpkg.com';

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${EXTERNAL_SCRIPTS}`,
  `style-src 'self' 'unsafe-inline' ${EXTERNAL_STYLES}`,
  // 图片放宽到整个 https：友链头像、各家联盟徽章、R2 直链域名都可能换
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  // API_BASE 还没填对（占位没换、地址不成形）时不能把评论与统计锁死：那一下是静默的，
  // 页面照常出、只有评论区一直转圈，最难查。所以这一档退回 https:，等地址填对自动收紧。
  `connect-src 'self'${API_ORIGIN ? ` ${API_ORIGIN}${API_SIBLINGS}` : ' https:'}`,
  "media-src 'self' https: blob:",
  // 正文允许嵌各家播放器（bilibili / 优酷 / 腾讯 / 网易云 / 酷狗 / YouTube…），域名清单堵不完；
  // 框架里是另一份文档，读不到本站的 DOM 与 Cookie，放开这条不给注入脚本增加执行能力
  "frame-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * 安全响应头。
 * X-Content-Type-Options: Cloudflare Pages 现在自己会补这一条（线上实测有），但那是平台行为、
 * 不是这份配置给的 —— 写明白，换主机或平台改掉默认行为时不会静默少一条。
 * X-Frame-Options 用 SAMEORIGIN 而不是 DENY：正文里本来就允许嵌各家播放器 iframe，
 * 而「本站把本站框起来」这种用法不存在，SAMEORIGIN 已经够挡住点框架劫持。
 * Permissions-Policy 把摄像头/麦克风/定位/支付这类能力一次性关掉，
 * 免得第三方脚本（播放器、Cloudflare 的人机校验）自己去要设备权限。
 */
function applySecurityHeaders(res: Response): Response {
  try {
    // Pages 递出来的响应头是可以直接改的；万一哪天变成 immutable，也不能因此把页面搞挂
    res.headers.set('X-Content-Type-Options', 'nosniff');
    res.headers.set('X-Frame-Options', 'SAMEORIGIN');
    res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), fullscreen=(self)');
    res.headers.set('Content-Security-Policy', CSP);
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'SAMEORIGIN');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), fullscreen=(self)');
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

/** Pages 给中间件的三个方法；写成局部类型，这个文件不依赖任何全局 workers 类型 */
interface PagesContext {
  request: Request;
  next: () => Promise<Response>;
  fetch: (input: Request) => Promise<Response>;
}

export const onRequest = async (context: PagesContext) => {
  const url = new URL(context.request.url);
  const pathname = url.pathname;

  /* 站点地图：被关功能的地址不该继续留给爬虫。开关键活在 D1（运行时），
     sitemap.xml 却是构建期烤出来的静态文件 —— 只有在这一层过滤才做得到
     「后台一关就自动从地图里消失、一开就自动回来」，且不用动内容仓库、不用重新构建。 */
  if (pathname === '/sitemap.xml') {
    const res = await context.next();
    const data = await switches();
    const off = data ? offPrefixes(data) : [];
    if (!res.ok || !off.length) return applySecurityHeaders(res);
    /* 正文一旦被 text() 读走就再也放不回去，所以先留一份副本：过滤环节出任何意外都还能原样递出去 */
    const untouched = res.clone();
    try {
      const xml = await res.text();
      /* 一个 <url> 块 = 一条地址，整块删掉；只删 <url>…</url> 包住的那一段，
         贪婪匹配会把后面所有条目一起带走，所以这里必须用非贪婪 */
      const filtered = xml.replace(/<url>(?:(?!<\/?url>)[\s\S])*?<\/url>/g, (block) => {
        const loc = /<loc>([^<]*)<\/loc>/.exec(block);
        if (!loc) return block;
        let path = loc[1].trim();
        try {
          path = new URL(path).pathname;
        } catch {
          /* 不是绝对地址就按原样比 */
        }
        return off.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix)) ? '' : block;
      });
      const headers = new Headers(res.headers);
      // 正文长度变了，留着旧的 content-length 会让客户端截断或挂住
      headers.delete('content-length');
      return applySecurityHeaders(new Response(filtered, { status: res.status, statusText: res.statusText, headers }));
    } catch {
      // 过滤这一步出任何意外都不能把站点地图搞没：原样递出去
      return applySecurityHeaders(untouched);
    }
  }

  const key = gatedKey(pathname);
  if (!key) return applySecurityHeaders(await context.next());

  const data = await switches();
  if (!data || !isOff(data[key])) return applySecurityHeaders(await context.next());

  /* 关掉：取站点自己那份 404 页当响应体，但状态码要真是 404，并明确告诉爬虫别收。
     直接 new Response('404') 会让访客看到一个空白页，主题那个 404 页才是该有的样子。

     两个坑（都是线上踩过的）：
       · 要 fetch `/404`，不能写 `/404.html` —— Pages 的清洁 URL 会把后者 308 回前者，
         中间件里拿到一个 3xx 就等于取不到正文，整条 onRequest 抛异常变成 500。
       · 这一段绝不能冒 5xx：关掉的功能只是不该有页面，不是把站点搞挂。所以取正文全程
         try/catch，拿不到（没这页、非 200、异常）就用内联的最小 404 体，头照发。 */
  const html = await notFoundBody(context);
  const headers = new Headers();
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('x-robots-tag', 'noindex, nofollow');
  headers.set('cache-control', 'public, max-age=60');
  return applySecurityHeaders(new Response(html || MINIMAL_404, { status: 404, headers }));
};

/** 兜底正文：主题没出 404 页、或那一页取的时候出任何意外，都只回空串，由上面换成内联最小页 */
async function notFoundBody(context: PagesContext): Promise<string> {
  try {
    const res = await context.fetch(new Request(new URL('/404', context.request.url), { headers: context.request.headers }));
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

const MINIMAL_404 =
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>页面不存在或已关闭</title><h1>404</h1><p>这个功能已经关闭，或者页面不存在。</p></html>';
