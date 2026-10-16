import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import prompts, { type PromptObject } from 'prompts';
import { ROOT, assertShortMessages, die, good, info, step, warn } from './_util.js';

/**
 * 生成私密内容仓库 zero-site：pnpm create:site
 * 只做本地目录生成与本地提交，绝不会替你推送远端。
 *
 * 可全部用参数跳过交互：
 *   pnpm create:site -- --site-name=Demo --github-user=demo --repo=zero-site \
 *     --api=https://demo.workers.dev --site-url=https://demo.pages.dev \
 *     --theme-repo=https://github.com/demo/zero-theme.git --git=n
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

function git(cwd: string, ...cmd: string[]): string {
  const line = cmd.map((a) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(' ');
  const r = spawnSync(`git ${line}`, { cwd, shell: true, encoding: 'utf-8' });
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
        写成 p.githubUser 时 p 是上一题（站点域名）的字符串，取不到用户名 */
    initial: (_p: unknown, all: Partial<Answers>) => `https://github.com/${all.githubUser || 'username'}/zero-theme.git`,
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

      - uses: cloudflare/wrangler-action@v3
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
 * 那条路由就是 404（导航里的 主页 / 关于 / 归档 / 工具 / 工坊 / 订阅 / 账号 都是这种页）。
 * 正文一律留空：这些页显示的内容来自 data/*.json 与后台「前端管理」，Markdown 只是占位。
 */
const SECTIONS: [string, string][] = [
  ['home', '主页'],
  ['about', '关于'],
  ['archive', '归档'],
  ['tools', '工具'],
  ['work', '工坊'],
  ['subscribe', '邮箱订阅'],
  ['account', '账号'],
];

function sectionIndex(dir: string, title: string): string {
  return `---\ntitle: "${title}"\ntype: "${dir}"\nlayout: "list"\n---\n`;
}

async function main(): Promise<void> {
  console.log('\n🏗️  生成 zero-site（私密内容仓库）\n');
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
    }
  } catch (e) {
    warn(`子模块自动添加失败（多为未登录/仓库不存在/网络受限）：${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    info(`请稍后手动执行：${submodule}`);
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

  if (a.initGit) {
    git(siteDir, 'add', '.');
    git(siteDir, '-c', 'user.name=zero', '-c', 'user.email=zero@local', 'commit', '-m', 'feat: initial zero-site');
    good('本地提交完成（未推送）');
  }

  console.log('\n📤 推送指引（请你自己确认后再执行）');
  console.log(`  1. 在 GitHub 新建仓库：${a.repoName}，可见性必须选 Private`);
  console.log(`  2. cd ${a.repoName}`);
  console.log(`     git remote add origin https://github.com/${a.githubUser}/${a.repoName}.git`);
  console.log('     git push -u origin main');
  console.log('  3. 仓库 Settings → Secrets and variables → Actions 里添加 CF_API_TOKEN、CF_ACCOUNT_ID');
  console.log(`  4. Pages 项目名 ${a.repoName} 首次由 Actions 自动创建；自定义域名在 Cloudflare Pages 里绑定`);
  console.log('\n下一步：把站点地址加入 zero-api 的 ALLOWED_ORIGINS（packages/api/wrangler.jsonc），然后 pnpm deploy:api');
}

main().catch((e: unknown) => {
  die(e instanceof Error ? e.message : String(e));
});
