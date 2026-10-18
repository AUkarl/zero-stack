import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import prompts, { type PromptObject } from 'prompts';
import { ROOT, assertShortMessages, die, good, info, step, warn } from './_util.js';

/**
 * 生成私密内容仓库 zero-site：pnpm create:site
 * 默认只做本地目录生成与本地提交。加 `--publish` 并在环境变量里给 GITHUB_TOKEN，
 * 才会在 GitHub 上建 **Private** 仓库、挂 origin 并推 main（不显式加就一条都不会推）。
 *
 * 可全部用参数跳过交互：
 *   pnpm create:site -- --site-name=Demo --github-user=demo --repo=zero-site \
 *     --api=https://demo.workers.dev --site-url=https://demo.pages.dev \
 *     --theme-repo=https://github.com/demo/zero-theme.git --git=n
 *   GITHUB_TOKEN=... pnpm create:site -- ... --publish
 */

interface Answers {
  siteName: string;
  githubUser: string;
  repoName: string;
  apiBaseURL: string;
  siteUrl: string;
  themeRepo: string;
  initGit: boolean;
}

async function ask(questions: PromptObject[]): Promise<Answers> {
  const a = await prompts(questions, {
    onCancel: () => {
      console.log('\n已取消。');
      process.exit(0);
    },
  });
  return a as Answers;
}

function git(cwd: string, ...cmd: (string | { env?: Record<string, string> })[]): string {
  const env: Record<string, string> = {};
  const args: string[] = [];
  for (const part of cmd) {
    if (typeof part === 'object') Object.assign(env, part.env ?? {});
    else args.push(part);
  }
  const line = args.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(' ');
  const r = spawnSync(`git ${line}`, {
    cwd,
    shell: true,
    encoding: 'utf-8',
    env: Object.keys(env).length ? { ...process.env, ...env } : process.env,
  });
  /* 报错原文里不带 token：token 只在 env 里走，命令行与这条消息都看不到它 */
  if (r.status !== 0) throw new Error(`git ${line} 失败：${(r.stderr ?? '').trim()}`);
  return (r.stdout ?? '').trim();
}

function write(relative: string, content: string): void {
  const file = resolve(relative);
  mkdirSync(file.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  writeFileSync(file, content);
  info(relative);
}

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

/** 递归复制目录。跳过软链：exampleSite/themes 是指回主题根的软链，跟着走会无限递归。 */
function copyTree(from: string, to: string): number {
  let n = 0;
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    if (ent.isSymbolicLink()) continue;
    const src = resolve(from, ent.name);
    const dst = resolve(to, ent.name);
    if (ent.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      n += copyTree(src, dst);
    } else {
      writeFileSync(dst, readFileSync(src));
      n++;
    }
  }
  return n;
}

/**
 * 主题的演示站 exampleSite 就是「开箱该长什么样」的那一份：四篇示例文章、
 * 页脚（ICP 占位与社交图标）/ 关于 / 工坊 / 友链 / 作者的示例数据，
 * 以及示例正文引用的那几张图。新站直接拿它当内容，用户不想要再自己删。
 *
 * 它按 content/zh/** 组织（单语言站点），生成的仓库是扁平的 content/**，
 * 所以复制时要把 zh 这一层抹平 —— 留着 Hugo 会把 zh 当成一个叫 zh 的分区，
 * 站里同时出现 /posts/ 和 /zh/posts/ 两套页面。
 */
function importExampleSite(siteDir: string): number {
  const es = resolve(siteDir, 'themes/zero/exampleSite');
  const content = resolve(es, 'content');
  if (!existsSync(content)) return 0;
  let n = 0;
  const zh = resolve(content, 'zh');
  if (existsSync(zh)) n += copyTree(zh, resolve(siteDir, 'content'));
  for (const ent of readdirSync(content, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    writeFileSync(resolve(siteDir, 'content', ent.name), readFileSync(resolve(content, ent.name)));
    n++;
  }
  for (const sub of ['data', 'static'] as const) {
    const from = resolve(es, sub);
    if (!existsSync(from)) continue;
    mkdirSync(resolve(siteDir, sub), { recursive: true });
    n += copyTree(from, resolve(siteDir, sub));
  }
  return n;
}

/**
 * 边缘 404 中间件的模板：scripts/site-template/functions/_middleware.ts
 * 里面只有 __ZERO_API_BASE__ 一个占位，生成仓库时换成填好的接口地址。
 * 单独放成一个文件而不是写在代码里：能直接读、直接改，也不用处理模板字符串里的正则转义。
 */
function switchGuard(apiBase: string): string {
  const file = resolve(ROOT, 'scripts/site-template/functions/_middleware.ts');
  if (!existsSync(file)) die(`找不到边缘 404 中间件模板：${file}`);
  return readFileSync(file, 'utf-8').replaceAll('__ZERO_API_BASE__', apiBase);
}

/** 命令行给的值优先，且不再追问 —— 便于在 CI 或无 TTY 环境下使用 */
const PRESET: Partial<Answers> = {
  siteName: flag('site-name'),
  githubUser: flag('github-user'),
  repoName: flag('repo'),
  apiBaseURL: flag('api'),
  siteUrl: flag('site-url'),
  themeRepo: flag('theme-repo'),
  initGit: flag('git') === undefined ? undefined : flag('git') !== 'n',
};

function skipped(name: keyof Answers): 'text' | 'confirm' | null {
  return PRESET[name] !== undefined ? null : name === 'initGit' ? 'confirm' : 'text';
}

const QUESTIONS: PromptObject[] = [
  { type: skipped('siteName'), name: 'siteName', message: '站点名称', initial: 'My Zero Site' },
  { type: skipped('githubUser'), name: 'githubUser', message: 'GitHub 用户名' },
  { type: skipped('repoName'), name: 'repoName', message: '内容仓库名', initial: 'zero-site' },
  {
    type: skipped('apiBaseURL'),
    name: 'apiBaseURL',
    message: 'API 地址',
    initial: 'https://zero-api.<your-subdomain>.workers.dev',
  },
  { type: skipped('siteUrl'), name: 'siteUrl', message: '站点域名', initial: 'https://example.com' },
  {
    type: skipped('themeRepo'),
    name: 'themeRepo',
    message: 'zero-theme 仓库地址',
    /** prompts 给回调的第一个参数是上一题的答案值，已答集合在第二个：
        写成 p.githubUser 时 p 是上一题（站点域名）的字符串，取不到用户名。
        用户名也可能来自命令行（那时 prompts 根本没答这一题），所以再看 PRESET。 */
    initial: (_p: unknown, all: Partial<Answers>) => `https://github.com/${all.githubUser || PRESET.githubUser || 'username'}/zero-theme.git`,
  },
  { type: skipped('initGit'), name: 'initGit', message: '本地 git init 并提交？', initial: true },
];

assertShortMessages(QUESTIONS);

function hugoToml(a: Answers): string {
  return `baseURL = "${a.siteUrl.replace(/\/$/, '')}/"
locale = "zh-CN"
title = "${a.siteName}"
theme = "zero"
defaultContentLanguage = "zh"
hasCJKLanguage = true

# 分类法：主题的 layouts/taxonomy/author.html 与文章页署名都要 author 这一项，
# 而 Hugo 不会读主题里的 [taxonomies] —— 只能在站点这份配置声明。
# 少了 author，文章页顶部的作者昵称就点不进 /author/<标识>/。
# 这里刻意不声明 category / tag：Hugo 只为声明过的分类法生成聚合页，
# 所以站不会长出 /categories/ 与 /tags/；文章里的分类、标签照常显示为文字。
# 想要那两个页面时把下面两行注释去掉即可（主题有现成模板）。
[taxonomies]
  author = "author"
  # category = "categories"
  # tag = "tags"

# 文章列表页 /posts/ 不生成：导航里已经有「归档」承担列表职责。
# 想恢复就删掉 content/posts/_index.md 里那三行 build。

# 时刻与文章的时间由后台自由填写，将来日期也要立刻上线。
# Hugo 0.146+ 只认 [build].future，写在顶层的 enableFuture 会被静默忽略。
[build]
  future = true

[params]
  # 这里故意什么都不写。站点的参数全部放在 config/_default/params.toml ——
  # Hugo 会把两处合并，但 config/_default/params.toml 的优先级更高（实测同名键以它为准），
  # 写在这里只会被那份静默盖掉：apiBaseURL 变空 = 整站退回纯静态，评论、点赞、订阅全不工作。
  # 想覆盖主题外观，直接改 config/_default/params.toml 那一份（每个键都带注释），
  # 或在后台「前端管理 → 主题配置文件」里改同一份文件。

[markup]
  [markup.highlight]
    noClasses = false
  [markup.goldmark.renderer]
    unsafe = true

[minify]
  disableXML = true
  minifyOutput = true
`;
}

function deployWorkflow(a: Answers): string {
  return `name: Deploy to Cloudflare Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          fetch-depth: 0

      - uses: peaceiris/actions-hugo@v3
        with:
          hugo-version: 'latest'
          extended: true

      - name: Build
        run: hugo --minify

      # 没配 Secrets 就只做构建、不发布：否则这一步天天以「Missing CLOUDFLARE_API_TOKEN」失败，
      # 每次 push 都给你发一封 GitHub 失败邮件。Pages 直连 Git 的站点本来就不需要这条通道 ——
      # push 自己就是构建触发器，这里只是给「不想连 Pages Git 集成、想用 Actions 推」的人留的口。
      - name: Detect Cloudflare credentials
        id: cf
        env:
          CF_API_TOKEN: \${{ secrets.CF_API_TOKEN }}
          CF_ACCOUNT_ID: \${{ secrets.CF_ACCOUNT_ID }}
        run: |
          if [ -n "\$CF_API_TOKEN" ] && [ -n "\$CF_ACCOUNT_ID" ]; then
            echo "enabled=true" >> "\$GITHUB_OUTPUT"
          else
            echo "enabled=false" >> "\$GITHUB_OUTPUT"
            echo "::notice::未配置 CF_API_TOKEN / CF_ACCOUNT_ID，跳过发布（只构建）。站点若已用 Cloudflare Pages 的 Git 集成，本来就不需要这一步。"
          fi

      - name: Deploy to Cloudflare Pages
        if: steps.cf.outputs.enabled == 'true'
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CF_API_TOKEN }}
          accountId: \${{ secrets.CF_ACCOUNT_ID }}
          command: pages deploy public --project-name=${a.repoName}
`;
}

const SAMPLE_POST = `---
title: "Hello World"
date: 2026-01-01T12:00:00+08:00
draft: false
tags: ["zero"]
description: "第一篇示例文章"
---

欢迎使用 Zero 主题。删除这篇示例后即可开始写作。

评论、点赞、订阅由 zero-api 提供，无需再部署 Waline / Twikoo。
`;

const SAMPLE_MOMENT = `---
title: "第一条时刻"
date: 2026-01-01T12:00:00+08:00
type: moment
draft: false
---

这是第一条示例时刻，删掉它就能开始记录。
`;

const LINKS_DATA = `# 友链页的数据文件：主题的 layouts/links/list.html 读 hugo.Data.links
# 的 friends:（左邻右舍）与 alliance:（站点联盟）两段，缺段不会报错，页面就是空的。
# 后台「友链」每次改动都会同步这份文件；条目也可以直接在这里手写。
friends:
alliance:
`;

/** 主题的模板是 layouts/links/list.html，内容分区必须叫 links，叫 friends 的话 /links/ 直接 404 */
const LINKS_INDEX = `---
title: "友链"
description: "朋友们的最近动态、左邻右舍与站点联盟，以及友链申请方式。"
comments: true
---

## 友链要求

想要互换链接，请先确认：站点可正常访问、有 RSS、内容以原创为主、近三个月有更新。

符合的话，用下面的申请表单提交即可，站长会在后台审核。

<!-- 左邻右舍与站点联盟的名单由 zero-cms 后台「友链」维护，此页只写要求与说明。 -->
`;

/**
 * 主题的每个页面都靠 `layouts/<分区>/list.html` 渲染，少了 `content/<分区>/_index.md`
 * 那条路由就是 404（导航里的 主页 / 关于 / 归档 / 工坊 / 订阅 / 账号 都是这种页）。
 * 正文一律留空：这些页显示的内容来自 data/*.json 与后台「前端管理」，Markdown 只是占位。
 */
const SECTIONS: [string, string][] = [
  ['home', '主页'],
  ['about', '关于'],
  ['archive', '归档'],
  ['work', '工坊'],
  ['subscribe', '邮箱订阅'],
  ['account', '账号'],
];

function sectionIndex(dir: string, title: string): string {
  return `---\ntitle: "${title}"\ntype: "${dir}"\nlayout: "list"\n---\n`;
}

export interface PublishDeps {
  /** 测试里指到假 API；默认打真的 GitHub */
  apiBase?: string;
  /** 测试里指到本地 bare 仓库的父目录（file:///…/someone），默认 https://github.com */
  remoteBase?: string;
  fetchImpl?: typeof fetch;
}

function oneLine(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
}

/**
 * 建 Private 仓库 → 挂 origin → 推 main。只在 --publish + GITHUB_TOKEN 时走到这里。
 *
 * 三道保险：
 * - 同名仓库已存在时，先确认它确实是 Private 才复用；是 Public 就直接停手 —— 脚本不该替人改可见性，
 *   而 Private 仓库推上去的东西，事后仍能整仓库删掉；
 * - token 只走 `GIT_CONFIG_*` 环境变量，不进命令行、不进 .git/config（origin 存的是干净地址），
 *   所以它既不会留在 shell 历史里，也不会跟着仓库被人 copy 走；
 * - GIT_TERMINAL_PROMPT=0：凭据不对时 git 会当场失败，而不是挂在一个没人看见的用户名提示上等输入。
 */
export async function publishSiteRepo(siteDir: string, a: Answers, token: string, deps: PublishDeps = {}): Promise<string> {
  const api = (deps.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const web = (deps.remoteBase ?? 'https://github.com').replace(/\/+$/, '');
  const f = deps.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'zero-stack-create-site' };
  /** 外面套一层：网络不通/被代理拦下时 fetch 抛的是 TypeError，光看那句谁都以为令牌错了 */
  const gh = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await f(api + path, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
    } catch (e) {
      die(
        `连不上 GitHub API（${api}）：${oneLine(e instanceof Error ? `${e.message} ${(e as { cause?: { code?: string } }).cause?.code ?? ''}` : String(e))}\n` +
          '  这是传输层的问题（证书/网络），不是令牌不对：没建仓也没推送，本地提交仍在 ' + resolve(siteDir) + '。\n' +
          '  git 自己通常能走通（这台机器就是），所以最省事的一条路是在网页上建好 Private 仓库，然后：\n' +
          `    cd ${resolve(siteDir)} && git remote add origin https://github.com/${a.githubUser}/${a.repoName}.git && git push -u origin main\n` +
          '  换了能直连 api.github.com 的网络后，重跑同样的 --publish 命令即可由脚本代做。',
      );
      throw e;
    }
  };

  const res = await gh('/user/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: a.repoName, private: true, auto_init: false, has_issues: false, has_wiki: false, has_downloads: false }),
  });
  if (res.status !== 201) {
    const text = await res.text().catch(() => '');
    const exists = res.status === 422 && /exist/i.test(text);
    if (!exists) {
      die(
        `建仓失败（HTTP ${res.status}）：${oneLine(text)}\n` +
          '  令牌要能建仓库：classic PAT 勾 repo 作用域；Fine-grained 令牌建不了仓库，请在网页上先建好再去掉 --publish。\n' +
          '  不想让脚本代办就把这条命令记下来，之后手动推：cd ' +
            resolve(siteDir) + ' && git remote add origin ' + `${web}/${a.githubUser}/${a.repoName}.git && git push -u origin main`,
      );
    }
    const probe = await gh(`/repos/${a.githubUser}/${a.repoName}`, {});
    const meta = (await probe.json().catch(() => null)) as { private?: boolean } | null;
    if (!probe.ok) die(`同名仓库已存在，但读不到它的可见性（HTTP ${probe.status}）。为安全起见先不推：确认 ${a.githubUser}/${a.repoName} 是 Private 再重跑。`);
    if (meta?.private !== true) die(`${a.githubUser}/${a.repoName} 已经存在，而且是 Public。这个脚本不会替你改可见性 —— 换仓库名，或在网页上改回 Private 后重跑。`);
    info(`${a.githubUser}/${a.repoName} 已存在且是 Private，直接往里推`);
  } else {
    good(`已在 GitHub 建好 Private 仓库：${a.githubUser}/${a.repoName}`);
  }

  const remote = `${web}/${a.githubUser}/${a.repoName}.git`;
  try {
    git(siteDir, 'remote', 'add', 'origin', remote);
  } catch {
    git(siteDir, 'remote', 'set-url', 'origin', remote);
  }
  const basic = Buffer.from(`x-access-token:${token}`, 'utf-8').toString('base64');
  git(siteDir, 'push', '-u', 'origin', 'main', {
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: `Basic ${basic}`,
    },
  });
  return `https://github.com/${a.githubUser}/${a.repoName}`;
}

async function main(): Promise<void> {
  console.log('\n🏗️  生成 zero-site（私密内容仓库）\n');
  /** 建仓+推送要显式开：--publish 与 GITHUB_TOKEN 缺一个就照旧只打印指引（先验，免得生成到一半才说不能推） */
  const publish = process.argv.includes('--publish');
  const ghToken = (process.env.GITHUB_TOKEN ?? '').trim();
  if (publish && !ghToken) {
    die(
      '--publish 需要环境变量 GITHUB_TOKEN（classic PAT，勾 repo 作用域）。\n' +
        '  PowerShell: $env:GITHUB_TOKEN="<你的令牌>" ; pnpm create:site -- ... --publish\n' +
        '  Git Bash:   GITHUB_TOKEN="<你的令牌>" pnpm create:site -- ... --publish\n' +
        '  令牌只用于这一次建仓与推送，既不写进生成的文件，也不写进 .git/config。\n' +
        '  不想给就别加 --publish：脚本照常生成并本地提交，结尾把建仓与推送的命令完整打印出来。',
    );
  }
  const a = { ...PRESET, ...(await ask(QUESTIONS)) } as Answers;
  if (!a.githubUser || !a.repoName || !a.siteUrl || !a.apiBaseURL) die('所有必填项都需要填写');
  /** 末尾斜杠必须去掉：主题拼的是 `${apiBaseURL}/api/...`，带斜杠就成了 //api，
      而 params 那行注释也写着「末尾不要带斜杠」—— 让人填错再靠注释提醒没意义。 */
  a.apiBaseURL = a.apiBaseURL.trim().replace(/\/+$/, '');
  a.siteUrl = a.siteUrl.trim().replace(/\/+$/, '');
  for (const [label, v] of [['API 地址', a.apiBaseURL], ['站点域名', a.siteUrl]] as const) {
    if (!/^https?:\/\/[^\s/]+\.[^\s/]+$/i.test(v)) die(`${label}不像完整 URL：${v}\n要形如 https://zero-api.xxx.workers.dev（协议 + 域名写全，末尾不要带斜杠）`);
  }

  const siteDir = resolve(ROOT, '..', a.repoName);
  /** 结尾的清单要按「哪些步骤其实没成」来印命令，不能让站主回头翻上面的日志 */
  let submodulePending = false;
  if (existsSync(siteDir) && readdirSync(siteDir).length > 0) {
    die(
      `${siteDir} 已存在且非空，请换一个仓库名或先手动清理。\n` +
        '  清理前先停掉跑在这个目录里的 hugo server —— Windows 下它占着目录，rm 会失败。',
    );
  }

  step('创建目录与示例内容');
  const dirs = ['content/posts', 'content/moments', 'content/links', 'static/images', 'data', '.github/workflows'];
  for (const [dir] of SECTIONS) dirs.push(`content/${dir}`);
  for (const d of dirs) mkdirSync(resolve(siteDir, d), { recursive: true });
  info(siteDir);

  const rel = (p: string) => resolve(siteDir, p);
  write(rel('hugo.toml'), hugoToml(a));
  write(rel('content/posts/hello-world.md'), SAMPLE_POST);
  write(rel('content/moments/first-moment.md'), SAMPLE_MOMENT);
  write(rel('data/links.yaml'), LINKS_DATA);
  write(rel('content/links/_index.md'), LINKS_INDEX);
  // 落地页（主题的 layouts/index.html）：空 front matter 即可，进去按回车到 /home/
  write(rel('content/_index.md'), '---\n---\n');
  for (const [dir, title] of SECTIONS) write(rel(`content/${dir}/_index.md`), sectionIndex(dir, title));
  // 个人中心：主题在 layouts/account/me/list.html 渲染它，少了这份内容页 /account/me/ 就是 404，
  // 而前端登录成功后普通用户正是跳这里
  write(rel('content/account/me/_index.md'), '---\ntitle: "个人中心"\ntype: "account"\nlayout: "me"\n---\n');
  write(rel('static/images/.gitkeep'), '');
  /**
   * 边缘 404 中间件：后台把某个功能关掉时，那个页面直接 404 且带 noindex（旧链接与搜索引擎都拦掉）。
   * 只有配了后端才有意义（开关在 /api/config 里），纯静态站不生成这个文件。
   */
  const apiBase = (a.apiBaseURL ?? '').trim().replace(/\/+$/, '');
  if (apiBase) write(rel('functions/_middleware.ts'), switchGuard(apiBase));
  write(rel('.gitignore'), `.hugo_build.lock
public/
resources/
node_modules/
.env
.env.local
.dev.vars
wrangler.toml
`);
  write(rel('.github/workflows/deploy.yml'), deployWorkflow(a));
  write(rel('README.md'), `# ${a.siteName}

私密内容仓库：文章 Markdown + 站点配置。主题以 git submodule 形式位于 \`themes/zero\`。

- 主题仓库：${a.themeRepo}
- 后端地址：${a.apiBaseURL}
- 部署：Cloudflare Pages（见 \`.github/workflows/deploy.yml\`）

## 需要的 GitHub Secrets

| 名称 | 说明 |
|---|---|
| \`CF_API_TOKEN\` | Cloudflare API Token，需 Pages 编辑权限 |
| \`CF_ACCOUNT_ID\` | Cloudflare 账户 ID |

## 本地预览

\`\`\`bash
git submodule update --init --recursive
hugo server -D
\`\`\`

> 本仓库包含个人内容，请保持 **Private**。
`);

  if (!a.initGit) {
    warn('已跳过 git 初始化。稍后可手动执行下面的命令。');
  } else {
    step('初始化 Git 仓库（仅本地）');
    git(siteDir, 'init', '-b', 'main');
    good('git init 完成');
  }

  step('引入 zero-theme 子模块');
  const submodule = `git submodule add ${a.themeRepo} themes/zero`;
  try {
    if (a.initGit) {
      git(siteDir, 'submodule', 'add', a.themeRepo, 'themes/zero');
      good('子模块已加入 themes/zero');
    } else {
      info(`待执行：${submodule}`);
      submodulePending = true;
    }
  } catch (e) {
    warn(`子模块自动添加失败（多为未登录/仓库不存在/网络受限）：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    info(`请稍后手动执行：${submodule}`);
    submodulePending = true;
    mkdirSync(resolve(siteDir, 'themes/zero'), { recursive: true });
    write(resolve(siteDir, 'themes/zero/.gitkeep'), '');
  }

  const imported = importExampleSite(siteDir);
  if (imported > 0) {
    /** 演示站自带 posts / moments 的样例，生成器那两份占位就撤掉，免得混成五篇 */
    for (const leftover of ['content/posts/hello-world.md', 'content/moments/first-moment.md']) {
      const p = resolve(siteDir, leftover);
      if (existsSync(p)) rmSync(p);
    }
    good(`已按主题演示站填入示例内容与示例数据（${imported} 个文件）`);
  } else {
    warn('没读到 themes/zero/exampleSite（子模块还没拉下来？）：这座站只有最小骨架，初始化子模块后重跑一次 create:site 才有完整示例');
  }

  /** 分区页是 Hugo 由目录自动造的，没有「只禁一个分区」的开关，
      所以给 posts 自己写一份 _index.md 并让它不渲染：/posts/ 变 404，
      而每篇文章、首页列表、归档页都不受影响。 */
  write(
    rel('content/posts/_index.md'),
    '---\ntitle: "文章"\ntype: "posts"\nlayout: "list"\nbuild: { render: never }\n---\n',
  );

  /* 站点参数只有一份：把主题那份「全量注释版」params.toml 复制成站点自己的，
     再把后端地址与默认署名写进去。取值优先级 data/*.json > 站点 params.toml > 主题 params.toml，
     而根目录 hugo.toml 的 [params] 低于站点这份 —— 所以后端地址只能写在这里。
     后台「前端管理 → 主题配置文件」读写的也正是这份文件，缺了它就只会显示「读取不到」。 */
  const themeParams = resolve(siteDir, 'themes/zero/config/_default/params.toml');
  const apiLine = `apiBaseURL = "${a.apiBaseURL}"   # zero-api 的 worker 域名，末尾不要带斜杠`;
  const authorLine = `author = "${a.githubUser}"`;
  if (existsSync(themeParams)) {
    const raw = readFileSync(themeParams, 'utf8');
    const patched = raw.replace(/^apiBaseURL\s*=.*$/m, apiLine).replace(/^author\s*=.*$/m, authorLine);
    if (!/^apiBaseURL\s*=/m.test(patched)) warn('主题 params.toml 里没有 apiBaseURL 这一行，没能自动写入后端地址，请自己在 config/_default/params.toml 补一行');
    write(rel('config/_default/params.toml'), patched);
    good('config/_default/params.toml 已按主题默认模板生成，并写入后端地址与默认署名');
  } else {
    write(
      rel('config/_default/params.toml'),
      `# 子模块还没拉下来，这里先放最小可用的一份。\n` +
        `# 执行 git submodule update --init --recursive 之后，把 themes/zero/config/_default/params.toml\n` +
        `# 整份复制过来替换本文件，就能拿到带注释的全量模板（后台「主题配置文件」编辑的就是它）。\n` +
        `${apiLine}\n${authorLine}\n`,
    );
    warn('没读到 themes/zero/config/_default/params.toml（子模块未初始化？）：已先生成只含后端地址的最小一份，拉下主题后按上面的注释换成全量模板');
  }

  /** 要推就先把这次没做的 git 步骤补齐：推一个「还没 init / 没子模块」的空壳比不推更难查 */
  if (publish && !a.initGit) {
    git(siteDir, 'init', '-b', 'main');
    good('补做 git init -b main');
  }
  if (publish && submodulePending) {
    const placeholder = resolve(siteDir, 'themes/zero/.gitkeep');
    if (existsSync(placeholder)) rmSync(resolve(siteDir, 'themes/zero'), { recursive: true, force: true });
    try {
      git(siteDir, 'submodule', 'add', a.themeRepo, 'themes/zero');
      submodulePending = false;
      good('补做子模块添加：themes/zero');
    } catch (e) {
      warn(`子模块还是没加成（${e instanceof Error ? e.message.split('\n')[0] : String(e)}）。主题空着推上去，Pages 构建必然失败，先按这条补：cd ${siteDir} && ${submodule} && git add . && git commit -m "chore: 主题子模块" && git push`);
    }
  }

  if (a.initGit || publish) {
    git(siteDir, 'add', '.');
    git(siteDir, '-c', 'user.name=zero', '-c', 'user.email=zero@local', 'commit', '-m', 'feat: initial zero-site');
    good('本地提交完成' + (publish ? '，准备推送' : '（未推送）'));
  }

  let pushed: string | null = null;
  if (publish) {
    step('建 Private 仓库并推送');
    pushed = await publishSiteRepo(siteDir, a, ghToken);
    good(`已推送到 ${pushed}（Private）`);
  }

  /**
   * 结尾只报「你还得做什么」。没加 --publish 时代办不了建仓：脚本手上没有 token，
   * 而可见性只能由你选 —— 私人内容一旦被推成 Public 就收不回。
   * 加了 --publish 就照打印的做，并把已经做完的那几步从清单里去掉，不留「再填一遍」的尾巴。
   */
  let n = 0;
  const todo = (text: string) => console.log(`  ${++n}. ${text}`);
  const note = (text: string) => console.log(`     ${text}`);
  console.log(pushed ? '\n📤 建仓与推送已代做，剩下这些还要你做' : '\n📤 接下来由你做的几步（脚本不替你建仓库、也不替你推送）');
  if (pushed) {
    todo(`仓库已建好并推上：${pushed} —— 可见性 Private，origin 已挂好（.git/config 里存的地址不含令牌）`);
  } else {
    todo('建仓库：到 https://github.com/new');
    note(`账户 ${a.githubUser} · 仓库名 ${a.repoName} · 可见性选 Private：里面有草稿与个人信息，建成 Public 就再也收不回`);
    note('⚠ 不要勾「Add a README / .gitignore / license」：远端有初始提交的话，第一次 push 会因两边历史无关而失败');
    todo('挂远端并推上去');
    note(`cd ${siteDir}`);
    note(`git remote add origin https://github.com/${a.githubUser}/${a.repoName}.git`);
    note('git push -u origin main');
    note('想让它自己办：GITHUB_TOKEN=<classic PAT，勾 repo> pnpm create:site -- … --publish');
    if (!a.initGit) note('（这次没做 git 初始化，先补：git init -b main && git add . && git commit -m "feat: initial zero-site"）');
  }
  if (submodulePending) {
    note(`（子模块还没加成，补：${submodule}，再 git submodule update --init --recursive）`);
  }
  if (!submodulePending && imported === 0) {
    note('（示例内容这次没进来：先 git submodule update --init --recursive，再重跑一次 pnpm create:site 覆盖生成）');
  }
  todo('给 Actions 两个 secret：仓库 Settings → Secrets and variables → Actions → New repository secret');
  note('CF_API_TOKEN（要有 Pages 编辑权限的 API Token）、CF_ACCOUNT_ID（Cloudflare 控制台首页右侧那串）');
  todo(`推 main 会触发首次构建；Pages 项目 ${a.repoName} 由 workflow 自动创建，自定义域名到 Cloudflare Pages → 该项目 → Custom domains 里绑`);
  note(`本机先看一眼效果：cd ${siteDir} && git submodule update --init --recursive && hugo server -D`);
  todo('让后台写得进这座仓库');
  note(`· zero-stack 的 packages/api/wrangler.jsonc 里 ALLOWED_ORIGINS 加上 ${a.siteUrl}，然后 pnpm deploy:api（不加就是后台一请求就被 CORS 拒掉）`);
  note(`· 后台「设置 → 内容仓库」填 owner=${a.githubUser} / repo=${a.repoName}，并存一个有 contents:write 的 token（密钥只进 worker secret，不进仓库）`);
  note(`· 主题侧的接口地址已经写在生成好的 config/_default/params.toml 里（apiBaseURL = ${a.apiBaseURL}），不用再改`);
}

/** 只有直接被执行时才跑生成流程；被 import（比如建仓那步的验证脚本）时不能顺带把站生成一遍 */
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e: unknown) => {
    die(e instanceof Error ? e.message : String(e));
  });
}
