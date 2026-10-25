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
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
const FROM_ENV = Boolean(process.env.LOCAL_REPO_DIR);
const ROOT = resolve(process.env.LOCAL_REPO_DIR || join(HERE, '..', '..', '..', 'me', 'zero-site'));

/* 目录不存在就别启动，并把算出来的路径与来源打出来。
   这条默认值按「仓库在 X/Y/zero-stack」这套布局猜，猜错时它可能正好指向另一座站点的目录；
   以前它会照常起来，只是每次回写都落进一个不存在的地方 —— 后台显示成功、git status 干净，
   要排查一轮才知道是这里。真要指向别处，显式给 LOCAL_REPO_DIR。 */
if (!existsSync(ROOT)) {
  console.error(`内容仓库桥接没有启动：目录不存在\n  路径 ${ROOT}\n  来源 ${FROM_ENV ? 'LOCAL_REPO_DIR 环境变量' : '按脚本位置算的默认值（没设 LOCAL_REPO_DIR）'}`);
  console.error(`要指向别的站点目录：LOCAL_REPO_DIR=<绝对路径> node scripts/local-repo-bridge.mjs\n（同时确认 packages/api/.dev.vars 里的 GIT_LOCAL_DIR 指的是同一个目录）`);
  process.exit(1);
}
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

  /*
   * 攒 Buffer 再一次性 toString：`for await (const chunk of req) body += chunk` 会把每个 TCP 分片
   * 各自按 UTF-8 解码，一个汉字（3 字节）正好被切开时那半截就成了 U+FFFD —— 中文正文一长就中招。
   */
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString('utf8');
  let input = {};
  try {
    input = body ? JSON.parse(body) : {};
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }

  const route = (req.url || '').split('?')[0];
  const isHealth = req.method === 'GET' && route === '/health';
  // /purge-page 清的是整个产物目录，不带具体文件路径，不能在这里被「越界」检查拦掉
  // /doctor 同理：它跑的是整站构建，不针对某个文件
  const noPathNeeded = isHealth || (req.method === 'POST' && (route === '/purge-page' || route === '/doctor'));
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
      /**
       * 构建体检：真跑一次 `hugo --minify`，把「这次写入会不会把整站构建打失败」告诉后台。
       * workerd 里起不了子进程，只有这个 Node 进程能跑；产物写进一次性目录，不碰 hugo server 正在用的 public/。
       * 需要它是因为 Hugo 对某些值（比如 `date: 2026-10-25 12:00`）是**整站退出码 1**，
       * 而后台每笔保存都回「已保存」，站主只会在很久之后发现站点停在旧版（台架 2026-10-25 F-01/O-06）。
       */
      case 'POST /doctor': {
        if (String(process.env.REPO_BRIDGE_DOCTOR ?? '').toLowerCase() === 'off') {
          return json(res, 200, { ran: false, ok: false, note: '桥接体检被 REPO_BRIDGE_DOCTOR=off 关着' });
        }
        const bin = process.env.HUGO_BIN || 'hugo';
        const dest = join(ROOT, '.zero-doctor');
        let r = null;
        let spawnErr = '';
        try {
          r = spawnSync(bin, ['--minify', '-d', dest], {
            cwd: ROOT,
            encoding: 'utf8',
            timeout: Number(process.env.HUGO_DOCTOR_TIMEOUT_MS || 90000),
          });
          if (r.error) spawnErr = String(r.error.message || r.error);
        } catch (e) {
          spawnErr = e instanceof Error ? e.message : String(e);
        }
        await rm(dest, { recursive: true, force: true }).catch(() => {});
        if (spawnErr) {
          return json(res, 200, { ran: false, ok: false, note: `hugo 没跑起来（${spawnErr.slice(0, 160)}）；不在 PATH 里就设 HUGO_BIN=<绝对路径>` });
        }
        const out = `${r.stdout || ''}\n${r.stderr || ''}`;
        const errors = out.split('\n').map((l) => l.trim()).filter((l) => /^ERROR\b/i.test(l)).slice(0, 5);
        const code = r.status ?? 1;
        return json(res, 200, {
          ran: true,
          ok: code === 0,
          exit: code,
          errors,
          note: code === 0
            ? '构建体检通过：这一笔写入没有把站点构建打坏'
            : `构建失败（退出码 ${code}）。线上跑的是同一条命令，Pages 会停在上一版 —— 按上面的 ERROR 行改那一篇再保存`,
        });
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
