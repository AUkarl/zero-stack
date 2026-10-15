// ============================================================
// local-repo-bridge.mjs —— 本地内容仓库桥接（只给本地开发用）
// ------------------------------------------------------------
// 为什么要它：后台发布文章 / 时刻 / 作者表 / 广告正则文件，最终都要落到站点目录。
// 线上 Worker 走 GitHub Contents API；本地 `wrangler dev` 跑在 workerd 里，
// 没有真实文件系统（node:fs 被 unenv 打成 "not implemented"），所以那几条链路
// 在本地会 502。这个进程把文件读写搬到 Node 侧，Worker 通过 http 调它。
//
// 用法：
//   LOCAL_REPO_DIR=../me/zero-site node scripts/local-repo-bridge.mjs
//   （或 pnpm repo:bridge，端口默认 127.0.0.1:8792）
// 配套：packages/api/.dev.vars 里设
//   GIT_LOCAL_DIR="/绝对路径/指向/你的站点目录"
//   GIT_LOCAL_HTTP="http://127.0.0.1:8792"
// ============================================================
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.REPO_BRIDGE_PORT || 8792);
/**
 * 站点目录默认按「脚本自己的位置」算，不按 cwd 算：
 * pnpm 在 Windows 下不支持 `VAR=x node …` 这种内联环境变量写法（整条命令直接失败），
 * 所以不能靠 package.json 里传 LOCAL_REPO_DIR。要指向别处再设那个环境变量。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(process.env.LOCAL_REPO_DIR || join(HERE, '..', '..', '..', 'me', 'zero-site'));
const TOKEN = process.env.REPO_BRIDGE_TOKEN || '';

/** 仓库内相对路径 → 绝对路径；越界（.. / 绝对路径 / 盘符）一律拒绝 */
function abs(rel) {
  const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').some((s) => s === '..' || s === '')) return null;
  const root = resolve(ROOT);
  const target = resolve(join(root, clean.split('/').join(sep)));
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return target;
}

const shaOf = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);

async function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  if (TOKEN && req.headers['x-repo-bridge'] !== TOKEN) return json(res, 403, { error: '桥接令牌不对' });

  let body = '';
  for await (const chunk of req) body += chunk;
  let input = {};
  try {
    input = body ? JSON.parse(body) : {};
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }

  const route = (req.url || '').split('?')[0];
  const isHealth = req.method === 'GET' && route === '/health';
  // /purge-page 清的是整个产物目录，不带具体文件路径，不能在这里被「越界」检查拦掉
  const noPathNeeded = isHealth || (req.method === 'POST' && route === '/purge-page');
  const file = noPathNeeded ? null : abs(input.path ?? input.dir ?? '');
  if (!noPathNeeded && !file) return json(res, 400, { error: '路径越界，只能读写站点目录内' });

  try {
    switch (req.method + ' ' + (req.url || '').split('?')[0]) {
      case 'POST /read': {
        try {
          const content = await readFile(file, 'utf8');
          return json(res, 200, { exists: true, content, sha: shaOf(content) });
        } catch {
          return json(res, 200, { exists: false, content: '', sha: '' });
        }
      }
      case 'POST /write': {
        if (typeof input.content !== 'string') return json(res, 400, { error: '缺少 content' });
        if (input.createOnly) {
          try {
            await stat(file);
            return json(res, 409, { error: '文件已存在' });
          } catch {
            /* 不存在才继续创建 */
          }
        }
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, input.content, 'utf8');
        return json(res, 200, { ok: true, path: input.path, sha: shaOf(input.content) });
      }
      case 'POST /delete': {
        await rm(file, { force: true });
        return json(res, 200, { ok: true, path: input.path });
      }
      case 'POST /purge-page': {
        // 只清构建产物：public/<kind>/<目录>/index.html。
        // 产物目录名是 Hugo urlize 出来的（中文标题去掉标点），从文件名猜不准，
        // 所以两种命中：目录名等于源文件名，或「这一页自己的 <title> 里有这个标题」。
        // 只看 <title>：页面里的上一篇/下一篇导航也带别的文章标题，全文匹配会误删邻居。
        const kind = String(input.kind ?? '').replace(/[^\w-]/g, '');
        const stem = String(input.stem ?? '');
        const title = String(input.title ?? '');
        if (!kind) return json(res, 400, { error: '缺少分类目录（posts / moments …）' });
        const base = join(ROOT, 'public', kind);
        let names = [];
        try {
          names = await readdir(base);
        } catch {
          return json(res, 200, { ok: true, removed: [] });
        }
        const pageTitle = (html) => ((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '').trim();
        const removed = [];
        for (const name of names) {
          const dir = join(base, name);
          let hit = name === stem;
          if (!hit && title) {
            const html = await readFile(join(dir, 'index.html'), 'utf8').catch(() => '');
            const t = pageTitle(html);
            hit = Boolean(t) && (t === title || t.startsWith(title) || t.endsWith(title));
          }
          if (!hit) continue;
          await rm(dir, { recursive: true, force: true });
          removed.push(`public/${kind}/${name}`);
        }
        return json(res, 200, { ok: true, removed });
      }
      case 'POST /list': {
        let names = [];
        try {
          names = await readdir(file);
        } catch {
          return json(res, 200, { entries: [] });
        }
        const entries = [];
        for (const name of names) {
          const rel = `${String(input.dir ?? '').replace(/\/+$/, '')}/${name}`;
          try {
            const st = await stat(abs(rel) ?? file);
            entries.push({ name, path: rel.replace(/^\//, ''), type: st.isDirectory() ? 'dir' : 'file' });
          } catch {
            entries.push({ name, path: rel.replace(/^\//, ''), type: 'file' });
          }
        }
        return json(res, 200, { entries });
      }
      case 'GET /health':
        return json(res, 200, { ok: true, root: ROOT });
      default:
        return json(res, 404, { error: '接口不存在' });
    }
  } catch (e) {
    return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`内容仓库桥接已启动：http://127.0.0.1:${PORT}  根目录 ${ROOT}`);
});
