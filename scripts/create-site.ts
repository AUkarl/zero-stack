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
  /* 没有终端时不提问：prompts 在 CI / 管道里永不 resolve，进程既不报错也不退出。
     全部参数都能用命令行给（见 --help），缺的照旧由必填校验报错。 */
  if (!process.stdin.isTTY) {
    console.log('\x1b[33m非交互环境（没有可用的终端）：不再提问，只用命令行参数给的值；缺的必填项会当场报错。\x1b[0m');
    console.log('   完整写法：pnpm create:site --site-name=… --github-user=… --repo=… --api=… --site-url=… --theme-repo=… --git=y');
    return {} as Answers;
  }
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
 * 它按 content/zh/** 组织，生成的仓库也是这个结构，整份原样复制即可 ——
 * 那层 zh 不能抹平：hugo.toml 里 [languages.zh] contentDir = "content/zh" 认的就是这个路径，
 * 抹平了 Hugo 就找不到内容目录，后台发出去的文章（写在 content/zh/ 下）不会出现在站上。
 */
function importExampleSite(siteDir: string): number {
  const es = resolve(siteDir, 'themes/zero/exampleSite');
  const content = resolve(es, 'content');
  if (!existsSync(content)) return 0;
  let n = copyTree(content, resolve(siteDir, 'content'));
  for (const sub of ['data', 'static'] as const) {
    const from = resolve(es, sub);
    if (!existsSync(from)) continue;
    mkdirSync(resolve(siteDir, sub), { recursive: true });
    n += copyTree(from, resolve(siteDir, sub));
  }
  return n;
}

/**
 * 演示站的示例数据里有几处只属于「演示站」自己的值：站点名「示例站点」、
 * `00000000号-1` 这类备案号、还有 example.com 的友链申请信息。整份复制过来时
 * 生成器手上已经有用户刚填的站点名 / 域名 / GitHub 用户名 —— 能推出来的当场填上，
 * 推不出来的清空，免得新站第一次构建就把「示例站点」摆到访客面前。
 *
 * 清空依赖主题那套「空数组 = 还没填」的取法（partials/cms/list.html）：回落的是
 * params 里本来就留空的项，不会出现「后台一保存整块消失」的意外；
 * home.desc 清空后走的是模板里那句默认介绍语。返回改写的文件数。
 */
function backfillExampleData(siteDir: string, a: Answers): number {
  const name = a.siteName.trim() || '我的站点';
  const url = a.siteUrl.trim().replace(/\/+$/, '');
  const handle = a.githubUser.trim();

  type Row = Record<string, unknown>;
  const file = (p: string) => resolve(siteDir, p);
  const read = (p: string): Row | null => {
    if (!existsSync(file(p))) return null;
    try {
      const raw = JSON.parse(readFileSync(file(p), 'utf8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Row) : null;
    } catch {
      /** 读不懂就整段跳过：新站照旧带着示例值，构建不会因为这一步崩 */
      return null;
    }
  };
  let changed = 0;
  const save = (p: string, obj: Row) => {
    writeFileSync(file(p), JSON.stringify(obj, null, 2) + '\n');
    changed++;
  };
  const rows = (v: unknown): Row[] =>
    Array.isArray(v) ? v.filter((it): it is Row => !!it && typeof it === 'object' && !Array.isArray(it)) : [];
  const text = (v: unknown) => String(v ?? '').trim();
  /** demo 域名的链接点了就是别人的站，比少一条更糟 */
  const demoLink = (v: unknown) => /^https?:\/\/(www\.)?example\.com/i.test(text(v));

  const site = read('data/site.json');
  if (site) {
    if (text(site.name) === '示例站点') site.name = name;
    if (text(site.navName) === '示例站点') site.navName = name;
    if (!text(site.siteUrl) && url) site.siteUrl = url;
    if (text(site.description).includes('占位')) site.description = '';
    save('data/site.json', site);
  }

  const footer = read('data/footer.json');
  if (footer) {
    if (text(footer.copyrightText).includes('我的站点名')) footer.copyrightText = text(footer.copyrightText).replace('我的站点名', name);
    /** 备案号：留着一串 0 比不写更容易被当成真备案 */
    if (Array.isArray(footer.icpItems)) {
      footer.icpItems = rows(footer.icpItems).filter((it) => !/0{6,}/.test(text(it.text)));
    }
    for (const key of ['services', 'socialRow1', 'socialRow2'] as const) {
      if (!Array.isArray(footer[key])) continue;
      footer[key] = rows(footer[key])
        .map((it) =>
          /** GitHub 那条能补：用户名就是刚才填的那一个。其余 demo 链接（X、站点联盟、打赏）删掉 */
          /^github$/i.test(text(it.name)) && demoLink(it.link) && handle ? { ...it, link: `https://github.com/${handle}` } : it,
        )
        .filter((it) => !demoLink(it.link));
    }
    save('data/footer.json', footer);
  }

  const home = read('data/home.json');
  if (home && text(home.desc).includes('占位')) {
    home.desc = '';
    save('data/home.json', home);
  }

  const about = read('data/about.json');
  if (about && Array.isArray(about.contacts)) {
    about.contacts = rows(about.contacts).filter((it) => !demoLink(it.url) && !/example\.com|@email\.com/i.test(text(it.text)));
    save('data/about.json', about);
  }

  const apply = read('data/apply.json');
  if (apply && Array.isArray(apply.myInfo)) {
    /** 「我的信息」是给访客看的本站资料：示例值一律换掉，换不出来的整行删掉 */
    apply.myInfo = rows(apply.myInfo)
      .map((it) => {
        const value = text(it.value);
        if (value === '示例站点') return { ...it, value: name };
        if (demoLink(value)) {
          const tail = value.replace(/^https?:\/\/(www\.)?example\.com/i, '');
          if (/^\/index\.xml$/i.test(tail)) return { ...it, value: `${url}/index.xml` };
          if (tail === '' || tail === '/' || /^\/home\/?$/i.test(tail)) return { ...it, value: `${url}/` };
          return { ...it, value: '' };
        }
        if (/@email\.com$/i.test(value) || value.includes('一句话介绍你的网站')) return { ...it, value: '' };
        return it;
      })
      .filter((it) => text(it.value) !== '');
    save('data/apply.json', apply);
  }

  /** 作者资料表：顶部署名与文章底部作者框读这里，那句「占位作者」和 your-username 同理处理。 */
  if (existsSync(file('data/authors.yaml'))) {
    const raw = readFileSync(file('data/authors.yaml'), 'utf8');
    const patched = raw
      .replace(/^(\s*)bio_zh:\s*["']?占位作者[^\n]*$/m, '$1bio_zh: ""')
      .replace(/https:\/\/github\.com\/your-username/i, handle ? `https://github.com/${handle}` : 'https://github.com');
    if (patched !== raw) {
      writeFileSync(file('data/authors.yaml'), patched);
      changed++;
    }
    /** shape-list / shape-map 是主题自己的构建用例（联系方式的两种形状都得能渲染，
        只用一种形状测曾经放过一个打死整站构建的 bug）。它们不该出现在用户站里：
        那两条挂着 github.com/example 与 you@example.com，会在演示文章的作者框和 /author/ 页上显示出来。
        所以新站只留 zero-author，引用那两条的演示文章改挂到 zero-author；主题 exampleSite 里原样保留给 CI 用。 */
    const kept: string[] = [];
    let drop = false;
    for (const line of patched.split('\n')) {
      // 顶级键行（不是注释、不是缩进行）决定后面这些行要不要丢；注释与空行跟着当前块的判定走
      const key = /^[ \t]*#/.test(line) || /^[ \t]/.test(line) || /^[ \t]*$/.test(line)
        ? null
        : /^([^\s:]+):/.exec(line)?.[1] ?? null;
      if (key) drop = key === 'shape-list' || key === 'shape-map';
      if (drop) continue;
      kept.push(line.replace(/下面两条就是这两种[^\n]*/, '（联系方式的两种形状在主题自己的演示站里各留了一条用例，新站只留下面这一条。）'));
    }
    const pruned = kept.join('\n');
    if (pruned !== patched) writeFileSync(file('data/authors.yaml'), pruned);
    const postsDir = file('content/zh/posts');
    if (existsSync(postsDir)) {
      for (const f of readdirSync(postsDir)) {
        if (!f.endsWith('.md')) continue;
        const p = resolve(postsDir, f);
        const body = readFileSync(p, 'utf8');
        const fixed = body.replace(/^author:\s*["']?(?:shape-list|shape-map)["']?\s*$/gm, 'author: "zero-author"');
        if (fixed !== body) writeFileSync(p, fixed);
      }
    }
  }
  return changed;
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
defaultContentLanguageInSubdir = false
hasCJKLanguage = true

# robots.txt：主题的 layouts/robots.txt 要这一项才会产出文件。
# 不开它，新建的站根本没有 /robots.txt（沙箱实测 404），爬虫只能靠自己猜。
enableRobotsTXT = true

# 内容目录：站点只有中文，但内容一律放在 content/zh/ 下面（后台写文章与时刻也是这个路径）。
# 这一段声明就是让 Hugo 把 content/zh/posts 映射成 /posts/ 的关键 ——
# 不写它，content/zh/ 会被当成一个叫「zh」的栏目，所有地址前面凭空多出一层 /zh/，
# 首页与归档里就看不到后台发出来的文章；将来真要加第二种语言时，
# 只需要再补一个 [languages.en] 并把 defaultContentLanguageInSubdir 改开。
[languages]
  [languages.zh]
    label = "中文"
    contentDir = "content/zh"
    weight = 1

# 分类法：主题的 layouts/taxonomy/*.html 与文章页署名都要这几项，
# 而 Hugo 不会读主题里的 [taxonomies] —— 只能在站点这份配置声明。
# 少了 author，文章页顶部的作者昵称就点不进 /author/<标识>/；
# 少了 category / tag，站里就没有 /categories/ 与 /tags/ 这两个聚合页（模板主题一直带着）。
# Hugo 只为声明过的分类法生成聚合页，不想要哪一个就把那一行注释掉。
[taxonomies]
  author = "author"
  category = "categories"
  tag = "tags"

# RSS：只保留三份 feed；其他 section / taxonomy 总览 / term 都不生成。
#   /index.xml          文章 + 时刻各前 20 条
#   /posts/index.xml    全部文章（content/zh/posts/_index.md 的 outputs）
#   /moments/index.xml  全部时刻（content/zh/moments/_index.md 的 outputs）
# 不写这一段，Hugo 的默认输出会给每个 section、taxonomy 总览和 term 都生成一份 RSS。
[outputs]
  home = ["HTML", "RSS"]
  section = ["HTML"]
  taxonomy = ["HTML"]
  term = ["HTML"]
  page = ["HTML"]

# 文章列表页 /posts/ 只出 RSS、不出 HTML：导航里已经有「归档」承担列表职责。
# 想恢复 HTML 列表页，就把 content/zh/posts/_index.md 的 outputs 改回 ["HTML", "RSS"]。

# 「将来才上线」的稿子：这里没有配置项可开。实测 Hugo 0.165.0 连 [build].future 都不认
# （hugo config 里根本不出现这一项），只有命令行 -F/--buildFuture 才会把将来日期的页面生成出来。
# 所以后台走的是另一条路：发布时间填在将来时保存成显式草稿（draft: true）并在回执里说清楚，
# 到时间后取消草稿再保存一次才上线 —— 至少不会出现「后台说发布成功、前台查无此文」。
# 想让 Hugo 自己放行将来内容，就把 Pages 的构建命令改成 hugo --gc --minify --buildFuture。

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

/**
 * 生成仓库里钉死的 Hugo 版本。
 *
 * 不钉就会漂：Pages 直连 Git 构建时用的是平台默认的那个 Hugo（想换只能设 `HUGO_VERSION`），
 * Actions 里 `hugo-version: 'latest'` 又跟着上游最新发布走。两边版本不同，就会出现
 * 「本地和 CI 都过、线上构建出来的页面对不上」，而且哪天 Hugo 改了行为你就得当场重查。
 * 这座站的模板与 `content/zh/posts/_index.md`、`content/zh/moments/_index.md` 里的
 * build / outputs 声明都在下面这个版本的 extended 构建上实测过，所以三处（Pages、两个 workflow）钉成同一个数。
 * 想升级主题/站点前先本地 `hugo version` 对齐一次，再改这一个常量重新生成。
 */
const HUGO_PIN = '0.165.0';

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
          # 与 Cloudflare Pages 的 HUGO_VERSION 保持一致（见 README「构建设置」）
          hugo-version: '${HUGO_PIN}'
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

      - name: Ensure Pages project exists
        if: steps.cf.outputs.enabled == 'true'
        # pages deploy 碰到不存在的项目会问「要不要顺手创建」，CI 里没有终端 → 直接报错退出。
        # 先单独 create 一次；项目已存在时它会失败，那份失败忽略就是（真正要成功的是下一步）。
        continue-on-error: true
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CF_API_TOKEN }}
          accountId: \${{ secrets.CF_ACCOUNT_ID }}
          command: pages project create ${a.repoName} --production-branch main

      - name: Deploy to Cloudflare Pages
        if: steps.cf.outputs.enabled == 'true'
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: \${{ secrets.CF_API_TOKEN }}
          accountId: \${{ secrets.CF_ACCOUNT_ID }}
          command: pages deploy public --project-name=${a.repoName}

      # —— 把构建结果报给自己的后端 ——
      # 为什么要这一对：后端跑在 workerd 里，起不了 hugo 子进程，所以「站点构建挂了、前台停在上一版」
      # 这件事在后台本来是看不见的（每笔保存都回「已保存」）。只有跑构建的这一侧知道结果，就让它报上来。
      # 两步都是 continue-on-error —— 回报本身出问题绝不能把站点部署带崩。
      # 没配 BUILD_REPORT_TOKEN 时后端会回 500 并写明怎么开，这一步就安静跳过。
      - name: 回报构建结果（成功）
        if: \${{ success() }}
        continue-on-error: true
        env:
          API_BASE: \${{ secrets.API_BASE_URL }}
          REPORT_TOKEN: \${{ secrets.BUILD_REPORT_TOKEN }}
        run: bash scripts/build-report.sh success ""

      - name: 回报构建结果（失败）
        if: \${{ failure() }}
        continue-on-error: true
        env:
          API_BASE: \${{ secrets.API_BASE_URL }}
          REPORT_TOKEN: \${{ secrets.BUILD_REPORT_TOKEN }}
        run: |
          # 把最后几十行日志带上去，后台那行红字才知道是哪一篇文件的问题
          hugo --minify 2>&1 | tail -40 > /tmp/hugo-failure.log || true
          bash scripts/build-report.sh failure "\$(cat /tmp/hugo-failure.log)"
`;
}

/**
 * 回报脚本：内容仓里带一份 scripts/build-report.sh（与上面那段 workflow 配对）。
 * 用 curl 调后端 POST /api/build-report —— **不带 /admin/**：`index.ts` 对 /api/admin/* 有一道统一登录闸，
 * CI 没有会话 Cookie，打到那条路只会拿到 401「请先登录」，令牌逻辑根本轮不到执行。
 */
function buildReportScript(): string {
  return `#!/usr/bin/env bash
# 把内容仓的构建结果报给自己的后端（POST /api/build-report，在管理员登录闸之外，只认令牌）。
# 由 .github/workflows/deploy.yml 在成功/失败两条路上各调一次；任何出错都不该影响部署，
# 所以全程 || true。地址优先用 Secret API_BASE_URL，没有就从站点的 params.toml 里读 apiBaseURL。
set -uo pipefail
STATUS="\${1:-success}"
DETAIL="\${2:-}"
API_BASE="\${API_BASE:-}"
if [ -z "\$API_BASE" ]; then
  API_BASE=\$(grep -h '^apiBaseURL' config/_default/params.toml themes/zero/config/_default/params.toml 2>/dev/null | head -1 | sed -E 's/.*= *"([^"]*)".*/\\1/')
fi
TOKEN="\${REPORT_TOKEN:-}"
if [ -z "\$API_BASE" ] || [ -z "\$TOKEN" ]; then
  echo "未配 API_BASE_URL / BUILD_REPORT_TOKEN，跳过构建结果回报（后端因此看不到站点是否停在旧版，不影响部署）"
  exit 0
fi
BODY=\$(printf '{"status":"%s","sha":"%s","branch":"%s","error":"%s"}' \\
  "\$STATUS" "\${GITHUB_SHA:-}" "\${GITHUB_REF_NAME:-main}" \\
  "\$(printf '%s' "\$DETAIL" | head -c 2000 | tr '\\n\\r\\t"' '    ' | tr -d '\\\\\\\\')")
# 请求体走 stdin，不塞进 curl 的参数里：Windows/Git-Bash 的 MSYS 会把「看起来像路径」的片段按系统
# ANSI 码页(GBK)转一遍，构建日志里 content/zh/posts/中文标题.md 那句到后端就成了废字节；
# Linux runner 上没这问题，但有人在本地照 CI 那行手跑，两边就该读出同一句话。顺带避开参数长度上限。
printf '%s' "\$BODY" | curl -sS -m 20 -X POST "\$\{API_BASE%/}/api/build-report" \\
  -H 'content-type: application/json' \\
  -H "x-build-report-token: \$TOKEN" \\
  --data-binary @- || echo "构建结果回报没送出去（不影响部署）"
exit 0
`;
}

/**
 * 与 functions/_middleware.ts 里那份 CSP 逐字一致（那边是静态层之外的响应、这份是静态响应用的）。
 * 两份必须一起改：改一边不改另一边，表现是「首页被拦、被关停的 404 页不拦」这种只在部分页面出现的怪事。
 */
function siteCsp(apiBase: string): string {
  const externalScripts =
    'https://cdn.jsdelivr.net https://fastly.jsdelivr.net https://gcore.jsdelivr.net https://unpkg.com https://giscus.app https://qzonestyle.gtimg.cn';
  const externalStyles = 'https://cdn.jsdelivr.net https://unpkg.com';
  let origin = '';
  try {
    const u = new URL(apiBase);
    if (u.protocol === 'http:' || u.protocol === 'https:') origin = u.origin;
  } catch {
    origin = '';
  }
  let siblings = '';
  if (origin) {
    const host = new URL(origin).hostname;
    if (host !== 'localhost' && !/^[0-9.]+$/.test(host)) {
      const apex = host.split('.').slice(-2).join('.');
      siblings = ` https://*.${apex} wss://*.${apex}`;
    }
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${externalScripts}`,
    `style-src 'self' 'unsafe-inline' ${externalStyles}`,
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${origin ? ` ${origin}${siblings}` : ' https:'}`,
    "media-src 'self' https: blob:",
    "frame-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

/**
 * Cloudflare Pages 的响应头规则，写在站点根的 static/_headers（Hugo 原样拷进产物根目录）。
 *
 * 只给「改内容就会换名字」的资源上长缓存；HTML 一律回源校验 —— 后台发了文、改了开关，
 * 访客下一跳就该看到新页面，不能让 CDN 拿着旧的顶几天（这是站长的硬口径：不许让开关晚生效）。
 * Pages 会把多条命中规则的同名头**拼接**，所以下面几条刻意互不重叠。
 *
 * 安全响应头也在这里再写一份：`_routes.json` 把文章页、首页这些静态页面放给了 Pages 的静态层
 * （不再进 Functions 中间件，省掉每个请求 ~0.4s 的函数开销），静态层只有这份 `_headers` 能补头。
 * 两份必须逐字一致（CSP 里 connect-src 的接口域是从 API_BASE 推出来的，见下面的函数）；
 * 中间件那份管「关停功能的 404」，这份管其它所有静态响应。
 */
function siteHeaders(apiBase: string): string {
  return `# 带内容指纹的样式与脚本：文件名带 hash，内容一变名字就变，可以放心存一年
/css/*
  Cache-Control: public, max-age=31536000, immutable

/js/*
  Cache-Control: public, max-age=31536000, immutable

# Hugo 的图片处理产物在 /images/<指纹>/ 下，同一张图同一个目录，同样按不可变处理
/images/*
  Cache-Control: public, max-age=31536000, immutable

# static 里的原始图片（图标、头像等）：文件名不保证唯一，给一个月。
# 代价要清楚：同名替换一张图（比如换 favicon、换头像），老访客最长一个月才看到新的；
# 急着生效就把文件改成新名字（改引用即可），或到 Cloudflare 控制台手动清这一条 URL。
/img/*
  Cache-Control: public, max-age=2678400

# 主题自带的 Font Awesome 在 /fa/ 下（css/all.min.css 与 webfonts/*）：文件名不带内容指纹，
# 升级 FA 是同名替换，同样给一个月、不给 immutable。要立刻换掉旧字体，就把 all.min.css
# 改成带 hash 的名字（或控制台清缓存）；最长一个月的图标错位是这档缓存的代价。
/fa/*
  Cache-Control: public, max-age=2678400

# RSS 三份 feed：浏览器仍然每次回源校验（新文章不能晚出现），但允许 CDN 存 5 分钟、
# 过期后先给旧的再后台刷新。订阅器每分钟轮询时不必再各打穿源站一次
# （/posts/index.xml 实测 412KB，源站直取要 300ms+）。5 分钟是上限，重建站点会立刻换掉。
/index.xml
  Cache-Control: public, max-age=0, must-revalidate, s-maxage=300, stale-while-revalidate=3600

/posts/index.xml
  Cache-Control: public, max-age=0, must-revalidate, s-maxage=300, stale-while-revalidate=3600

/moments/index.xml
  Cache-Control: public, max-age=0, must-revalidate, s-maxage=300, stale-while-revalidate=3600

# 站内搜索索引：地址带构建版本号（主题 layouts/search/list.html 输出 ?v=<构建时间>），
# 每次重建自动换成新地址，所以这份可以按不可变存一年 —— 123KB 只在第一次下载，
# 也不会因为缓存让新文章搜不到（老地址留在 CDN 不影响新构建用的新地址）。
/search/index.json
  Cache-Control: public, max-age=31536000, immutable

# 显式请求 .html 的那几个地址：始终回源校验。
# （清洁地址 /posts/x/ 的请求路径不带 .html，命中的是 Pages 自己的默认缓存口径，不归这条管；
#   也不能写成 /* —— Pages 会把命中规则的同名头拼在一起，/* 会把 max-age=0 加到上面的 css/js 上。）
/*.html
  Cache-Control: public, max-age=0, must-revalidate

# 安全响应头：必须与 functions/_middleware.ts 的 applySecurityHeaders 逐字一致
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), fullscreen=(self)
  Content-Security-Policy: ${siteCsp(apiBase)}
`;
}

/**
 * 边缘那一层只留「会变的」页面：被开关键管着的那几个前缀和站点地图。
 * 其它路径（首页、文章、归档、静态资源）全部交给 Pages 的静态层 —— 那里的响应走 CDN 缓存，
 * 比每个请求都进一次 Functions 中间件快得多；安全头由 _headers 补上。
 * 前缀两条都写：/links 与 /links/、以及 /links/index.html 这种直连写法都要继续受开关管。
 */
function siteRoutes(): string {
  const gated = ['/links', '/moments', '/subscribe', '/account', '/work', '/about'];
  const include = [...gated.flatMap((p) => [p, `${p}/*`]), '/sitemap.xml'];
  return `${JSON.stringify({ version: 1, include, exclude: [] }, null, 2)}\n`;
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
 * 文章分区页只出 RSS、不出 HTML 列表：导航里的「归档」承担列表职责。
 * render: always 让 RSS 真的生成；outputs 只留 RSS，所以没有 /posts/index.html 这个跟归档重复的页面。
 */
const POSTS_INDEX = `---
title: "文章"
type: "posts"
layout: "list"
build:
  render: always
outputs: ["RSS"]
sitemap:
  disable: true
---
`;

/**
 * 时刻不生成详情页：卡片、评论、点赞、收藏都在 /moments/ 时间线上，
 * 站内链接落到 /moments/#moment-<文件名>。
 * list=always 让每条时刻仍出现在 .Site.RegularPages 里，时间线才有数据；
 * 自己这行 build=always 不能省 —— 同一份 cascade 也会盖到声明它的这一页。
 */
const MOMENTS_INDEX = `---
title: "时刻"
type: "moments"
layout: "list"
outputs: ["HTML", "RSS"]
cascade:
  build:
    render: never
    list: always
build:
  render: always
---
`;

/**
 * 主题的每个页面都靠 `layouts/<分区>/list.html` 渲染，少了 `content/zh/<分区>/_index.md`
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

/**
 * 主题自动跟进工作流。
 *
 * 两件事各自解决一半：
 * - 子模块记的是**固定提交号**，主题仓库推了新提交，本仓库指针不动就没有 push，
 *   Pages 与 Actions 都不会重新构建 —— 这条 workflow 每天把指针推到最新并提一次交，
 *   那次推送本身就是重建的触发器；
 * - Pages 直连 Git 的构建**不会拉子模块**（Cloudflare 的行为），所以构建命令里要自己把主题取下来，
 *   见 pagesBuildCommand()。取的是主题默认分支的最新提交，所以任何一次重建都跟着最新主题走。
 *
 * 试构建 + 产物体检这两道闸门保的是「本地构建 + 用 Actions 部署的那条路」：
 * 主题写坏了（构建红、或构建绿但产物里的数据/锚点坏了）就不提交指针，本站继续用旧主题。
 */
function updateThemeWorkflow(a: Answers): string {
  return `# ============================================================
# 主题有新提交时自动跟上：每天检查一次，先把指针推到最新再提交
# ------------------------------------------------------------
# 为什么需要这条：子模块记的是固定提交号，主题仓库推了新提交，本仓库
# 指针不动就没有 push —— Pages 与 Actions 都不可能被触发。
# 流程：取主题默认分支最新提交 → 与仓库里记录的指针比 → 不一样就先本地
# 构建一次（构建不过就不提交，免得主题写坏把站点带崩）→ 通过才提交指针并推送，
# 这次推送又触发 Pages 的正常构建。
#
# 手动立刻跟一次：Actions → Update theme → Run workflow
# 注意：仓库连续 60 天没有任何提交时 GitHub 会暂停定时任务，
#       去 Actions 页面点一次 Enable workflow 即可恢复。
# ============================================================

name: Update theme

on:
  schedule:
    # UTC 21:00 = 北京时间次日 05:00
    - cron: '0 21 * * *'
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: update-theme
  cancel-in-progress: false

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - name: 检出站点仓库及其子模块
        uses: actions/checkout@v5
        with:
          submodules: true
          fetch-depth: 0

      - name: 主题有没有新提交
        id: check
        run: |
          set -euo pipefail
          git -C themes/zero fetch origin HEAD
          current=$(git rev-parse HEAD:themes/zero)
          latest=$(git -C themes/zero rev-parse FETCH_HEAD)
          echo "本站记录的主题提交: \${current:0:8}"
          echo "主题仓库最新:     \${latest:0:8}"
          if [ "$current" = "$latest" ]; then
            echo "已是最新，无需更新"
            echo "up_to_date=true" >> "$GITHUB_OUTPUT"
          else
            echo "up_to_date=false" >> "$GITHUB_OUTPUT"
            echo "new_sha=$(echo "$latest" | cut -c1-8)" >> "$GITHUB_OUTPUT"
            git -C themes/zero checkout "$latest"
            echo "已把子模块切到 \${latest:0:8}，准备试构建"
          fi

      - name: 安装 Hugo
        if: steps.check.outputs.up_to_date == 'false'
        uses: peaceiris/actions-hugo@v3
        with:
          # 与 deploy.yml、Cloudflare Pages 的 HUGO_VERSION 同一个版本：
          # 试构建用的 Hugo 比线上高或低，就可能「这里过了、Pages 红了」
          hugo-version: '${HUGO_PIN}'
          extended: true

      - name: 试构建（不过就不提交）
        if: steps.check.outputs.up_to_date == 'false'
        run: hugo --minify --destination "$RUNNER_TEMP/hugo-check"

      # 构建成功 ≠ 页面没坏。主题里那类「模板不报错、产物却坏了」的问题
      # （搜索数据里混进数字、样式退回阻塞外链、前端依赖的锚点被改名）只有查产物才看得出来。
      # 判据在主题仓库里，这里直接当升级闸门用：不过就不提交指针，本站继续用旧主题。
      - name: 产物体检（不过就不提交指针）
        if: steps.check.outputs.up_to_date == 'false'
        run: node themes/zero/scripts/check-build.mjs "$RUNNER_TEMP/hugo-check"

      - name: 提交并推送新的子模块指针
        if: steps.check.outputs.up_to_date == 'false'
        env:
          NEW_SHA: \${{ steps.check.outputs.new_sha }}
        run: |
          set -euo pipefail
          git add themes/zero
          git -c user.name="github-actions[bot]" \\
              -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \\
              commit -m "chore: 主题子模块跟到 \${NEW_SHA:-最新提交}"
          git push origin "HEAD:refs/heads/main"
          echo "已推送，Pages 会随这次提交重新构建"
`;
}

/**
 * Pages 直连 Git 的构建不拉子模块，构建命令得自己把主题取下来。
 * 主题仓库是公开的，所以这条命令不需要任何凭据；取的是默认分支最新提交。
 */
function pagesBuildCommand(a: Answers): string {
  return `rm -rf themes/zero && git clone --depth 1 ${a.themeRepo} themes/zero && hugo --minify`;
}

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
  /** 用 URL 解析而不是「主机名里得有一个点」的正则：老写法会把台架常用的
      http://localhost:9605 判成不合法，而 http://127.0.0.1:1767 反倒能过 —— 两条本是同一种东西。 */
  for (const [label, v] of [['API 地址', a.apiBaseURL], ['站点域名', a.siteUrl]] as const) {
    const bad = (): never => die(`${label}不像完整 URL：${v}\n要形如 https://zero-api.xxx.workers.dev（协议 + 域名写全，末尾不要带斜杠）`);
    let u: URL | null = null;
    try {
      u = new URL(v);
    } catch {
      bad();
    }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) bad();
    /** 只到域名/端口为止：带路径的地址会让主题拼出来的绝对链接错位，比报这一条更难查 */
    else if (u.pathname !== '/' && u.pathname !== '')
      die(`${label}只填到域名（或域名 + 端口），末尾不要带路径：${v}\n例如 https://zero-api.xxx.workers.dev`);
  }

  /** 仓库名直接变成生成目录的名字：带分隔符、`.`/`..` 或 Windows 非法字符的 --repo
      会把整座站写到 zero-stack 同级之外去，所以这里先按「一个目录名」的要求拦下来。 */
  const repo = a.repoName.trim();
  if (!repo) die('仓库名不能为空');
  if (repo === '.' || repo === '..' || /[/\\]/.test(repo) || /[<>:"|?*\s]/.test(repo))
    die(`仓库名得是一个单纯的目录名：不能带 / \\ 、空格、. 或 ..，也不能含 <>:"|?*：${a.repoName}`);
  a.repoName = repo;

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
  /** 内容一律在 content/zh/ 下：hugo.toml 里 [languages.zh] contentDir 认的就是这一层，
      后台 githubPostsDir / githubMomentsDir 的默认值也按它写 */
  const dirs = ['content/zh/posts', 'content/zh/moments', 'content/zh/links', 'content/zh/search', 'static/images', 'data', '.github/workflows'];
  for (const [dir] of SECTIONS) dirs.push(`content/zh/${dir}`);
  for (const d of dirs) mkdirSync(resolve(siteDir, d), { recursive: true });
  info(siteDir);

  const rel = (p: string) => resolve(siteDir, p);
  write(rel('hugo.toml'), hugoToml(a));
  write(rel('content/zh/posts/hello-world.md'), SAMPLE_POST);
  write(rel('content/zh/moments/first-moment.md'), SAMPLE_MOMENT);
  write(rel('data/links.yaml'), LINKS_DATA);
  write(rel('content/zh/links/_index.md'), LINKS_INDEX);
  for (const [dir, title] of SECTIONS) write(rel(`content/zh/${dir}/_index.md`), sectionIndex(dir, title));
  // 个人中心：主题在 layouts/account/me/list.html 渲染它，少了这份内容页 /account/me/ 就是 404，
  // 而前端登录成功后普通用户正是跳这里
  write(rel('content/zh/account/me/_index.md'), '---\ntitle: "个人中心"\ntype: "account"\nlayout: "me"\n---\n');
  /* 站内搜索：索引在构建期生成到 /search/index.json（主题 layouts/search/list.json），
     HTML 与 JSON 两种输出都要在这里声明；导航里的「搜索」由主题在检测到这一页时自动补。 */
  write(rel('content/zh/search/_index.md'), '---\ntitle: "搜索"\noutputs: ["HTML", "JSON"]\nrobots: "noindex, follow"\n---\n');
  write(rel('static/images/.gitkeep'), '');
  const apiBase = (a.apiBaseURL ?? '').trim().replace(/\/+$/, '');
  /** 缓存规则与安全响应头：生成时就带上，省得站长发第一个月才发现 CDN 把 CSS 存了三天、改名后还在吐旧的 */
  write(rel('static/_headers'), siteHeaders(apiBase));
  /**
   * 边缘 404 中间件：后台把某个功能关掉时，那个页面直接 404 且带 noindex（旧链接与搜索引擎都拦掉）。
   * 只有配了后端才有意义（开关在 /api/config 里），纯静态站不生成这个文件。
   * 配套的 _routes.json 只把「归开关管的页面 + 站点地图」交给 Functions，其余（首页、文章、静态资源）
   * 走 Pages 静态层 —— 每个请求少一次函数调用的耗时；安全头由上面的 _headers 补。
   */
  if (apiBase) {
    write(rel('functions/_middleware.ts'), switchGuard(apiBase));
    write(rel('static/_routes.json'), siteRoutes());
  }
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
  write(rel('.github/workflows/update-theme.yml'), updateThemeWorkflow(a));
  /* 构建结果回报脚本：deploy.yml 的成功/失败两步都用 `bash scripts/build-report.sh` 调，
     所以不需要执行位（Windows 上 chmod 也基本无效）。 */
  write(rel('scripts/build-report.sh'), buildReportScript());
  write(rel('README.md'), `# ${a.siteName}

私密内容仓库：文章 Markdown + 站点配置。主题以 git submodule 形式位于 \`themes/zero\`。

- 主题仓库：${a.themeRepo}
- 后端地址：${a.apiBaseURL}
- 部署：Cloudflare Pages（见 \`.github/workflows/deploy.yml\`）
- 主题自动跟进：\`.github/workflows/update-theme.yml\`（每天检查主题新提交，试构建过了才提交指针）

## Cloudflare Pages 的构建设置（直连 Git 时必须照抄这一条）

Pages 自己 clone 仓库构建时**不会拉子模块**，\`themes/zero\` 会是空目录，产物就没有样式。
控制台 → Pages → 本项目 → Settings → Builds → Configurations → Production build commands：

\`\`\`bash
Build command: ${pagesBuildCommand(a)}
\`\`\`

同一页往下翻到 **Build environment & advanced settings → Environment variables**，加一条：

\`\`\`text
HUGO_VERSION = ${HUGO_PIN}
\`\`\`

不设它就用 Pages 平台默认的 Hugo（会随平台漂移，而且默认那个不一定带 +extended）。
本仓库的模板与 \`content/zh/posts|moments/_index.md\` 的 outputs / build 声明、\`[languages.zh] contentDir\` 都在 ${HUGO_PIN} extended 上验过，
\`.github/workflows/\` 两个文件里钉的是同一个版本 —— 三处对齐，才不会出现「本地和 Actions 都过、Pages 构建出来的不一样」。

这样每次构建都直接取主题默认分支的最新提交（主题仓库是公开的，不需要凭据）。
想固定在某一个主题版本，把 \`--depth 1\` 后面加上 \`-b <标签或分支>\`，或干脆钉住提交号：
\`git -C themes/zero fetch --depth 1 ${a.themeRepo} <那个提交号> && git -C themes/zero checkout FETCH_HEAD\`。

## 需要的 GitHub Secrets（只有让 Actions 负责发布时才需要）

| 名称 | 说明 |
|---|---|
| \`CF_API_TOKEN\` | Cloudflare API Token，需 Pages 编辑权限 |
| \`CF_ACCOUNT_ID\` | Cloudflare 账户 ID |

站点若走 **Cloudflare Pages 直连 Git 构建**（照上一节配好 Build command 就是这条路），这两个 secret 不用配：
push 本身就是构建触发器，\`deploy.yml\` 检测不到 secret 时只做构建、不发布。

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
    const detail = e instanceof Error ? e.message : String(e);
    /* 以前这里只警告然后继续，生成一座没有 exampleSite、params 也不完整的「最小骨架」，
       还让用户「初始化子模块后重跑 create:site」—— 而脚本下一轮会因为目录已存在直接拒绝。
       半成品比明确失败更难查，所以这里清掉本次新生成的目录，把真实 Git 错误交给用户。 */
    try {
      rmSync(siteDir, { recursive: true, force: true });
    } catch {
      /* Windows 上目录被占用时清不掉；至少把路径与后续动作说清楚 */
    }
    die(
      `主题子模块没拉下来，本次生成已中止：${detail}
` +
        `  请确认主题仓库地址可访问（${a.themeRepo}）、网络/凭据正常，然后重跑同一条命令。
` +
        (existsSync(siteDir) ? `  目录 ${siteDir} 仍有残留，请先手动清理（确认没有 hugo 进程占用）。` : ''),
    );
  }

  const imported = importExampleSite(siteDir);
  if (imported > 0) {
    /** 演示站自带 posts / moments 的样例，生成器那两份占位就撤掉，免得混成五篇 */
    for (const leftover of ['content/zh/posts/hello-world.md', 'content/zh/moments/first-moment.md']) {
      const p = resolve(siteDir, leftover);
      if (existsSync(p)) rmSync(p);
    }
    good(`已按主题演示站填入示例内容与示例数据（${imported} 个文件）`);
    const filled = backfillExampleData(siteDir, a);
    if (filled > 0) good(`示例数据里的占位值已换成这座站的（${filled} 个文件：站点名 / 域名 / 备案与服务图标 / 友链申请信息）`);
  } else {
    warn('没读到 themes/zero/exampleSite（子模块还没拉下来？）：这座站只有最小骨架，初始化子模块后重跑一次 create:site 才有完整示例');
  }

  /** 分区页是 Hugo 由目录自动造的，没有「只禁一个分区 / 只改输出」的开关，
      所以 posts / moments 各写一份 _index.md：posts 只出 /posts/index.xml，
      moments 关掉详情页但保留时间线数据。两份都放在示例站导入之后写，
      保证站点内容与模板的约定一致（示例站那份是同一份配置）。 */
  write(rel('content/zh/posts/_index.md'), POSTS_INDEX);
  write(rel('content/zh/moments/_index.md'), MOMENTS_INDEX);
  /** 落地页（主题的 layouts/index.html）：只作入口，进去按回车到 /home/。
      不能是可索引的主页：noindex + 不进 sitemap，免得搜索引擎把空壳落地页当成首页。
      标题用站点自己的名字 —— 示例站那份写的是「Example Site」，不该出现在新站。 */
  write(
    rel('content/zh/_index.md'),
    `---\ntitle: ${JSON.stringify(a.siteName)}\nrobots: "noindex, follow"\nsitemap:\n  disable: true\n---\n`,
  );

  /**
   * 跳转规则出厂只有注释，原因有两层：
   * · 新站这些路径都归 Hugo 自己出，/posts/ 不出 HTML 页是上面刻意做的，放开就是改行为；
   * · 但「换域名以后旧地址要 301」「某个分区下线了要指到替身页」这两件事，
   *   只有手写过一次的人知道 Pages 读的是 static/_redirects —— 后台改站点地址会连带改
   *   hugo.toml / site.json / apply.json 三处，唯独不会生成这份，所以这里先摆个样子。
   *   整个文件都是注释时 Pages 一条规则都不加，本地 hugo server 也根本不读它。
   */
  write(
    rel('static/_redirects'),
    '# Cloudflare Pages 的跳转规则（本地 hugo server 不读这个文件）。出厂一条都没启用，照着放开即可。\n' +
      '# 规则按「先匹配先生效」排队：具体的那条要排在通配之前。\n' +
      '\n' +
      '# ① 换过域名、旧站是子目录结构时，把旧地址 301 到新站同路径\n' +
      '# /zh/*       /:splat        301\n' +
      '# /zh         /              301\n' +
      '\n' +
      '# ② 关掉某个分区后，把老地址指到替身页。\n' +
      '#    带斜杠与不带斜杠是两条精确串，只写一条时手打缺斜杠的那位会直接吃 404。\n' +
      '# /posts/     /archive/      301\n' +
      '# /posts      /archive/      301\n',
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
  todo('（只有走 Actions 部署才需要）给 Actions 两个 secret：仓库 Settings → Secrets and variables → Actions → New repository secret');
  note('CF_API_TOKEN（要有 Pages 编辑权限的 API Token）、CF_ACCOUNT_ID（Cloudflare 控制台首页右侧那串）');
  note('站点如果用 Cloudflare Pages 的「直连 Git 构建」（下面第 4 步那条 Build command 配好了就是这条路），这两个 secret 不用配：');
  note('deploy.yml 检测不到它们就只做构建、不发布，push 本身已经触发 Pages 重建');
  todo(`推 main 会触发首次构建；Pages 项目 ${a.repoName} 由 workflow 自动创建，自定义域名到 Cloudflare Pages → 该项目 → Custom domains 里绑`);
  note('⚠ Pages 若是「直连 Git 构建」，一定要把 Build command 换成下面这条 —— Pages 不拉子模块，照默认 hugo 构建出来的页面没有样式：');
  note(pagesBuildCommand(a));
  note(`⚠ 同一页的 Environment variables 里再加一条 HUGO_VERSION = ${HUGO_PIN}（生成的两个 workflow 钉的就是这个版本；不设就用 Pages 平台默认那个，三处版本不一致时线上产物会和你本地看到的对不上）`);
  note(`本机先看一眼效果：cd ${siteDir} && git submodule update --init --recursive && hugo server -D`);
  todo('让后台写得进这座仓库');
  note(`· zero-stack 的 packages/api/wrangler.jsonc 里 ALLOWED_ORIGINS 加上 ${a.siteUrl}，然后 pnpm deploy:api（不加就是后台一请求就被 CORS 拒掉）`);
  note(`· 后台「设置 → 内容仓库」填 owner=${a.githubUser} / repo=${a.repoName}，并存一个有 contents:write 的 token（密钥只进 worker secret，不进仓库）`);
  note(`· 主题侧的接口地址已经写在生成好的 config/_default/params.toml 里（apiBaseURL = ${a.apiBaseURL}），不用再改`);
  todo('（建议）把「站点构建失败」回报到后台：生成好的 deploy.yml 已经带了两步回报，缺的是两边同名的令牌');
  note('自己在终端生成一串随机值，下面两条命令都粘同一串：');
  note('TOKEN=$(openssl rand -hex 24)');
  note(`cd zero-stack/packages/api && npx wrangler secret put BUILD_REPORT_TOKEN   # 粘贴同一串`);
  note(`gh secret set BUILD_REPORT_TOKEN --repo ${a.githubUser}/${a.repoName}      # 内容仓的 Actions Secrets，也粘贴同一串`);
  note('（API 地址脚本会从 params.toml 的 apiBaseURL 读，不用另配；不配令牌功能一切正常，只是后台看不到「Pages 构建挂了、前台停在旧版」）');
}

/** 只有直接被执行时才跑生成流程；被 import（比如建仓那步的验证脚本）时不能顺带把站生成一遍 */
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e: unknown) => {
    die(e instanceof Error ? e.message : String(e));
  });
}
