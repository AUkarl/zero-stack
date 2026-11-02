/**
 * preview-with-middleware.mjs —— 在本地把**带边缘响应头的前台**跑起来。
 *
 * 为什么需要它：`hugo server` 只出 Hugo 的产物，**不会执行 `functions/_middleware.ts`**，
 * 于是本地看到的页面既没有 CSP 也没有缓存头。「本地看着好好的、推上去 Pages 之后资源被自家 CSP 挡掉」
 * 这一类差别（体检里量到过：后台与前台的 http 图片被 `img-src` 拦），只有让那份中间件真跑起来才看得见。
 * 这里用 node 的 http + 全局 Response 直接把站点产物喂给同一个 `onRequest`，只读、不写任何东西。
 *
 * 用法（在内容仓库目录里，或者把目录当参数传进来）：
 *   hugo --gc --minify -d public                       # 先出一份真实产物
 *   node <zero-stack>/scripts/preview-with-middleware.mjs [站点目录] [端口]
 *   默认站点目录 = 当前目录，默认端口 = 8888
 * 然后浏览器打开 http://127.0.0.1:8888/ ，控制台看有没有 violation，
 * 或者在 Console 里执行 `Array.from(document.images).filter(i=>i.naturalWidth===0).length` ——
 * **图片被 CSP 挡掉是不会留下任何可见痕迹的**，只看「有没有报错」会漏。
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SITE = resolve(process.argv[2] ?? '.');
const PORT = Number(process.argv[3] ?? 8888);
const PUB = join(SITE, 'public');
const MW = join(SITE, 'functions', '_middleware.ts');

if (!existsSync(MW)) {
  console.error(`没找到边缘中间件：${MW}\n（这份脚本要在**内容仓库**的根目录跑，或者把仓库路径当第一个参数传进来）`);
  process.exit(2);
}
if (!existsSync(join(PUB, 'index.html'))) {
  console.error(`静态产物不在 ${PUB}\n先跑一次：hugo --gc --minify -d public`);
  process.exit(2);
}

const { onRequest } = await import(pathToFileURL(MW).href);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.xml': 'application/xml',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.avif': 'image/avif', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};

function serveStatic(pathname) {
  const clean = decodeURIComponent(pathname);
  const bare = clean.replace(/^\/+|\/+$/g, '');
  const cands = extname(clean) ? [clean] : [join(bare, 'index.html'), `${clean.replace(/\/$/, '')}.html`, bare, join(bare, 'index.html')];
  for (const rel of cands) {
    const f = join(PUB, rel);
    if (existsSync(f) && statSync(f).isFile()) {
      return new Response(readFileSync(f), { status: 200, headers: { 'content-type': MIME[extname(f).toLowerCase()] ?? 'application/octet-stream' } });
    }
  }
  const nf = join(PUB, '404.html');
  return new Response(existsSync(nf) ? readFileSync(nf) : '404', { status: 404, headers: { 'content-type': MIME['.html'] } });
}

const edgeFetch = (input) => {
  const req = input instanceof Request ? input : new Request(String(input));
  return Promise.resolve(serveStatic(new URL(req.url).pathname));
};

const server = createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url, `http://127.0.0.1:${PORT}`);
  const req = new Request(url, {
    method: nodeReq.method,
    headers: { accept: nodeReq.headers.accept ?? '*/*', 'user-agent': nodeReq.headers['user-agent'] ?? '' },
  });
  let res;
  try {
    res = await onRequest({ request: req, next: () => Promise.resolve(serveStatic(url.pathname)), fetch: edgeFetch });
  } catch (e) {
    nodeRes.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    nodeRes.end(`中间件抛异常：${String(e)}`);
    return;
  }
  nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
  nodeRes.end(Buffer.from(await res.arrayBuffer()));
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`带边缘头的前台已在 http://127.0.0.1:${PORT}（产物 ${PUB}；中间件 ${MW}）`);
