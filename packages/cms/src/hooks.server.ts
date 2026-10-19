/** SvelteKit 3 起，hooks 的类型从 @sveltejs/kit/hooks 导出，不在 '@sveltejs/kit' 顶层 */
import type { Handle } from '@sveltejs/kit/hooks';

/**
 * 后台的安全响应头。
 *
 * 为什么在 hook 里加而不是 `_headers` 文件：这个后台是 adapter-cloudflare 的 SSR 产物，
 * 每一个页面请求都由 Worker 出，Pages 的 `_headers` 只对静态资源那条路生效，
 * 写在那里等于给最该保护的那几页没加。
 *
 * X-Frame-Options: DENY（不是 SAMEORIGIN）：后台不需要被任何页面框住，包括它自己。
 * 站长带着已登录的会话被别人诱导点开一个伪装页面时，框里的「删除文章」「恢复备份」
 * 就是真的执行 —— 这是后台唯一必须挡住的一类攻击。
 *
 * 不加 CSP：后台用了内联样式与 SvelteKit 自己的脚本，CSP 要一次配全才敢开，漏一项
 * 就是后台整页白屏。单独排期，不顺手做。
 */
export const handle: Handle = async ({ event, resolve }) => {
  const res = await resolve(event);
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)');
  return res;
};
