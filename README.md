# zero-stack

Hugo 主题之外的**全套动态后端**：评论、点赞 / 收藏、邮件订阅与群发、时刻（朋友圈式动态）、
友链与站点联盟、访问统计、多作者与投稿审核、AI 翻译、备份恢复，以及一个 18 页的管理后台。
整包跑在 Cloudflare 免费档上（Workers + D1 + R2 + KV + Queues + Cron + Pages），
内容仍然留在你自己的 Git 仓库里，由 Hugo 构建成静态页面。

配合使用的前置仓库：

| 仓库 | 关系 |
| --- | --- |
| **zero-theme** | Hugo 主题。读 `params.apiBaseURL` 调用本仓库的接口；后台「前端管理」写回的 `data/*.json` 也在主题那一侧被读取 |
| **zero-site** | 你的内容仓库（文章 / 时刻 Markdown、`data/`、站点配置）。后台提交回这里，再由 Pages / GitHub Actions 触发 Hugo 构建 |

## 它做得到什么

- **评论区自建**：六级嵌套、游客可评（可选需审核）、Markdown + 表情库、图片头像自动退化、
  按设备与账号点赞、举报与Owner 删除、待审队列与正则广告拦截，随时可切回 Waline / Giscus / Twikoo / Artalk。
- **点赞与收藏**：空心 → 实心动画一致，计数按目标聚合，游客按指纹去重，登录用户可在个人中心撤回。
- **邮件订阅**：双重确认、新文章推送、群发任务（分批 + 断点续发 + 每日上限），四种模板可视化预览。
- **时刻页**：卡片模式混合时间线（Git 里的 Markdown + D1 里的动态），地点 / 音乐 / 图片 / 音视频，评论按需展开。
- **友链**：在线申请 → 后台通过 → 同时写进 D1 与 `data/links.yaml`，自动存活检测、
  30 天不可访问或 90 天无动态自动进「迷失的小船」，RSS 聚合出「朋友动态」。
- **统计**：按 IP 去重的 PV / UV、累计访客、热门页面、来源与设备；每篇的阅读 / 评论 / 点赞 / 收藏
  可一键导出成站点的 `data/poststats.json`（构建期给首页精选与「最热」排序用，不是 CSV）。
- **后台**：文章结构化编辑（含短代码面板、封面从媒体库选、本地暂存 + 批量保存到 Git）、
  媒体多桶上传、评论 / 投稿 / 认证 / 注销四类审核、用户组与权限、邀请码、站点设置、
  前端管理（导航 / 首页 / 页脚 / 关于 / 工坊 / 时刻 / 友链申请 / SEO 九个子页写进 `data/*.json`）、
  整篇 AI 翻译、一键备份恢复、我的信息与登录方式。
- **账号体系**：邮箱 + 密码注册（可需邀请码）、邮箱验证码（只用于验证邮箱）、
  身份验证器两步验证（用户自己开关，默认开）、GitHub 登录 / 绑定、
  用户中心 `/account/me/?u=@标识` 七个面板，管理员登录方式独立可配。

## 三包结构

| 包 | 说明 | 技术栈 |
| --- | --- | --- |
| `packages/api` | `zero-api`：公开接口 + 后台接口 + Cron + 邮件队列消费者 | Hono 4、Drizzle ORM、Cloudflare D1 / R2 / KV / Queues、Zod |
| `packages/cms` | `zero-cms`：管理后台 | SvelteKit 2、Svelte 5 runes、Cloudflare Pages、纯 CSS 变量主题 |
| `packages/comment` | `zero-comment`：给 Hugo 页面用的自定义元素（评论 / 点赞 / 订阅 / 时刻） | Svelte 5、Vite lib 模式，产物是单个 ES 模块 |

```
浏览器 ──► Hugo 静态页（zero-site + zero-theme）
             │  params.apiBaseURL
             ▼
       zero-api（Workers）──► D1（用户/评论/统计/配置…）
             │               R2（媒体）  KV（热点缓存 / 会话 / 限流）
             │               Queue（出站邮件）  Cron（每天 02:00 UTC）
             ▼
       GitHub Contents API ──► zero-site（文章、时刻、作者表、data/links.yaml）
             │
             └─ Pages 构建 Hook ──► 重新构建静态站

运营者 ──► zero-cms（Pages）──► 同一套 zero-api（Cookie 会话，HttpOnly）
```

## 数据落在哪里

- **D1（23 张表）**：`users` `sessions` `accounts` `verifications`（账号与登录）、
  `comments` `commenters` `comment_likes` `account_deletions`（评论与注销）、
  `reactions`（点赞 / 收藏）、`subscribers` `email_logs` `broadcast_jobs`（订阅与发信）、
  `friends` `friend_posts` `friend_applications`（友链、抓到的动态、申请）、
  `visits` `visitor_keys`（访问统计）、`site_config`（后台设置的配置键）、
  `job_runs`（定时任务记录）、`invite_codes`（邀请码）、
  `post_drafts` `author_requests`（投稿与作者认证）、`audit_logs`（操作审计）。
- **R2**：后台上传的媒体对象，多桶配置，可挂自定义域名直链。`pnpm setup` 建两个桶 —— 私有的 `zero-media`（只有 Worker 读得到）与公开的 `zero-media-public`；
  公开桶填了 Zone ID（域名的 DNS 就在当前账户）就自动绑好自定义域名并把这条桶追加进 `mediaBuckets`，
  没填或绑不上就只打印该做的事，绝不把还没生效的域名写进配置。两个桶都已存在时只跳过，不动里面的文件。
- **KV**：`CACHE` 存只读热点（文章列表等），`SESSION` 存会话与敏感口的滑动限流计数；
  前台每个页面都会打的那几条（统计埋点、点赞收藏、订阅状态）限流计数记在 Worker 的 isolate 内存里，不写 KV。
- **Queue**：`zero-email` 异步出站邮件，最多重试 3 次。
- **Git**：文章与时刻 Markdown、作者表 `data/authors.yaml`、友链数据 `data/links.yaml`、
  前端参数 `data/*.json` —— 后台写的都是这些文件，静态站点仍由 Hugo 构建。

## 环境要求

| 依赖 | 版本 | 校验 |
| --- | --- | --- |
| Node.js | ≥ 22（wrangler 4.149+ 的要求，仓库 `engines` 已锁） | `node -v` |
| pnpm | ≥ 11（workspace 协议必需，npm / yarn 装不上；`pnpm-workspace.yaml` 里的 `allowBuilds` 按这一版写） | `pnpm -v` |
| Hugo | extended，本地已验证 0.165.0；主题 `min_version = 0.128.0`。Pages 上要在环境变量里钉 `HUGO_VERSION`，否则用平台默认那个 | `hugo version` 必须带 `+extended` |
| wrangler | 由依赖提供（`pnpm dlx wrangler` 也可） | `pnpm exec wrangler -v` |
| Cloudflare 账号 | 免费档即可：D1 / R2 / KV / Queues / Pages / Cron | — |

---

# 一、本地完整跑通

下面这套顺序是本项目日常开发用的，四步都跑通就说明「线上部署后一定也能跑」——
本地与线上唯一的差别是仓库回写走目录还是走 GitHub，以及构建由谁触发（见第 5 小节）。

### 1. 安装依赖

```bash
pnpm install
cp packages/api/wrangler.jsonc.example packages/api/wrangler.jsonc
```

`wrangler.jsonc` 与 `.dev.vars` 都被 gitignore。仓库只带 `packages/api/wrangler.jsonc.example` 这一份模板，
**`.dev.vars` 没有 `.example`** —— 按下一节的键名自己建一个（`AUTH_SECRET` / `SESSION_SECRET` 两条必须有，
其余按功能选填）。
本地要改的一般只有 `name`（避免和线上 worker 撞名）与 `vars.SITE_URL`。

**先分清两件事**：`wrangler.jsonc` 这个文件**不存在**时才报 `No configuration file found. Create a wrangler.jsonc file`；
`cp` 之后四个占位一个都不改，`pnpm db:migrate:local` 是**过得去的**（`wrangler dev --local` 不校验这些值的格式，
本地建库靠 `database_name: zero-db` 认）。不改占位真正坑人的是下一步：接口照样 `Ready on http://127.0.0.1:8787`，
但 D1 是一个空的本地库、`.dev.vars` 还没建，于是每个后台口都回 500 —— 原因（`no such table: site_config`）
只在 workerd 日志里，界面上只剩一句「服务内部异常」。所以顺序是 **cp → 建 `.dev.vars` → 改下面这四个占位 → 跑迁移**
（`pnpm setup` 也能把占位填上，但它会真的去 Cloudflare 建 D1/KV/R2/Queue，本地开发不该跑它）。
现在漏跑迁移时 `/api/health` 与错误回包会直接点出「表结构比代码旧，先 `pnpm db:migrate:local`」，不用再去翻日志。

本地填法（这四个值 `wrangler dev --local` 都不校验格式，能过 JSON 即可）：

| 位置 | 本地填什么 |
| --- | --- |
| `"database_id"` | 随便一个合法 UUID，本地库靠 `database_name: zero-db` 认，不看这个 id |
| `CACHE` / `SESSION` 两个 KV 的 `"id"` | 各编一个 ID 串即可（如 `local-cache`、`local-session`） |
| `vars.SITE_URL` | 本地前台地址，与 hugo server 对齐，如 `http://127.0.0.1:1317` |
| `vars.ALLOWED_ORIGINS` | 本地后台 + 本地前台两个源，如 `http://127.0.0.1:5173,http://127.0.0.1:1317`；漏了就是浏览器里一片 CORS 红 |

`vars.ENVIRONMENT` 本地想标出来就写 `development`。**它不只进 `/api/health` 的回包（`environment` 字段）**：
接口出错时只有它等于 `development` 才把原始错误文本写进回包，其它值统一回「服务内部异常 + trace」
（见 `src/index.ts` 的 onError）—— 模板自带的 `wrangler.jsonc` 因此**不写这一项**，照原样 deploy 不会把内部错误念给人听。
它同样不参与 CORS 判断 —— 那一层是按请求 host 是不是环回地址定的（见 `src/index.ts` 里那句注释），
所以本地那份 `ALLOWED_ORIGINS` 留空也能跨端口用；写成两个本地源只是让口径显式，不是必须。

### 2. 起 API 并建库

```bash
pnpm dev:api                 # http://127.0.0.1:8787
pnpm db:migrate:local        # 在另一个终端执行，应用 migrations/0000…0014（15 个文件）
```

8787 被占用时想换个端口：`pnpm dev:api --port 8790`（实测参数直接传到 wrangler，启动行就是 8790）。
两个细节：① 别写成 `pnpm dev:api -- --port 8790` —— 中间那个 `--` 会原样带给 wrangler，
它的解析在 `--` 处停下、把端口当成位置参数忽略掉，于是又退回 8787；
② 以启动行 `Ready on http://127.0.0.1:<端口>` 为准 —— 端口被占而参数没生效时，
wrangler 会静默换一个随机端口，只有这一行说真话。

迁移必须在 `packages/api` 目录下由 wrangler 执行（`pnpm db:migrate:local` 已经帮你切好目录，
在仓库根直接 `npx wrangler d1 execute` 会报 `Couldn't find a D1 DB with the name 'zero-db'`）。

### 3. 起后台

```bash
pnpm dev:cms                 # http://127.0.0.1:5173，/api 由 vite 代理到 8787
```

后台登录页的 API 地址留空即可（同源代理，Cookie 不会被浏览器当成跨站丢掉）。

代理目标默认是 8787；自己的台架把 API 起了在别的端口时，用环境变量指过去（不设时行为不变）：

```powershell
$env:VITE_API_PROXY = "http://127.0.0.1:8790"; pnpm dev:cms     # PowerShell
```

```bash
VITE_API_PROXY=http://127.0.0.1:8790 pnpm dev:cms               # bash
```

**第一个注册的账号自动成为 `admin`**，之后注册的都只能是普通用户。想重来就把
`packages/api/.wrangler/state` 删掉再跑一次第 2 步（`.wrangler/tmp` 是 workerd 二进制缓存，别删）。

### 4. 起站点（Hugo 侧）

在 `zero-site` 目录里：

```bash
hugo server --disableFastRender --port 1315 --bind 127.0.0.1
```

- **不要加 `-D`**：`-D`（`--buildDrafts`）会让 `draft: true` 的文章在本地前台完全可见，
  而线上跑的是 `hugo --minify`，草稿一条都不会出现。要预览草稿临时加 `-D`，看完换回来。
- `--disableFastRender` 不是可选项：Fast Render 只重渲染它已经认识的页面，
  后台新发的文章要重启才看得见；也别用 `--renderToMemory`，删掉的页面会继续留在内存缓存里能打开。
- 主题改了要重新同步进 `themes/zero` 并**重启 hugo**：同步是整目录替换，
  跑着的服务会留着旧的 shortcode 注册表，轻则 500，重则直接退出。

### 5. 两个本地替身（`repo:bridge` 是**必选**，不是可选）

```bash
pnpm repo:bridge       # 127.0.0.1:8792：把后台的 Git 写入落到本地站点目录
pnpm mock:translate    # 127.0.0.1:8791：假的翻译服务，用来验证整篇翻译链路
```

**本地只要发文、改时刻、改前端管理那九段、改作者表或友链文件，就必须把 `repo:bridge` 起着**，
并在 `packages/api/.dev.vars` 里**同时**设这两条、指向同一个目录：

```toml
GIT_LOCAL_DIR  = "E:/…/zero-site"        # 站点目录（桥接进程往这里写）
GIT_LOCAL_HTTP = "http://127.0.0.1:8792" # 桥接进程地址（Worker 通过它写）
```

只设 `GIT_LOCAL_DIR` 时，Worker 里那次 `node:fs` 调用会报：

```
[unenv] fs.readFile is not implemented yet!
```

这句人话是：**workerd 里没有真实文件系统**（`wrangler dev` 跑的是浏览器化的隔离环境，
`node:fs` 只是个空壳），所以文件读写必须由 `repo:bridge` 这个 Node 进程代做。
它最坑的地方是**失败完全静默** —— 后台显示保存成功、`git status` 干干净净、什么都没写进去，
而备份导出里凡是走仓库的那几区（文章 / 时刻 / 前端设置 / 友链 / 作者）全是 0。
桥接进程本身在目录不存在时会直接拒绝启动并把它算出来的路径打给你看，
想指向别处就显式给 `LOCAL_REPO_DIR=<站点绝对路径>`（默认值是按仓库位置猜的，猜错很危险）。

桥还顺带负责**构建体检**：本地每次写内容（文章、时刻、`data/*.json`、`params.toml`）保存完之后，
Worker 让桥在站点目录里真跑一次 `hugo --minify -d .zero-doctor`，把退出码和 `ERROR` 行带回回执。
这一条把的是「后台说保存成功、站点却停在上一版」——写进仓库和构建得出页面是两件事，
而 workerd 里起不了子进程，只有桥跑得动 hugo。所以本地要保证：

- 桥的进程能找得到 hugo：不在 PATH 里就给它 `HUGO_BIN=<hugo 可执行文件绝对路径>`；
- 不想每次保存都等一轮构建（站点大了比较明显），起桥时加 `REPO_BRIDGE_DOCTOR=off`，
  回执里的体检会变成 `buildHealth.ran=false` 并写明是被关掉的，**不会**报成构建失败；
- 线上没有这一步（`GIT_LOCAL_HTTP` 不该设），构建成败在 Cloudflare Pages / GitHub Actions 那侧看，
  接口回包里这个字段就是 `null`，后台也不会因此多出提示。

后台「文章」页在体检失败时会挂一条常驻红字，点名到那个文件与那一行 `ERROR`，
按它改完再保存一次就消失；最常见的就是 `date` 写成 Hugo 认不了的样子（见下文「自己写脚本调这些接口时要知道的四件事」第 2 条）。

`GIT_LOCAL_DIR` 只在本机用，线上**不要**设。同一件事在线上的路径是
「fine-grained PAT（`Contents: write`）提交 → Pages 构建 Hook 重建」，
代码里两条路径都在 `packages/api/src/services/repo.ts`，行为一致。

### 6. 冒烟测试（匿名 37 项 + 3 跳过；带 Cookie 97 项）

```bash
pnpm smoke                                               # 同上，只是包一层
bash scripts/smoke.sh                                   # 公开接口 + 「未登录必须 401」守卫
ADMIN_COOKIE='zero_session=…' bash scripts/smoke.sh     # 追加后台接口
```

`ADMIN_COOKIE` 从浏览器登录后台后复制。匿名那一档不写库、不删数据，
匿名评论那条结尾自己用 `ownerKey` 删掉；给了 Cookie 会先建一篇临时文章
（点赞与收藏要核对文章在站上真的存在），跑完删掉。全绿输出是
`通过 37 / 失败 0 / 跳过 3`（匿名）与 `通过 97 / 失败 0 / 跳过 0`（带 Cookie）。
「跳过」是这条需要脚本当前拿不到的条件（比如没 Cookie 就建不出文章、
匿名读不到后台的 `avatarTemplate`），既不算通过也不算失败 —— 汇总里会逐条写明原因。

### 7. 部署后核验（只读，约 10 秒）

```bash
API=https://<worker 域名> CMS=https://<后台域名> SITE=https://<站点域名> pnpm postdeploy
```

只发 GET、不写任何数据：健康检查与迁移、「媒体库里登记的 R2 绑定是否都还在」
（`wrangler deploy` 会用本地 `wrangler.jsonc` 整体覆盖远端，控制台手加的绑定被抹掉时这一项会红）、
后台未登录必须 401、批量口 300/150 条不 500 且回包条目数对得上、公开配置不带密钥、
友链里没有 `javascript:`、后台 CSP 只有一份、站点首页在线且 HTML 不做长缓存。
任一项不符退出码 1，可以直接接在 `wrangler deploy` 后面跑。

### 8. 端口一览

| 端口 | 谁 | 说明 |
| --- | --- | --- |
| 8787 | zero-api | `wrangler dev` |
| 5173 | zero-cms | `vite dev`，`/api` 同源代理 |
| 1315 | 你的站点 | `hugo server`（本项目约定端口） |
| 8792 | 仓库回写替身 | `pnpm repo:bridge` |
| 8791 | 翻译替身 | `pnpm mock:translate` |

---

# 二、部署到 Cloudflare

## 用向导一次搞定

```bash
pnpm setup                     # 交互式：登录检查 → 建 / 复用 D1、私有+公开两个 R2、KV、Queue → 绑公开桶域名 → 渲染 wrangler.jsonc
                               #           前台 / 后台 / API 三个地址默认取现有配置，直接回车就是不改
                               #           → 应用远程迁移 → 把站点与发信配置写进 D1 → 部署 Worker → 写密钥 → 构建并部署后台
                               #           固定 9 问；选 SMTP 再追 4 问、勾「回 Git」再追 4 问（共 17 问），另加 2 道确认
pnpm setup -- --no-deploy      # 只建资源、跑迁移、写配置：不部署也不写密钥（secret put 的对象必须先是个已存在的 worker）
```

向导只通过 stdin 写密钥，不会把值拼进命令行，也不会写进任何文件。
重跑会重新生成 `AUTH_SECRET` / `SESSION_SECRET`，已登录的会话失效（评论者不受影响）。

## 手工分步（想知道向导在干什么，或要改域名时）

1. **建资源**

   ```bash
   pnpm exec wrangler d1 create zero-db
   pnpm exec wrangler r2 bucket create zero-media
   pnpm exec wrangler kv namespace create CACHE
   pnpm exec wrangler kv namespace create SESSION
   pnpm exec wrangler queues create zero-email
   ```

   把返回的 `database_id` 与两个 KV `id` 填进 `packages/api/wrangler.jsonc`。

2. **密钥**

   | Secret | 必需 | 来源与说明 |
   | --- | --- | --- |
   | `AUTH_SECRET` | 是 | 随机串，邮箱验证码等一次性令牌签名 |
   | `SESSION_SECRET` | 是 | 随机串，会话令牌签名；**也是验证器密钥的加密主密钥**，换库要一起换 |
   | `SMTP_PASSWORD` | SMTP 通道 | 服务商授权码 / 应用专用密码 |
   | `RESEND_API_KEY` | Resend 通道 | `re_…` |
   | `CF_ACCOUNT_ID` / `CF_EMAIL_API_TOKEN` | Cloudflare 邮件通道 | Email Sending 的账号与令牌 |
   | `GITHUB_TOKEN` | 要后台发文就要 | fine-grained PAT，权限 `Contents: write`，只给 `zero-site` 那一个仓库 |
   | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | 可选 | GitHub 登录与账号绑定；不配时入口直接回「未配置」，别的功能不受影响 |

   ```bash
   cd packages/api && pnpm exec wrangler secret put SESSION_SECRET   # 其余同理
   ```

3. **跨域与站点地址**：`wrangler.jsonc` 的 `vars` 里

   ```jsonc
   "SITE_URL": "https://你的站点域名",
   "ALLOWED_ORIGINS": "https://你的站点域名,https://zero-cms.pages.dev"
   ```

   前台与后台的 origin 都要列进来，否则后台会一直 401（Cookie 被浏览器当成跨站丢掉了）。

4. **部署 API**：`pnpm deploy:api`（会先同步迁移；`-- --no-migrate` / `-- --dry-run` 可选）。
   想要稳定域名给主题填 `apiBaseURL`，在 Workers 设置里绑一个自定义域名或用
   `routes`，比 `*.workers.dev` 在国内更可达。

5. **部署后台**：`pnpm deploy:cms` → Cloudflare Pages 项目 `zero-cms`。
   过程中会问一次「后台要连的 API 地址」，填了就编进产物（并记在 `packages/cms/.zero-api-base`，
   下次自动沿用），打开后台直接就能注册，不用再在登录页手填；`-- --api <地址>` 可跳过提问。
   后台是纯 SPA（`adapter-cloudflare` + `ssr = false`），路由回退已配好，直接访问子路径不会 404。

6. **Cron 与队列消费者**：`wrangler.jsonc` 里 `triggers.crons = ["0 2 * * *"]`、
   `queues.consumers` 指向 `zero-email`。`pnpm deploy:api` 会一起生效，
   作用是：友链存活检测与 RSS 抓取、订阅推送比对 RSS、失联判定、过期任务清理、邮件重发。

7. **内容仓库**：`pnpm create:site` 生成私密的 `zero-site`（目录结构、CI、`.gitignore`、
   主题 submodule 引用都写好了；本地生成与提交，不会替你 push）。
   然后在后台「设置 → 内容仓库」填 `owner / repo / branch / 各目录 / 友链文件 / Pages 重建 Hook`。

8. **GitHub Actions 部署**：`docs/deploy-template.yml` 是 **zero-stack 自己**（接口 + 后台）的流水线模板 ——
   它跑的是 `pnpm install` → `packages/api` 里应用 D1 远端迁移 → 部署 Worker → 部署 `zero-cms` Pages，
   所以放在**这套代码的仓库**里用。内容仓 `zero-site` 不用它：`pnpm create:site` 已经给那一侧生成了
   `.github/workflows/deploy.yml`（`hugo --minify` + `pages deploy public`，检测不到 CF 凭据时只构建不发布），
   把这份模板复制进内容仓只会第一跑就报 `缺少 packages/api/wrangler.jsonc`（那边压根没有 `packages/`）。

## 站点侧的接口地址（`create:site` 已经替你写好）

`pnpm create:site` 把「API 地址」那一答直接写进生成仓库的 `config/_default/params.toml`
（`apiBaseURL = "https://…"`），开箱就连后端，不用再手工填第二遍。要点：

- **只改这一份**：Hugo 合并根 `hugo.toml` 的 `[params]` 与 `config/_default/params.toml` 时以后者为准（实测），
  两处都写时根目录那份是死字。留空 = 整站退回纯静态（不加载评论组件、不发任何请求）。
- 本地联调要把线上地址临时盖回 8787：另建 `config/development/params.toml` 写
  `apiBaseURL = "http://127.0.0.1:8787"`，`hugo server` 默认按 development 环境取，会自动覆盖。
- 后台「前端管理 → 主题配置文件」读写的是同一份 `config/_default/params.toml`。
- 改完要重新构建才进页面（它是构建期烤进 HTML 的）。

> 别用环境变量 `HUGO_PARAMS_APIBASEURL=…` 覆盖：Hugo 会把参数名小写成 `apibaseurl`，
> 而主题读的是 `params.apiBaseURL`，看着进了 `hugo config` 实际渲染不出任何东西。

---

# 三、上线后的配置教程（按这个顺序做）

1. **建第一个账号** —— 它就是站长 / `admin`。库里还没有账号时，后台登录页会自己变成
   「建为站长并登录」表单：填邮箱 + 两遍密码，第一个账号跳过邮箱验证，建完这表单就消失。
   等价的手动做法是
   `curl -X POST https://<worker 地址>/api/auth/register -H 'Content-Type: application/json' --data-binary '{"email":"你@域名","password":"至少 8 位"}'`。
   之后在「设置 → 注册与邀请码」里
   按需关闭注册、打开邀请码（随机码在「用户」页生成，可设可用次数与有效期）。
2. **基本信息**（前端管理 → 基本信息）：站点名、Logo、Favicon、分享图、落地页背景图 ——
   写进 `data/*.json`，一处改全站生效（标题、RSS、落地页、404 都读它）。
3. **发信方式**（设置）：选 SMTP / Resend / Cloudflare，填发件邮箱与授权码，
   页面按通道分节显示，没选的通道不会出现。**SMTP 端口优先用 465（服务商只给 465 时勾「隐式 TLS」）** ——
   465 这条在本项目上真发过信、逐封核过回执。587 / 2525 那类要先 `EHLO` 再 `STARTTLS` 升级的端口，
   代码走的是同一条实现，本地台架（假 SMTP 按 RFC 4954 走完 `AUTH LOGIN` 的 334/334/235 对话）
   **实测三种配法都能把信投出去**，包括「明文连过去再升级」这一种；剩下的唯一未知是真服务商的证书链信任
   （本地只能自签证书 + `NODE_EXTRA_CA_CERTS`，Workers 运行时只信公共 CA）。
   还有一层是运行时给的：workerd 会静默丢掉 `startTls` 的 `expectedServerHostname` 选项，
   所以升级之后**证书主机名有没有被校验，产品侧无法强制** —— 这条属于平台限制，不是本项目能修的。
   先用那一节的「发一封测试信」验证，再用「邮件模板」的预览确认正文。
   每日上限是给免费档留余量的：额度不够时群发与订阅推送整批不发，第二天自动续跑。
4. **评论**（设置 → 评论）：文章评论区选 `zero` 就是自建评论；选第三方时前台在下一次页面加载就接管，
   不用重新构建（配置缓存在 isolate 内存里 30 秒，改那一下所在的 isolate 当场就翻，见「配置」那节）。要不要游客评论、是否需要审核、嵌套层数、每小时限流都在这里。
   那两个「用哪一家」的下拉（文章区与时刻区）是枚举项，接口只收 `zero / waline / twikoo / giscus / artalk`：
   存进枚举外的值会让主题运行期认不出这一家、把服务端已经渲染好的评论区换掉，所以整批保存直接 400 并点名允许列表。
   广告拦截在「评论审核」：命中正则进待审、可维护正则文件、也能接第三方审核服务。
5. **点赞与收藏**（设置 → 点赞与收藏）：两个开关 + 是否允许游客（按设备指纹去重）。
6. **时刻页**（前端管理 → 时刻页）：卡片模式、每页条数、评论区用哪套系统；
   内容走 Git 发布，见「时刻」页。
7. **友链**（设置 → 友情链接 + 后台「友情链接」页）：开关联动导航项与 `/links/` 整页，
   在线申请与站点联盟分组、失联阈值（默认 30 天不可访问 / 90 天无动态）都在这。
   新增 / 改名 / 换组 / 删除都会同步 `data/links.yaml`，接口把结果放在 `linksFile` 里带回，
   写不回时页面会明说原因（前台那两个板块是构建期读这份 yaml 渲染的）。
   友链页「申请友链」那一栏的三段说明（友链要求 / 我的信息 / 提交示例）在
   「前端管理 → 友链申请」改，写 `data/apply.json`；三段全空时前台退回显示友链页正文。
8. **SEO**（前端管理 → SEO）：描述、关键词、OG、JSON-LD、`robots.txt`、sitemap、
   verification、主题色等 26 项，覆盖主题默认值；`data/seo.json` 的键是 snake_case。
9. **登录方式**（我的信息）：这里只决定**管理员**登录后台要交哪几样凭据
   （单密码 / 密码 + 身份验证器 / GitHub / 密码 + 邮箱验证码）。
   普通用户永远是邮箱 + 密码，邮箱验证码只用于注册 / 找回密码 / 绑定验证器；
   谁绑了验证器，谁在自己用户中心勾选「登录时要这枚动态码」（默认开）。
10. **媒体**（设置 → 媒体 + 后台「媒体库」）：多桶管理，桶填了 `baseUrl` 就用直链，
    没填就写 `mediaPublicUrl` 拼公开代理地址。**Markdown 里的图片地址必须绝对**，
    站点和 API 不同源，相对路径 `/api/media/...` 在站点那一侧是 404。
11. **翻译**（后台「翻译」）：整篇翻译工作台，可接真模型也可先用 `pnpm mock:translate` 自测；
    译稿先落进表单，确认后才写仓库。
12. **统计**（后台「访问统计」）：口径是按 IP 去重的 UV + PV，累计访客单独存；
    想不统计自己可以在「设置」里排除。每篇的数可以导出成站点的 `data/poststats.json`。
13. **备份**（后台「备份」）：一键导出 D1（评论 / 订阅 / 用户 / 友链 / 统计）成 JSON，
    也能导入恢复。导出文件含邮箱等个人信息，属敏感数据，别提交进仓库。

---

# 四、后台页面地图

| 路径 | 干什么 |
| --- | --- |
| `/login` | 管理员登录；API 地址优先取这里填的，其次取构建时内置的值，本地开发两者都不填走同源代理。按登录方式可能要动态码或邮箱验证码 |
| `/` | 仪表盘：待办数量、最近评论 / 申请 / 任务、快捷入口 |
| `/stats` | 访问统计：趋势、热门页面、来源、设备，以及「导出 `data/poststats.json`」（没有 CSV） |
| `/content` | 文章结构化编辑：字段 + 正文 + 短代码面板 + 封面选图、本地暂存与「保存到 Git（N）」批量推送、删除会连构建产物一起清 |
| `/moments` | 时刻发布与编辑（Git 里的 Markdown） |
| `/media` | 媒体库：多桶浏览、上传、复制绝对地址 |
| `/comments` | 评论管理：搜索、审核、删除（连带子树）、按文章聚合 |
| `/spam` | 评论审核：正则规则文件（落在内容仓库根的 `.zero/spam-patterns.txt`，不在 `data/` 里 —— Hugo 会把 `data/` 下任何未知扩展名当数据文件解析，放进去整站构建就炸）、命中记录、第三方审核服务配置 |
| `/friends` | 友情链接 + 待审申请两个 tab：分组、排序、失联阈值、同步 `data/links.yaml` |
| `/users` | 用户与邀请码：权限勾选（投稿 / 认证）、封禁、重置密码、删除账号（级联清理） |
| `/drafts` | 投稿审核：编辑、直接发布进仓库、驳回并邮件通知。落盘文件名按「发布那天 + 当天顺序号」（`20261020001.md`，同一天接着仓库里已有的最大号往下排，过了 999 进四位），不是标题 —— 中文标题当文件名时 Hugo 会把全角标点丢掉，生成又要 percent-encode 的长地址；**已经发布过的不换名**（评论、统计、收藏的 key 都是那个地址） |
| `/author-verify` | 作者认证申请：通过后写 `data/authors.yaml`，自动进「共创」组 |
| `/subscribers` | 订阅者：状态、确认时间、导出 |
| `/broadcast` | 邮件群发：任务列表、分批发送、失败重发、每日上限提示 |
| `/frontend` | 前端管理九个子页（基本信息 / 导航栏 / 首页 / 页脚 / 关于页 / 工坊 / 时刻页 / 友链申请 / SEO），共用一个保存按钮，可选择同时请求重建 |
| `/settings` | 全站配置：注册、评论、点赞收藏、订阅、头像与媒体、发信方式、友链、内容仓库、备份、邮件模板等 |
| `/translate` | 整篇翻译工作台 |
| `/backup` | 导出 / 导入 D1 数据 |
| `/my-info` | 站长资料、改密码、验证器绑定、GitHub 绑定、管理员登录方式与签发方 |

非管理员访问以上任何页面都是 404（不是跳登录页，避免暴露后台结构）。

---

# 五、配置的分层与权威

同一个值可能出现在四个地方，取值优先级从高到低：

```
后台「设置」写入的 D1 site_config 表
  > wrangler.jsonc 的 vars
  > 代码里的 STATIC_DEFAULTS
  > 主题 params
```

- **密钥**（`SECRET_KEYS`）读取时永远返回空串或「已设置」占位，只有写入路径会存原值；
  `wrangler secret` 与后台填的都有值时以后台为准。SMTP 密码 / Resend Key /
  Cloudflare Token 都能直接在设置里填，留空表示不改已存值。
- **公开键**（`PUBLIC_KEYS`）通过 `/api/config` 暴露给前台，主题运行时据此接管。
- **前端参数**由「前端管理」写 `data/*.json`，主题构建期读取；`params.toml` 是默认值。
  两者都有值时 **data 覆盖 params**，所以后台改完就是最终显示。
- 登录方式的唯一权威是 `account-shared.ts` 的 `LOGIN_POLICIES`；
  写错值会退回单密码，入口层（`PATCH /api/admin/config`）会直接拒绝并报可选值。

## API 路由分组

| 前缀 | 面向 | 说明 |
| --- | --- | --- |
| `/api/config` | 前台 | 公开配置 |
| `/api/auth` | 前台 | 注册 / 登录 / 验证码 / 会话 / GitHub |
| `/api/comments` `/api/reactions` | 前台 | 评论、点赞收藏 |
| `/api/subscribe` | 前台 | 订阅与确认 |
| `/api/moments` | 前台 | 时刻混合时间线 |
| `/api/friends` | 前台 | 友链列表与在线申请 |
| `/api/authors` `/api/media` `/api/analytics` | 前台 | 作者资料、公开媒体、统计埋点 |
| `/api/user` `/api/account` `/api/security` | 登录用户 | 用户中心：资料、评论、收藏、友链申请、投稿、认证、验证器、注销 |
| `/api/admin/*` | 管理员 | 内容与仓库、前端参数、评论审核、用户、订阅、群发、翻译、备份、统计、设置、我的信息 |

`POST /api/admin/frontend`（后台「前端管理」写 `data/*.json` 那一路）是**整段覆盖**：每段没送的键会按 schema 默认补齐再落盘。
面板每次送整段，所以界面里碰不到；**自己写脚本改一个字段要先 `GET` 回那一段的现值、改完整段送回去**，
否则那一段其余字段会被写成空串。不认识的键不落盘，会在回执 `data.ignored[]` 里点名。详见 `docs/DEPLOYMENT.md` 第 10 节「常见故障」那张表。

Cron 与队列消费者没有 HTTP 入口，走 `scheduled` / `queue` 事件。

### 自己写脚本调这些接口时要知道的四件事

这一小节写的都是「按 REST 直觉调用的人一定会撞上」的形状，接口本身不做解释就会表现为
「明明一样的地址，我的就是 404 / 我的站点怎么不更新了」：

1. **尾斜杠会自动归一**。`/api/security` 与 `/api/security/` 是同一个地址：多带的那个斜杠由后端回一个
   308 跳到没有斜杠的那份，方法与请求体都不改（不是会变 GET 的 301）。跳转响应上带完整的 CORS 头，
   所以跨源的前台/后台也能跟着跳完。
2. **`date` / `lastmod` / `publishdate` 这类日期字段必须是 Hugo 认得的写法**，可写 `2026-10-25`，
   也可以把时间和时区写全 `2026-10-25T12:00:00+08:00`；
   **`2026-10-25 12:00`（只到分、没有秒）这类会被拒**，接口直接回 400 并说明该怎么改。
   这一条不是洁癖：Hugo 对它是 `ERROR ... not a parsable date` **退出码 1、整站一个页面都不产出**，
   不是「这一篇不生成」。少秒、用 `/` 分隔、月份或日期越界都算。
3. **写内容的接口逐条回报，不整批抛错**。`POST /api/admin/content/batch` 永远回 200，
   每篇的结果在 `data.results[]`（`ok` / `reason` / `error`），`data.done` 才是真推上去的篇数；
   坏的那几条留在你的本地暂存里，照 `error` 改完再推。`PUT /api/admin/content/file` 单篇失败才回 4xx。
   回包里 `data.build`（有没有请求重建）与 `data.buildHealth`（构建体检，见下）是两件不同的事。
4. **图片上传会验真实字节，对象键有长度上限**。白名单只看扩展名，所以 0 字节的件、把 HTML 改名成
   `.png` 的件都会在 `POST /api/admin/media` 被拒（图床域名和站点同源时，这类文件是执行面）。
   对象键超过 700 字符在读写时就回 400 —— R2 自己会在更长时报 500 并把内部 trace 带出来。

### 往内容仓库写东西的那一道总闸

上面第 2、4 条那类判据（日期形状、JSON 语法、links.yaml 的形状）实现集中在
`packages/api/src/services/hugo-guard.ts`，而**执行点只有一个**：`services/repo.ts` 的
`writeViaTarget` / `commitViaTarget`，也就是真正落到 GitHub 或本地目录的那两个出口。

这是刻意选的位置。以前判据加在各条路由的「保存」里，结果是**保护按调用点堆积** ——
实测一度有 6 个会触发站点重建的入口一个检查都没带（投稿审核、友链申请、个人中心写稿、
整篇翻译、备份恢复，以及每天 02:00 的定时任务；定时任务直接往仓库写 `data/poststats.json`
与友链那两份 JSON，而首页精选与「最热」正是在构建期读它们）。
挂到出口上以后，新加一个写仓库的功能默认就带闸门，不需要谁记得再抄一遍。

两条边界写在这里，因为它们都是实测踩出来的：

- **只拦「Hugo 会硬失败」的**：`.toml` 用真解析器（smol-toml）、`.json` 只判 `JSON.parse` 能不能过、
  `.md` 只判时间字段。`data/*.yaml` 里**只有 links.yaml 按友链形状检查** ——
  同一份判据去量 `data/authors.yaml`（作者表）会把每一行都判成错，真上线就是站长存不了自己的作者表。
  上线前拿站长真实仓库 + 主题 exampleSite + 台架站点共 217 个文件过了一遍，要求零误拦。
- **批量提交是整批拒**（`commitViaTarget`）：一个提交 = 一次 Pages 构建，
  把 19 篇好的和 1 篇会让 Hugo 退出码 1 的写在一起，代价不是那一篇没发而是全站停在上一版。
  文章批量推送不受影响 —— 它在路由层就已逐篇判过并逐条回报（见上面第 3 条）。

线上构建成败的另一半在 `POST /api/build-report`：Worker 跑不了 hugo 子进程，所以由内容仓的 CI
把结果回报上来（配了 `BUILD_REPORT_TOKEN` 才有，见 `docs/DEPLOYMENT.md` 第 3 节那张表）。

---

# 六、迁移、备份、恢复

```bash
pnpm db:migrate:local      # 本地 D1（wrangler state）
pnpm db:migrate:remote     # 线上 D1
cd packages/api && pnpm db:generate   # 改了 schema.ts 之后生成新迁移
```

迁移目录是 `packages/api/migrations`，按文件名顺序应用，已到 `0010`
（最后一条给 `users` 加了 `totp_at_login`：普通用户绑定验证器后登录是否要动态码，默认要）。
线上部署走 `pnpm deploy:api`，它默认先 `migrations apply --remote` 再发布。

Waline / Twikoo 的历史评论可以搬进来：

```bash
pnpm migrate:waline        # 导出 JSON → D1 comments 表，详见 docs/DEPLOYMENT.md 第 7 节
```

日常备份用后台「备份」页导出 JSON，恢复也是同一页导入。备份是**按下导出那一刻的仓库快照**：
定时任务在那之后才第一次写出来的文件（`data/poststats.json` 这类）不在那份 JSON 里，恢复后也不会凭空补回 —— 口径与应对见 `docs/DEPLOYMENT.md` §7.5。

---

# 七、免费额度与写入削减

Cloudflare 免费档的量是硬约束，这套代码刻意做了这些收敛：

- **统计**：按 IP 去重 + 会话键缓存，同一次浏览不重复写 D1；累计访客单独存计数。
- **限流计数分两处**：一次 KV 限流 = 一读一写，而免费额度只有 **1000 次写/天**，5000 访问/天的站
  光埋点就超。所以 `/api/analytics/beat`、`/api/analytics/heartbeat`、`/api/reactions`、
  `/api/subscribe/status` 这四条前台高频口在 isolate 内存里计数（一次 KV 都不写，代价是冷启动重新计数、
  多 isolate 之间不共享，挡的是「同一会话/同一 IP 无节制地打」）；注册、发码、找回密码、登录、
  评论、评论点赞、友链申请、群发、翻译这些低频或敏感口继续用 KV，跨 isolate 生效。
- **限流的键长什么样**：`rl:<名字>:<来源 IP>:<这一项自己的提示>`（`lib/rate-limit.ts:76`）。
  所以「找回密码 每小时 5 次」实际是**每个邮箱 + 每个来源 IP 每小时 5 次**，两条口径要一起读，别当成账号级锁：
  换邮箱或换出口 IP 都是一块新桶，它是抬高撞库成本的一道闸，不是铁门。管理员登录除此以外还多一把
  只按 IP 的内存桶（30 次/小时，不写 KV）：撞库的人每次换个邮箱也碰不到它。代价记下来 ——
  同一个出口 IP 里别人的失败会占掉这 30 次，最坏被挡一小时，正常输错远到不了这条线。
  反过来的坑是兜底 IP：请求没带 `cf-connecting-ip` 时所有人共用 `203.0.113.1`，
  桶会挤到一起变得更严，不是变得更松。
- **停留时长结算有上限**：`heartbeat` 一个会话一小时 60 次、一个 IP 一小时 600 次，单次结算仍夹在
  `min(duration + ?, 86400)`（最长 24 小时）—— 这条接口不需要任何凭据，没有限流时一个脚本就能把
  D1 的行写入额度打满。
- **配置**：`site_config` 整表读一次缓在 **isolate 内存**里 30 秒（`config.ts:285` `CACHE_TTL_MS`），
  缓存冷了才会打一次 D1；`setConfig` 写完立刻作废，所以后台改完，接它那次请求的 isolate 当场就是新值，
  别的 isolate 最多再等 30 秒。**不占 KV 写额度。**
- **前台请求**：一次页面加载里 `/api/auth/me` 与 `/api/config` 各只问一次（主题侧共用同一在途请求）；
  跨页面不缓存 —— 这是 R31-9 有意为之，宁可多发一次只读请求，也不让后台开关晚生效。
- **批量**：后台「保存到 Git（N）」一次推送多篇 → 一条审计、一次缓存清理、**一次**构建请求；
  友链改动同理，合并文件写入与重建。
- **发信**：`emailDailyLimit` 到线就整批挂起，第二天续跑，不会因为超额被服务商封。
- **构建**：写内容 / 前端参数时可以选择「不请求重建」（页面勾选框），攒够一批再重建一次。

---

# 八、注意事项

- **`GIT_LOCAL_DIR` 只能本地用**：线上 Worker 上它是一个无效路径，设了会让回写静默失败。
- **CI 里没有 `packages/api/wrangler.jsonc` 就一定红**：真实配置不入库（里面是各人自己的 D1 / R2 / KV id），
  而 `wrangler deploy`（含 `--dry-run`）找不到配置时会退回「框架自动探测」，认出 Hono 后直接报
  `The detected framework ("Hono") cannot be automatically configured`。
  `ci.yml` 已从 `.example` 复制一份占位（构建只做打包校验，占位 id 无妨）；
  要真部署的那份（`docs/deploy-template.yml`）会先检查文件存在并给出提示 —— 
  把你的 `wrangler.jsonc` 提交进私有仓库，或用 Secrets/变量渲染出来。
- **`SESSION_SECRET` 不能随便换**：它同时是验证器密钥的加密主密钥，换了已绑定的
  身份验证器全部失效（用户需要重新扫码）。
- **备份文件是敏感数据**：`/api/admin/backup` 导出含邮箱、昵称、评论正文，别提交进公开仓库。
- **删除文章要连构建产物一起清**：本地由接口顺手删掉 `public/<分类>/<这篇>/`（线上 Pages 每次是干净目录），
  这要求 hugo 是用 `--disableFastRender` 起的。
- **`designed by 知止` 那行页脚不是配置项**：主题是别人写的，署名不许通过任何开关抹掉。
- **Windows 上的行尾与编码**：`data/links.yaml` 是 CRLF，写回逻辑保留原行尾与结尾换行；
  测试脚本别用 `curl -d '中文'`（MSYS 会破坏字节），改用 `--data-binary @文件` 或直接从 Node 发。
- **pnpm 脚本里不要写 POSIX 内联环境变量**（`FOO=bar node x.mjs` 在 Windows 上退码 127），
  配置从 shell 或脚本自己传。
- **同一时间只跑一个 Hugo 构建**：`.hugo_build.lock` 会串行化，强杀进程留下的锁文件会让之后每次构建静默卡住。

## 常见问题

| 现象 | 先查这里 |
| --- | --- |
| 后台一直 401 / `AUTH_EXPIRED` | `ALLOWED_ORIGINS` 有没有包含后台 origin；换域名后要重新登录 |
| 前台什么动态功能都没有 | 生产构建有没有 `apiBaseURL`（见「站点侧还差一步」） |
| 改了设置前台没变 | 该配置是不是写进静态页的那类（要重建），以及 30 秒配置缓存有没有过 |
| 后台提示 `站点数据文件没改：…` | `data/links.yaml` 与仓库配置：友链改动库里成功了、文件那一步失败会明说原因 |
| 新文章前台看不到 | 本地：是不是用 `-D` 起的（草稿本来就不该出现）；线上：等一次 Pages 构建完成 |
| 邮件发不出去 | 「发信方式」那一节的测试发送先看错误原文；本地没有凭据时页面会显示「已写入但发信失败」，`email_logs` 里有那封 |
| 评论组件区域高度 0 | 组件脚本有没有随 `zero/boot.html` 输出（主题侧不能用 `.Scratch` 去重，`hugo server` 下会漏发） |
| `hugo` 命令一动不动 | 删掉 `me/zero-site/.hugo_build.lock`（确认没有 hugo 进程在跑） |
| 远程封面把构建卡住 | 站点参数 `[image] remote_fetch = false` 跳过抓取，`remote_timeout` 调等待上限 |

---

# 九、命令一览

| 命令 | 作用 |
| --- | --- |
| `pnpm setup` | 交互式部署向导（资源 → 渲染 wrangler.jsonc → 迁移 → 写站点配置 → 部署 Worker → 写密钥 → 部署后台），`-- --no-deploy` 只做到写站点配置 |
| `pnpm deploy:api` | 同步 D1 迁移并部署 Worker，`-- --no-migrate` / `-- --dry-run` / `-- --local` |
| `pnpm deploy:cms` | 构建后台并部署 Pages，`-- --api <worker 地址>` / `-- --no-build` / `-- --project <名称>` |
| `pnpm create:site` | 生成私密的 `zero-site` 内容仓库骨架（含 CI 与 submodule、`_headers`/`_routes.json`、构建回报脚本、站内搜索页） |
| `pnpm migrate:waline` | Waline / Twikoo 导出 → D1 评论表 |
| `pnpm dev:api` / `pnpm dev:cms` | 本地开发（8787 / 5173） |
| `pnpm repo:bridge` / `pnpm mock:translate` | 本地回写替身（8792）/ 翻译替身（8791） |
| `pnpm build:comment` | 产出 `packages/comment/dist/zero-comment.js`，再由主题 `scripts/sync-comment.mjs` 复制过去 |
| `pnpm db:migrate:local` / `:remote` | 单独应用迁移 |
| `pnpm check` | `typecheck:scripts` → `-r typecheck` → `-r build`，与 `ci.yml` 一致 |
| `pnpm test` | 纯函数小测（作者表 YAML 校验、文章站内地址），CI 里也会跑 |
| `pnpm smoke` / `bash scripts/smoke.sh` | 接口冒烟（匿名 37 项 + 3 跳过；带 `ADMIN_COOKIE` 97 项），结尾自清临时文章 |
| `pnpm postdeploy` | 部署后只读核验（健康/迁移/媒体库绑定/后台守卫/批量口/CSP/站点在线），不写数据 |

更细的生产步骤、故障排查与 GitHub Actions 模板见 **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

## 许可证

Apache-2.0，全文见仓库根目录的 `LICENSE`（专利授权条款比 MIT 更明确，商用与二次分发都更稳）。
第三方依赖各自的许可证见各包的 `package.json`；配套的 `zero-theme` 是 MIT。
