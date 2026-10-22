/** SvelteKit 3 起，hooks 的类型从 @sveltejs/kit/hooks 导出，不在 '@sveltejs/kit' 顶层 */
import type { Handle } from '@sveltejs/kit/hooks';
import { dev } from '$app/env';

/**
 * 后台的安全响应头。
 *
 * 为什么在 hook 里加而不是 `_headers` 文件：这个后台是 adapter-cloudflare 的 SSR 产物，
 * 每一个页面请求都由 Worker 出，Pages 的 `_headers` 只对静态资源那条路生效，
 * 写在那里等于给最该保护的那几页没加。
 *
 * X-Frame-Options: DENY（不是 SAMEORIGIN）：后台不需要被任何页面框住，包括它自己。
 * 站长带着已登录的会话被别人诱导点开一个伪装页面时，框里的「删除文章」「恢复备份」
 * 就是真的执行 —— 这是后台唯一必须挡住的一类攻击。CSP 里的 frame-ancestors 'none' 是同一件事的现代写法。
 */
const HEADERS: Array<[string, string]> = [
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), fullscreen=(self)'],
];

/**
 * 后台的 CSP。和前台那份的差别只在「后台没有第三方脚本」：
 *   · script-src 不放任何 CDN —— 后台的模块脚本全是自己构建出来的产物，被注入的脚本想外联也带不走代码；
 *     'unsafe-inline' 去不掉是实测结论：SvelteKit 自己烘了一段引导脚本（设 __sveltekit 版本号、
 *     取 currentScript 的父节点），Cloudflare 也会在页面里注一段同源脚本，两段的写法都不带 nonce/hash。
 *   · frame-ancestors 'none'：上面 X-Frame-Options 那段说的就是这件事。
 *   · connect-src 只能放宽到整个 https：接口地址是登录页现场填的、存在浏览器 localStorage，
 *     服务端出这份 HTML 时根本拿不到它，写死任何域名都会把「换一台 worker 登录」这个正常用法打死。
 *     这一条松开不影响上面几条硬拦：数据要外传，先得有能跑的脚本，而脚本只认本站产物与内联。
 *   · img-src 放过 https 与 blob：媒体库预览走各桶自己的 baseUrl（可以在任何域），
 *     上传前的压缩图是 canvas 现出的 blob。
 *   · dev 多带 localhost 与 ws：`pnpm dev` 的 HMR 是同源 websocket，vite 还会往页面里注内联脚本。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' https: wss:${dev ? ' http://localhost:* ws://localhost:* ws://127.0.0.1:*' : ''}`,
  "media-src 'self' https: blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const handle: Handle = async ({ event, resolve }) => {
  const res = await resolve(event);
  for (const [k, v] of HEADERS) res.headers.set(k, v);
  res.headers.set('Content-Security-Policy', CSP);
  return res;
};
