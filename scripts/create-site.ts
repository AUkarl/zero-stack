import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import prompts, { type PromptObject } from 'prompts';
import { ROOT, die, good, info, step, warn } from './_util.js';

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
  { type: skipped('repoName'), name: 'repoName', message: '内容仓库名（务必私密）', initial: 'zero-site' },
  {
    type: skipped('apiBaseURL'),
    name: 'apiBaseURL',
    message: 'API 地址',
    initial: 'https://zero-api.<your-subdomain>.workers.dev',
  },
  { type: skipped('siteUrl'), name: 'siteUrl', message: '站点域名（Pages 部署后回填也可）', initial: 'https://example.com' },
  {
    type: skipped('themeRepo'),
    name: 'themeRepo',
    message: 'zero-theme 仓库地址',
    initial: (p) => `https://github.com/${p.githubUser || 'username'}/zero-theme.git`,
  },
  { type: skipped('initGit'), name: 'initGit', message: '本地 git init 并提交（不会推送远端）', initial: true },
];

function hugoToml(a: Answers): string {
  return `baseURL = "${a.siteUrl.replace(/\/$/, '')}/"
languageCode = "zh-CN"
title = "${a.siteName}"
theme = "zero"
defaultContentLanguage = "zh"
hasCJKLanguage = true

# 时刻与文章的时间由后台自由填写，将来日期也要立刻上线。
# Hugo 0.146+ 只认 [build].future，写在顶层的 enableFuture 会被静默忽略。
[build]
  future = true

[params]
  # 后端地址：zero-api 部署后填入
  apiBaseURL = "${a.apiBaseURL}"
  author = "${a.githubUser}"
  description = ""

  # 功能开关
  commentEnabled = true
  commentMaxDepth = 6
  likeEnabled = true
  subscribeEnabled = true
  momentsEnabled = true
  friendsEnabled = true
  analyticsEnabled = true

  # 前台账号系统与注册开关（后台「设置」页可改）
  accountSystemEnabled = true
  allowRegister = true

  # 以下主题外观参数按需覆盖 zero-theme 默认值，完整清单见主题 README
  # [params.home]
  # [params.article]
  # [params.footer]

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

时刻内容也可以直接在 zero-cms 后台发布并存入 D1，这里的 Markdown 只是静态兜底。
`;

const FRIENDS_DATA = `# 友链数据。若后台已启用友链管理，请以后台为准，此文件仅作备份。
- name: Example Blog
  url: https://example.com
  description: 示例站点
  avatar: /images/avatar/example.png
  rss: https://example.com/index.xml
`;

async function main(): Promise<void> {
  console.log('\n🏗️  生成 zero-site（私密内容仓库）\n');
  const a = { ...PRESET, ...(await ask(QUESTIONS)) } as Answers;
  if (!a.githubUser || !a.repoName || !a.siteUrl || !a.apiBaseURL) die('所有必填项都需要填写');

  const siteDir = resolve(ROOT, '..', a.repoName);
  if (existsSync(siteDir) && readdirSync(siteDir).length > 0) die(`${siteDir} 已存在且非空，请换一个仓库名或先手动清理`);

  step('创建目录与示例内容');
  const dirs = ['content/posts', 'content/moments', 'content/friends', 'static/images', 'data', '.github/workflows'];
  for (const d of dirs) mkdirSync(resolve(siteDir, d), { recursive: true });
  info(siteDir);

  const rel = (p: string) => resolve(siteDir, p);
  write(rel('hugo.toml'), hugoToml(a));
  write(rel('content/posts/hello-world.md'), SAMPLE_POST);
  write(rel('content/moments/first-moment.md'), SAMPLE_MOMENT);
  write(rel('data/friends.yml'), FRIENDS_DATA);
  write(rel('content/friends/.gitkeep'), '');
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
