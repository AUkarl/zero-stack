# Zero Stack 部署指南

zero-stack 是「Hono Worker（zero-api）+ SvelteKit 后台（zero-cms）+ 评论组件（zero-comment）」的单体仓库，
配套 `zero-theme`（公开主题）和 `zero-site`（私密内容仓库）。本文只讲 zero-stack 的部署。

- 想生成自己的内容仓库：`pnpm create:site`，见 [第 6 节](#6-生成-zero-site)
- 想迁移旧的 Waline / Twikoo 评论：`pnpm migrate:waline`，见 [第 7 节](#7-迁移旧评论数据)
- CI 模板：`docs/deploy-template.yml`

---

## 0. 上线总顺序（照这个清单从上到下做，每步都带验证）

细节在后面的分节里，这一节只负责"下一步该做什么"。卡住时先看 [第 10 节 常见故障](#10-常见故障)。

| # | 做什么 | 命令 / 位置 | 怎么算成功 |
|---|---|---|---|
| 1 | 装依赖 | `pnpm install`（Node ≥ 22） | `pnpm exec wrangler --version` 有输出 |
| 2 | 登录 Cloudflare | `pnpm exec wrangler login` | `wrangler whoami` 显示你的邮箱 |
| 3 | 一键建资源 + 部署后端与后台 | `pnpm setup`，三问依次是**前台地址**、**后台地址**、**API 地址**（绑了自定义域名就填它，留空则用 `*.workers.dev`） | 结尾打印 API 与后台两个 URL；`GET <API>/api/health` 回 `ok:true` |
| 4 | 建站长账号 | 打开后台地址。**库里没有账号时登录页会自动变成「建为站长并登录」**，填邮箱 + 两遍密码 | 进仪表盘；`GET <API>/api/auth/init-status` 变 `pending:false` |
| 5 | 后台「设置」 | `siteUrl` = 前台域名、`mediaPublicUrl` = API 地址、发信方式（SMTP/Resend/Cloudflare） | 「发信方式」页的「发一封测试信」收到 |
| 6 | 生成内容仓库 | `pnpm create:site`（在 zero-stack 里跑，生成到同级目录） | 目录里有 `hugo.toml`、`content/`（含 home/about/links/… 全部页面分区）、`themes/zero` 子模块 |
| 7 | 本地验证前台 | `cd <内容仓库> && hugo server -D` | 浏览器逐个点导航：`/home/ /about/ /links/ /moments/ /posts/…` 都不 404，文章页有评论框 |
| 8 | 部署前台 | 推到 GitHub → Cloudflare Pages 建项目（构建命令 `hugo --gc --minify`，输出 `public`）→ 绑自定义域名 | 线上首页能 `grep -o "designed by 知止"`；文章页有 `zero-comments…js` |
| 9 | 放行前台域名 | 把第 8 步的域名加进 `packages/api/wrangler.jsonc` 的 `ALLOWED_ORIGINS`，然后 `cd packages/api && npx wrangler deploy` | `curl -X OPTIONS <API>/api/comments -H "Origin: https://你的前台域名" -i` 响应里有 `Access-Control-Allow-Origin` |
| 10 | 打通后台写仓库 | Worker secret `GITHUB_TOKEN`（Fine-grained PAT：勾上这个仓库 + Contents 读写），后台「设置 → 内容仓库」填 owner/repo/branch | 后台「前端管理」改一项能保存，且 GitHub 上出现对应提交 |
| 11 | 迁移旧评论（可选） | `pnpm migrate:waline`，见 [第 7 节](#7-迁移旧评论数据) | 后台「评论」里旧评论条数对得上 |
| 12 | 备份 | 后台「备份」→「存档到 R2」（全站备份），另外可 `cd packages/api && npx wrangler d1 export zero-db --remote --file=backup.sql` 存一份裸库 | 存档列表里有今天那份，体积非 0 |

第 3、4、9、10 步是新手最容易卡住的地方，各自的报错与自查见第 10 节。

---

## 1. 需要准备什么

| 项目 | 要求 |
|---|---|
| Node.js | >= 22（wrangler 4.x 强制，低于 22 会在 `wrangler deploy` 时报错）|
| 包管理 | pnpm >= 9（根目录有 `pnpm-workspace.yaml`） |
| Cloudflare 账户 | 已开通 Workers、Pages、D1、KV、R2、Queues 免费额度即可起步 |
| wrangler | 仓库已作为 devDependency 安装，无需全局安装 |
| 一个能收发邮件的邮箱 | SMTP 通道用；也可改用 Resend 或 Cloudflare Email Sending |

第一次使用先安装依赖并登录：

```bash
pnpm install
pnpm exec wrangler login   # setup 脚本也会自动检测并引导登录
```

---

## 2. 一键部署（推荐路径）

```bash
pnpm setup
```

向导会依次完成：

1. 检测 `wrangler whoami`，未登录时拉起浏览器授权；
2. 询问站点名称、前台地址、后台地址、API 地址（给 Worker 绑的自定义域名，留空则用刚部署出的
   `*.workers.dev`）、邮件通道（SMTP / Resend / Cloudflare / 暂不配置）、是否启用「文章提交回 Git」；
   三个地址里前两个会整段写成 `ALLOWED_ORIGINS`（CORS 精确匹配），重跑向导时它们默认取
   `wrangler.jsonc` 里现有的值，被丢掉的来源会先警告再覆盖；
3. 创建（或复用）以下 Cloudflare 资源；
4. 由 `packages/api/wrangler.jsonc.example` 渲染出真实的 `packages/api/wrangler.jsonc`；
5. 写入 secrets；
6. `wrangler d1 migrations apply zero-db --remote`；
7. 部署 zero-api，构建 zero-comment 与 zero-cms，部署到 Cloudflare Pages。

只想准备资源与配置、暂不部署：

```bash
pnpm setup -- --no-deploy
```

### 2.1 资源命名

脚本按固定名称创建并在重跑时复用，改名需同时修改各包 `package.json` 里的 wrangler 命令：

| 类型 | 名称 | Worker 绑定 |
|---|---|---|
| D1 数据库 | `zero-db` | `DB` |
| R2 桶 | `zero-media` | `R2` |
| KV（缓存） | `CACHE` | `CACHE` |
| KV（会话/限流） | `SESSION` | `SESSION` |
| Queue（邮件出站） | `zero-email` | `EMAIL_QUEUE` |
| Worker | `zero-api` | — |
| Pages 项目 | `zero-cms` | — |

Cron 固定在 `wrangler.jsonc` 的 `triggers.crons`（默认每天 02:00 UTC），负责友链检测、RSS 抓取、定时时刻、统计清理。

### 2.2 生成的 wrangler.jsonc

占位符 `<从 wrangler d1 create 获取>`、`<CACHE KV ID>`、`<SESSION KV ID>` 会被真实 id 替换；
`SITE_NAME` 会替换为 `SITE_URL` + `SITE_NAME` 两项，`ALLOWED_ORIGINS` 用向导输入的两个地址填充。
选择启用 Git 写回时再追加 `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH`。

> `packages/api/wrangler.jsonc` 已在 `.gitignore` 中，仓库只保留 `.example`。

---

## 3. 密钥（secrets）

`pnpm setup` 只通过 stdin 写入密钥，不会把值拼进命令行，也不会写进任何文件。

| Secret | 来源 | 必需 | 说明 |
|---|---|---|---|
| `AUTH_SECRET` | 随机生成 | 是 | 邮箱验证码等一次性令牌签名 |
| `SESSION_SECRET` | 随机生成 | 是 | 会话令牌签名 |
| `SMTP_PASSWORD` | 向导输入 | SMTP 通道 | SMTP 密码 / 授权码 |
| `RESEND_API_KEY` | 向导输入 | Resend 通道 | — |
| `CF_ACCOUNT_ID` / `CF_EMAIL_API_TOKEN` | 向导输入 | Cloudflare 邮件通道 | — |
| `GITHUB_TOKEN` | 向导输入 | 可选 | 后台把文章、时刻、作者表提交回 `zero-site`，需要 `contents: write` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth App | 可选 | 「GitHub 验证登录」与账号绑定；不配时该入口直接回「未配置」，其余功能不受影响 |

`GITHUB_REDIRECT_URI`（OAuth 回调地址）与 `GIT_LOCAL_DIR`（未配 GitHub 时把后台写入落到本地目录）
只在本地 `.dev.vars` 里用；线上不要设 `GIT_LOCAL_DIR`，否则 Worker 上会退化成无效的本地路径。

重跑 `pnpm setup` 会重新生成 `AUTH_SECRET` / `SESSION_SECRET`，已登录的会话会失效（评论者不受影响）。
三个地址默认沿用 `wrangler.jsonc` 里现有的值（直接回车就是不改），但 `ALLOWED_ORIGINS` 仍是由
「后台地址 + 前台地址」两答整段生成 —— 手加进去的第三个来源不在答案里就会被删掉，脚本会先打印警告。
手动补写某个密钥：

```bash
cd packages/api
npx wrangler secret put SMTP_PASSWORD
```

---

## 4. 分步部署

```bash
pnpm deploy:api          # 先同步 D1 迁移，再部署 worker
pnpm deploy:api -- --no-migrate   # 只改了代码时跳过迁移
pnpm deploy:api -- --dry-run      # 只校验打包，不上传
pnpm deploy:api -- --local        # 只把迁移打到本地 D1

pnpm deploy:cms          # 构建 zero-cms 并部署到 Pages（会问一次 API 地址）
pnpm deploy:cms -- --no-build     # 复用已有产物
pnpm deploy:cms -- --project my-cms
pnpm deploy:cms -- --api https://zero-api.xxx.workers.dev   # 不问，直接内置这个地址
```

`deploy:cms` 会先确认 Pages 项目存在，没有就自己建（`pages project create <名称> --production-branch main`）。
不能省这一步：`pages deploy` 碰到不存在的项目要问「要不要创建」，非交互上下文里它不问而是直接报
`This command cannot be run in a non-interactive context` —— CI 必然如此，本地也一样
（脚本为了从输出里取 `*.pages.dev` 地址，把 stdout 接成了管道）。手工等价命令：

```bash
cd packages/cms
npx wrangler pages project create zero-cms --production-branch main
npx wrangler pages deploy .svelte-kit/cloudflare --project-name=zero-cms
```

后台取 API 地址的优先级：

1. 登录页填的「API 地址」（浏览器 `localStorage`）—— 现场排查随时能改；
2. 构建时内置的 `VITE_API_BASE` —— 来自 `--api`、环境变量或 `packages/cms/.zero-api-base`（上一个命令问过之后记下的，已 gitignore）；`pnpm setup` 内置的是向导里「API 地址」那一答，留空才退回刚部署输出的 `*.workers.dev`；
3. 都没有 = 同源。本地靠 vite 的 `/api` 代理没问题，**Pages 上没有这个代理，同源就是 404**。

CI 或脚本里想跳过提问就给环境变量（`docs/deploy-template.yml` 用的就是仓库变量 `API_BASE_URL`）：

```bash
VITE_API_BASE=https://zero-api.xxx.workers.dev pnpm deploy:cms
```

> 上面这种「前缀赋值」写法只在 bash / zsh 里有效。PowerShell 用
> `$env:VITE_API_BASE="https://zero-api.xxx.workers.dev"; pnpm deploy:cms`，cmd 用 `set VITE_API_BASE=…`。

前后端不同源时，前台与后台的 origin 都必须在 `packages/api/wrangler.jsonc` 的 `ALLOWED_ORIGINS` 里
（逗号分隔，改动后需重新 `pnpm deploy:api`）。登录会话是 `HttpOnly` Cookie，浏览器本地联调用同源代理，见第 8 节。

---

## 5. 部署后自检

| 检查 | 方法 |
|---|---|
| 运行时与绑定 | `curl https://<worker-url>/api/health`，`ok: true` 且 `broken` 为空 |
| 后台可用 | 库里还没有账号时，后台登录页会自动变成「建为站长并登录」表单（`GET /api/auth/init-status` 报 `pending: true`），填邮箱 + 两遍密码就完成初始化，第一个账号直接是 `admin` 且跳过邮箱验证，建完这表单就消失。等价的手动做法：`curl -X POST https://<worker 地址>/api/auth/register -H 'Content-Type: application/json' --data-binary '{"email":"你@域名","password":"至少 8 位","name":"站长"}'`，回 `role: "admin"` 即站长账号建好（表单会顺手帮你登录，直接进仪表盘） |
| 邮件可用 | 后台「设置」填 `emailProvider` / `smtpHost` / `smtpPort` / `smtpUser` / `emailFrom` → 走一次找回密码或群发 |
| 站点地址 | 后台「设置」填 `siteUrl`（正式域名）与 `mediaPublicUrl`（Worker 地址），前者决定后台列表里的链接与邮件里的落地页，后者决定图片的绝对地址 |
| 媒体可用 | 后台「媒体」上传一张图，复制它给出的绝对地址直接打开应能出图：桶配了 `baseUrl` 就是桶域名直链，没配则是 `<mediaPublicUrl>/api/media/<桶>/<键>`（公开只读代理，无需登录） |
| 管理员联系邮箱 | 后台「设置」填 `adminContactEmail`，前台 `/account/` 的「找回密码」会把这句话补全：「如密码遗失，可使用注册邮箱向管理员 xxx 发送邮件找回」 |
| Cron 在跑 | 后台「仪表盘」运行状况卡片，或 `SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 10` |
| 队列在跑 | 后台「订阅」群发一次，观察 `email_logs` 表状态 |
| 接口链路 | `API=https://<worker-url> bash scripts/smoke.sh`；管理员段要带 cookie：`API=… ADMIN_COOKIE='zero_session=…' bash scripts/smoke.sh` |
| 时刻与作者表 | 后台发一条时刻 → 仓库应出现 `content/zh/moments/<日期>-<标识>.md`；作者认证通过 → `data/authors.yaml` 多一条，前台 `/author/<标识>/` 与文章页作者框同步 |
| 评论属地与提醒 | 后台发一条评论 → 「评论」列表该条带属地 / 浏览器 / 系统 / 设备；`email_logs` 里应有站长与被回复者的提醒信（未配发信凭据时状态为失败并写明原因） |

```bash
npx wrangler d1 execute zero-db --remote --command "SELECT name, status, detail FROM job_runs ORDER BY started_at DESC LIMIT 10"
```

---

## 6. 生成 zero-site

```bash
pnpm create:site
```

向导会问站点名称、GitHub 用户名、仓库名、API 地址、站点域名、主题仓库地址，然后在 **zero-stack 的同级目录**
生成一个可直接推送的 Hugo 仓库：`hugo.toml`（含 `params.apiBaseURL` 与各功能开关）、落地页 `content/_index.md`、
主题需要的**全部页面分区**（`home / about / archive / tools / work / subscribe / account / links / moments / posts`，
少一个分区导航里就是一条 404）、示例文章与时刻、`data/friends.yml`、`.gitignore`、`.github/workflows/deploy.yml`、
`README.md`，并在本地 `git init` + 提交。

- 脚本只在本地生成与提交，**不会替你推送远端**，推送指令会打印出来由你自己执行；
- 内容仓库必须保持 **Private**：里面有未发布的草稿与个人信息；
- 子模块 `themes/zero` 指向你的 zero-theme 仓库；若自动 `git submodule add` 失败（未登录 / 仓库不存在），
  按打印出的命令手动执行一次即可；
- 全部问题都可以用参数跳过，便于脚本化：

```bash
pnpm create:site -- --site-name=Demo --github-user=demo --repo=zero-site \
  --api=https://demo.workers.dev --site-url=https://demo.pages.dev \
  --theme-repo=https://github.com/demo/zero-theme.git --git=n
```

zero-site 需要配置的 GitHub Secrets：`CF_API_TOKEN`（Pages 编辑权限）、`CF_ACCOUNT_ID`。

### 6.1 主题怎么进内容仓库（三选一，按你的部署方式挑）

主题的模板在 `zero-theme/layouts/` 下，构建时必须能在 `themes/zero` 或 Hugo Module 里找到它，
否则 hugo 会用内置空主题，产出一张没有任何样式的骨架页（页面能打开、什么都不显示，很容易误判成"配置没生效"）。

| 方式 | 怎么做 | 适用 | 注意 |
|---|---|---|---|
| **Git Submodule**（`create:site` 默认） | `git submodule add https://github.com/AUkarl/zero-theme themes/zero` | 本地构建 + GitHub Actions 构建（模板里已带 `submodules: recursive`） | 换机器 / 重新 clone 后要 `git submodule update --init --recursive`；Cloudflare Pages 的 git 构建**不会**自动拉子模块，用 Pages 构建就得在构建命令里自己加一句 |
| **复制目录** | 把主题仓库内容复制进 `themes/zero`（不要 `exampleSite`） | 最省事，任何 CI 都能构建 | 升级主题 = 再复制一次；复制后本地要重启 hugo |
| **Hugo Modules** | `hugo mod init github.com/你/仓库 && hugo mod get -u github.com/AUkarl/zero-theme`，配置里写 `[module.imports]` | 想一条命令升级主题 | **需要 `go` 命令在 `PATH` 里**（见下），CI 的构建镜像也得有 Go |

关于 Go：**装在哪一个盘都无所谓**，Hugo 只按 `PATH` 找 `go.exe`，不读 `GOROOT`、也不看注册表。
所以 `E:\Program Files\Go`、`D:\Go`、`C:\Go` 都能用，只要把里面的 `bin` 目录加进 `PATH`：

```powershell
# Windows PowerShell：把 <Go 安装目录>\bin 换成你实际的安装路径
$env:PATH += ";E:\Program Files\Go\bin"          # 只对当前窗口生效，先验证
go version                                        # 有输出就说明找得到
setx PATH "$env:PATH"                             # 确认没问题后写回用户 PATH，重开终端生效
```

```bash
# macOS / Linux（brew 安装通常在 /opt/homebrew/bin 或 /usr/local/bin，已在 PATH 里，无需设置）
export PATH="$PATH:/usr/local/go/bin" && go version
```

```powershell
# 网络到不了 proxy.golang.org 时，让 Go 直接走 git 拉取
setx GOPRIVATE "github.com/AUkarl/*"
```

如果不想装 Go、也不想动 PATH，就用上表的「复制目录」或「Git Submodule + 本地构建」，两者都不依赖 Go。

### 6.2 后台「设置 → 内容仓库」的路径要按你的目录布局填

后台写文件的路径全部来自这几项配置（缺省值按多语言布局写，扁平布局必须改，
否则文章会落到 Hugo 认不到的目录里 —— 表现为"后台说发布成功了，前台却没有"）：

| 配置项 | 后台里的名字 | 多语言布局（`[languages.zh] contentDir = "content/zh"`） | 单语言扁平布局（内容直接在 `content/`） |
|---|---|---|---|
| `githubContentDir` | 内容目录 | `content` | `content` |
| `githubPostsDir` | 文章目录 | `content/zh/posts` | `content/posts` |
| `githubMomentsDir` | 时刻目录 | `content/zh/moments` | `content/moments` |
| `githubLinksFile` | 友链文件 | `data/links.yaml` | `data/friends.yml`（看你仓库里实际叫什么） |
| `githubAuthorsFile` | 作者数据文件 | `data/authors.yaml` | 同左 |
| `githubDataDir` | 前端数据目录 | `data` | 同左 |

改完不用重新部署 Worker（这些值存在 D1，约 60 秒缓存刷新）；只有 `wrangler.jsonc` 里的 vars 与代码改动才需要 `pnpm deploy:api`。

> `pnpm create:site` 生成的是扁平布局，所以向导跑完后要把「文章目录 / 时刻目录」改成 `content/posts`、`content/moments`。

---

## 7. 迁移旧评论数据

支持 Waline 与 Twikoo 的导出 JSON，自动判定格式。

```bash
# 1. 从 Waline 管理端 / Twikoo 控制台导出评论，存为 scripts/waline-export.json（或 twikoo-export.json）
# 2. 先转换并检查
pnpm migrate:waline
# 3. 确认输出的统计无误后导入
pnpm migrate:waline -- --apply=local     # 先灌本地库看效果
pnpm migrate:waline -- --apply=remote
```

生成的是 `scripts/converted-comments.sql`（`.gitignore` 已排除，内含全部评论内容，不要提交）：

- 主键由旧 id 派生（md5 → uuid 形状）并使用 `INSERT OR IGNORE`，**重复执行不会产生副本**；
- 所有 slug 走 `canonSlug()`，与评论 API 的查询口径一致（去查询串、去尾斜杠、带前导斜杠）；
- 按 `depth` 升序插入，满足 `parent_id` 的外键约束；
- 超过 `commentMaxDepth`（默认 6，可用 `--max-depth=` 改）的回复上提，父记录缺失的挂到能解析出的最高层祖先，
  环形引用截断为顶层；转换报告里会逐项给出条数；
- 状态映射：`approved → approved`、`waiting/verify → pending`、`spam` 与 Twikoo 的 `isSpam → spam`；
- 旧记录标记 `is_legacy = 1` 并保留 `legacy_id`，便于回滚核对。

可用参数：`--from=<路径>`、`--slug-field=post|url|auto`（默认 `auto`，优先看起来像路径的那个字段）、
`--max-depth=<n>`、`--apply=local|remote`。

验证与回滚：

```bash
npx wrangler d1 execute zero-db --remote --command "SELECT COUNT(*) FROM comments WHERE is_legacy = 1"
npx wrangler d1 execute zero-db --remote --command "DELETE FROM comments WHERE is_legacy = 1"   # 回滚本次导入
```

媒体文件迁移建议用 rclone：

```bash
rclone config create r2 s3 provider=Cloudflare \
  access_key_id=<R2_ACCESS_KEY_ID> secret_access_key=<R2_SECRET_ACCESS_KEY> \
  endpoint=<ACCOUNT_ID>.r2.cloudflarestorage.com
rclone copy r2:旧桶/uploads r2:zero-media/uploads --progress
```

时刻与友链在后台逐条补录即可（后台「时刻」「友链」页支持增删改与手动检测）。

---

## 7.5 全站备份：把整站搬到新账号、新仓库

后台「备份」只有**一种**备份 —— 全站。导出的是一份 JSON，十个分区：

| 分区 | 装的是什么 |
|---|---|
| 站点设置 | `site_config` 的开关与文案；**密钥与绑定本站域名/仓库坐标的项不进文件** |
| 主题样式 | 仓库 `data/*.json`（导航、首页、页脚、关于、工坊、时刻页、SEO、站点信息）+ `params.toml` |
| 文章 / 时刻 | 设置里那两个目录下的全部 `.md`（递归，含子目录） |
| 友链 | D1 的友链与已抓到的博客动态 + 仓库 `links.yaml` |
| 订阅名单 | 已确认的订阅邮箱（发信日志与群发记录不备份） |
| 评论 | 评论正文、层级与评论者身份 |
| 点赞与收藏 | `reactions`（整表，不再截断）与评论点赞 |
| 账号 | 普通用户（含密码哈希）与仓库 `authors.yaml`；**管理员账号不导出** |
| 媒体清单 | R2 里图片的 key、体积、被哪篇文章引用；**图片本体不在文件里** |

### 搬站步骤

1. 旧站：后台「备份」→「存档到 R2」或「导出到本地」，拿到那份 JSON。
2. 新账号：按第 0 节把 Worker、Pages、D1 建好并跑完迁移，前台内容仓库用 `pnpm create:site` 生成（或先推空仓库）。
3. 新站后台「设置 → 内容仓库」把 owner / repo / branch 与**文章目录、时刻目录**配成和备份里一致（JSON 顶部的 `origin` 就是旧站的这三个值），并配好 `GITHUB_TOKEN`。
4. 后台「备份」→「恢复」：选中 JSON → 分区默认全选，**先点「跑演习」**。演习不写任何东西，只回：每区会写多少行、哪些文件同名、配置将改哪几项（本站现值 → 备份值）。
5. 确认后点「推送恢复」。同名文件默认保持本站不动；要让旧稿盖掉新站的示例稿，就勾「覆盖同名文件」。
   恢复完会自动调一次 Pages 构建 Hook（没配就提示等下次自动构建）。
6. 手工补三样不进文件的东西：各类密钥（SMTP / Resend / Cloudflare / 审核服务商 / 翻译）、
   绑定本站的配置（`siteUrl`、仓库坐标、媒体桶）、以及图片本体（按媒体清单 `wrangler r2 cp` 过去，或让新桶同名）。
7. 新站后台登录并注册第一个账号 —— 备份里的管理员账号刻意不导，避免「备份文件 = 一个能登录别人后台的账号」。
   普通用户与评论的作者归属照常带过来。

数据表类分区是**主键已存在就跳过**，不覆盖本站记录；附属计数（Waline 的表态数与浏览量）按只增不减并入。
v1 的旧备份文件（只有 `tables`）会被明确拒绝，评论可以走「导入其它评论系统的历史评论」那一栏单独搬。

---

## 8. 本地开发

```bash
# 终端 1：worker（http://127.0.0.1:8787）
pnpm dev:api
# 终端 2：后台（http://localhost:5173，/api 已由 vite 代理到 worker，Cookie 同源）
pnpm dev:cms
```

本地绑定文件 `packages/api/wrangler.jsonc`（首次可复制 `.example`）与 `packages/api/.dev.vars`：

```ini
AUTH_SECRET=dev-only-secret
SESSION_SECRET=dev-only-secret
```

本地库初始化：

```bash
pnpm db:migrate:local
pnpm exec wrangler d1 execute zero-db --local --command "SELECT count(*) FROM users"
```

后台登录页的 API 地址留空即表示同源（走 vite 代理）。
上传需要 R2：本地 `wrangler dev` 自带模拟存储，无需真实桶。

---

## 9. 用 GitHub Actions 部署

把 `docs/deploy-template.yml` 复制成你自己仓库的 `.github/workflows/deploy.yml`，
并配置 `CF_API_TOKEN`、`CF_ACCOUNT_ID` 两个 Secrets。模板会先应用 D1 迁移再部署 worker，然后构建并部署后台。

zero-stack 自身的 `.github/workflows/ci.yml` 只做校验：`pnpm typecheck:scripts` → `pnpm -r typecheck` → `pnpm -r build`。

```bash
pnpm check   # 本地跑同一套校验
```

> 聚合校验脚本不要叫 `ci`：pnpm 内置的 `pnpm ci`（等同 `install --frozen-lockfile`）会优先于同名 package script。

---

## 10. 常见故障

| 现象 | 原因 / 处理 |
|---|---|
| 后台点「注册 / 登录」显示 `请求失败 (404)` | 登录页的「API 地址」留空了：留空 = 请求打到同源，只有本地 vite 有 `/api` 代理，Pages 上没有，于是后台自己的 SPA 壳回 404。在登录页填 worker 域名（存在浏览器 localStorage，填一次即可），或部署时用 `pnpm deploy:cms -- --api <worker 地址>` 内置进产物 |
| 后台登录提示 `邮箱或密码不正确` | 多半是**库里还没有这个账号**：接口对「邮箱不存在」和「密码错」回同一句话（防账号枚举）。空库时登录页会自动变成「建为站长」表单（第 5 节，第一个账号自动是 `admin`，注册关闭也拦不住它）；若注册时回 `409 该邮箱已注册`，说明账号确实在，走前台 `/account/` 的找回密码或后台「一键重置密码」 |
| 后台提示 `Failed to fetch` | 请求根本没完成，两种原因：① `*.workers.dev` 在部分网络不可达 —— 先在浏览器直接打开 `https://<worker 地址>/api/config`，能出 JSON 才算通，不通就给 worker 绑自定义域名（Workers → 设置 → 域名和路由），后台改填那个域名；② CORS 未放行 —— 把后台 origin 写进 `ALLOWED_ORIGINS` 后重新 `pnpm deploy:api`。重跑 `pnpm setup` 时这一行是按「后台地址 + 前台地址」两答整段重新生成的，自定义域名没答进去就会被挤掉 |
| 部署后台报 `This command cannot be run in a non-interactive context` | Pages 项目不存在时 `pages deploy` 要问「要不要创建」。`pnpm deploy:cms` 与 `pnpm setup` 已改成先 `pages project create`（见第 4 节）；手写 CI 流水线时也要先建项目 |
| `pnpm setup` 说「尚未登录」，但 `pnpm exec wrangler whoami` 明显示已登录 | wrangler 各版本的 `whoami --json` 形状不同（4.x 平铺 `{loggedIn,authType,email,accounts}`、3.x 包一层 `result`、更早是 `auth.email`）。脚本现按 `scripts/_util.ts` 的 `parseWhoami()` 三种都认，API Token 登录（没有 email）也认；仍不行就直接设环境变量 `CLOUDFLARE_API_TOKEN`（配合 `CLOUDFLARE_ACCOUNT_ID`）跳过浏览器授权 |
| `wrangler d1 migrations apply` 报 `no such table` | 迁移目录未变（`packages/api/migrations`），先 `pnpm db:migrate:remote`；确认 `migrations_dir` 未被改动 |
| 后台提示 `AUTH_EXPIRED` / 401 | Cookie 跨域丢失：检查 `ALLOWED_ORIGINS` 是否包含后台 origin；换域名后需重新登录 |
| 后台能打开、接口却全部失败，控制台报 CORS | `ALLOWED_ORIGINS` 是**精确字符串**匹配，差一个字符就不放行。Pages 每次预览部署的地址都不同（`https://<hash>.<项目名>.pages.dev`），只有生产地址稳定 —— 白名单填生产地址，并用生产地址访问后台；前台站点、自定义域名 Worker 各自都要列进来，逗号分隔，改完必须 `pnpm deploy:api` 才生效 |
| 邮件全部 `failed` | `SMTP_PASSWORD` 未写入，或后台 `smtpHost/smtpPort/smtpUser/emailFrom` 未填；465 需要 `smtpSecure=true`，587 用 `false` |
| 群发/订阅推送显示「整批未发送」，任务仍留在排队 | 当日发信额度不够这次收件人数（`emailDailyLimit`，默认 100 封/天）。第二天 Cron 会自动续跑；要当天发完就把上限调到 ≥ 订阅人数，或分批发 |
| QQ / 163 邮箱收不到信 | 必须用「授权码」而不是登录密码，且发件人地址要与 SMTP 账号一致；`smtpSecure=true` 只在 465 端口生效（隐式 TLS），587 / 2525 留 `false` 走 STARTTLS |
| 上传成功但图片 403 / 前台不显示 | 桶未开启公开访问且 `mediaPublicUrl` 没填；或 Markdown 里存的还是站内相对路径 —— 站点与 Worker 不同源时相对地址会指回站点。改 `mediaPublicUrl` 后重新插入一次即可，旧文章里的地址要手动替换 |
| 后台「前端管理」保存报「未配置内容仓库」 | 这一页写的是站点的 `data/*.json`，需要仓库写回通道：`GITHUB_TOKEN` + `githubOwner/githubRepo`，或本地的 `GIT_LOCAL_DIR`（本地开发还要 `GIT_LOCAL_HTTP` 指向 `pnpm repo:bridge`） |
| 后台保存文章成功、仓库没有变化 | 未配置 `GITHUB_TOKEN`，或 `githubOwner/githubRepo/githubBranch/githubContentDir` 与实际不符；看 worker 日志 |
| 评论组件在页面里不显示 | `apiBaseURL` 没配或指向错误协议；浏览器控制台看是否有 CORS 报错 |
| 注册/改密码报 `PBKDF2 failed: iteration counts above 100000 are not supported` | Cloudflare 的 Web Crypto 把 PBKDF2 迭代次数硬上限设在 100000，本地 workerd 走 Node 的 crypto 不报错，只有上线才暴露。`packages/api/src/lib/crypto.ts` 的 `PBKDF2_ITERATIONS` 必须 ≤ 100000；口令串本身带迭代次数（`pbkdf2$次数$盐$摘要`），改小不影响老账号登录 |
| 后台保存内容时 `GitHub 拒绝访问（403）：Forbidden` | GitHub 对「令牌能用但没这个仓库权限」统一回 403（不是 404，防探测）。逐项确认：令牌账号 = `githubOwner`；**Fine-grained PAT 必须在 Selected repository 里显式勾上这个仓库**并给 `Contents: Read and write`（新建的仓库不在旧令牌的选择列表里，就会这样）；Classic PAT 要有 `repo` 作用域；账号开了 IP allow list / SAML 时还要额外授权。自查命令（把 TOKEN 换成你的令牌，不会外泄）：`curl -sI -H "Authorization: Bearer TOKEN" https://api.github.com/repos/<owner>/<repo> | grep -iE "^http|x-oauth-scopes|x-ratelimit-remaining"` —— 403/404 就是令牌看不到该仓库；`x-oauth-scopes` 里应有 `repo`（Classic）或为空但仓库已勾选（Fine-grained） |
| Cron 从未执行 | `wrangler.jsonc` 的 `triggers.crons` 被删；Workers Paid 才能自定义多个 cron，免费额度只有一条。注意「运行状况」里这张表是**真读 `job_runs`** 的：库里没有行就确实一次都没跑过（重建过的 D1 要等到下一个 02:00 UTC） |
| 运行状况的定时任务表永远显示「尚未执行过」 | 已修：接口以前把 cron 包成 `{ recent: [...] }` 对象回给按数组判断的界面，跑过也显示没跑过。若仍显示为空，先 `select name, count(*) from job_runs group by name` 确认库里有没有行 |
| 仪表盘的「文章」是 0，仓库里明明有稿子 | 已修：以前只列 `content` 这一层，而稿子在 `content/posts/` 下。现在按设置里的文章目录、时刻目录递归数 `.md`，目录填错就先去「设置 → 内容仓库」对一遍 |
| 发信胶囊红着，但验证码邮件确实发得出去 | 已修：判断凭据时只看了 `wrangler secret`，没算后台「发信方式」里填在 D1 的密码。现在两处任一有值就算绿，胶囊上会写明凭据来源是「后台已填」还是「wrangler secret」 |
| 后台「用户」页找不到站长自己那一行 | 已修：这一页以前 `where role <> 'admin'` 把管理员过滤掉了，而作者标识（handle）只能在这一页改，「我的信息 → 站长作者资料」又要求先有 handle，成一个死循环。现在默认列出站长那一行（标「站长」、三个权限位常亮置灰、作者标识可改） |
| 文章页署名还是主题自带的作者 | 署名的真值是**仓库里** `data/site.json` 的 `defaultAuthor`（主题构建期读，data 优先、params 兜底），不是后台设置里那个同名项。在「我的信息 → 站长作者资料」点一次保存即可：它会写 `data/authors.yaml`、把标识同步进 `data/site.json`，并触发一次重建。提示语会分开说明这三件事哪件没成 |
| 后台编辑器里中文显示成乱码，保存一次就更花 | 已修：读 GitHub 文件时用的是 `atob`，拿回来的是「一字节一字符」的 Latin-1 串 —— 中文读出即乱码，再保存一次就把乱码按 UTF-8 重编一遍写回仓库，每存一层叠一层（顺带让「内容一致就不提交」失效，白烧构建）。已经花掉的文件要修：把那份文件按「UTF-8 → Latin-1 字节 → UTF-8」解一层再存回去 |
| 友链审核通过显示成功，`/links/` 却没变 | 已修：回写目标是仓库里的 `data/links.yaml`（主题的 `layouts/links/list.html` 读 `hugo.Data.links` 的 `friends:` / `alliance:` 两段），而这份文件不存在时以前只回一句「仓库里没有」。现在第一次通过申请会顺手按骨架建出来。老仓库里只有 `data/friends.yml` 的话主题不会读它 —— 手工补一份 `data/links.yaml` 或让后台再写一次即可。路径与数据目录由同一个函数算，「设置 → 内容仓库 → 友链文件」留空就落在数据目录下 |
| 导航 logo 只剩一行站点名、标签页没图标、关于页与时刻页的头像打不开 | 已修：主题的 `params.toml` 和模板回落值一直写着 `img/logo-nav.webp`、`img/avatar.webp`、`img/logo-favicon.png`、`img/bj.webp`，可 `zero-theme/static/` 是空的 —— 站点没自己配这几张图就统统 404，新站部署完看着像没装好。现在主题自带中性占位图（`static/img/` 的 `logo-nav.png`、`logo-favicon.png`、`avatar.png`、`bj.png`、`bj2.png`，合计约 26KB），默认路径都改成实际存在的那几张。换成自己的：后台「前端管理 → 基本信息」填 logo / favicon / 头像，或直接改站点 `params.toml` 的 `logo` / `favicon` / `aboutAvatar` |
| 页脚有点了没反应的图标（`href` 是空的） | 已修：`[[footer.services]]` 的默认示例是一条全空记录，GitHub 那条社交图标的 `link` 也留空，模板照渲染就成了指向当前页的死链接。现在没填 `link` 的条目整条跳过，默认示例改成注释里的真写法 |
| `pnpm setup` 说「尚未登录」，反复弹浏览器授权还是登不上；或者选了 SMTP / 勾了「文章提交回 Git」却没问过任何补充问题 | 已修，两个症状同一个根：向导的条件追问把 `prompts` 回调的第一个参数当成了「已答集合」，它其实是**上一题的答案值**（`true.useGithub` 永远是 `undefined`），于是 SMTP 四问与 GitHub 四问一次都没问过；缺答案又被 `JSON.stringify(undefined)` 拼成裸字面量 `undefined` 写进 `packages/api/wrangler.jsonc`，那份文件从此不是合法 JSONC。而 wrangler 在任意目录都会先解析离它最近的配置，连 `whoami` 都失败退出，向导就把它误判成「你没登录」。现在：判定改读已答集合（八问都会问）、写盘前先拦 `undefined`、`whoami` 与 `login` 从仓库根目录跑、读不出来时把 wrangler 的原始报错原样打出来。手上已经有坏配置的，删掉 `packages/api/wrangler.jsonc` 里值为 `undefined` 的那几行，或直接重跑 `pnpm setup` 让它整份重写 |
| 向导里某一问每敲一个字就多出一行，屏幕上重复十几行同样的话 | 已修：`prompts` 每敲一个字符就把当前这一问整行重画一次，而 PowerShell 的 conhost 擦不掉换行后的残留，所以「文案 + 输入值」一旦超过终端宽度就会留下成串的重复行。现在提问只留短标签，解释文字在提问前单独打一行，并且脚本加载时就断言 message 不超过 24 列（`assertShortMessages`）——以后新增长文案会当场报错，而不是部署到一半才刷屏 |
| 向导显示「密钥已写入」，后台注册 / 登录却全 500 | 已修：`wrangler secret put` 的对象是**已存在的 worker**，首次部署时它还没建出来，`AUTH_SECRET` / `SESSION_SECRET` 每条都以 Worker not found 失败，而旧代码把失败吞成一句轻描淡写的提示。现在密钥排在 `wrangler deploy` 之后写，失败会把 wrangler 的原始报错打出来并给出补写命令；`--no-deploy` 这一支不再尝试写密钥，只提示留到真部署时做 |
| 前台注册的用户点「个人中心」404；管理员登录后跳 `/admin/` 404 | 两个都是**站点仓库缺东西**：个人中心要 `content/<语言子目录>/account/me/_index.md`（`layout: "me"`），`create:site` 与主题的 exampleSite 现在都带；后台地址要 `params.cmsBaseURL`（改配置文件要重建）或运行期的 `cmsAdminUrl`（管理员第一次从后台登录时后端自动记下自己的域名，随 `/api/config` 公开，可在「设置 → 注册与邀请码 → 后台地址」改）。主题取值顺序：params → 运行期配置 → 构建期常量 → 同域 `/admin/` |
| 后台「设置」点了「保存修改」什么也没发生，红字也不弹 | 已修：`<input type="number">` 绑进状态的是**数字**，保存前那句 `raw.trim()` 直接抛异常，而它跑在 `try` 外面 —— 不发请求、不报错，发信凭据（SMTP 授权码这类）永远存不进去。现在所有面板字段统一按字符串存。判断依据：保存后必须回显「已保存 N 项」，看不到这句就是没写进库 |
| 后台里点文章 / 用户的链接，落到一个带后端错误模板的 404 | 那些链接指向**站点前台**，必须由配置键 `siteUrl`（「前端管理 → 基本信息」里的站点地址）拼成完整域名；`siteUrl` 为空时后台只显示纯文本、不给坏链接。后台也补了自己的 404 页，不会再露出后端的 `{error:404}` |
| `/author/<标识>/` 打不开，文章页顶部的作者名点不动 | Hugo 不读主题里的 `[taxonomies]`：作者分类法必须在**站点**的 `hugo.toml` 声明（`[taxonomies] author = "author"`，`create:site` 生成的模板已带）。老站点补这一句后，在后台把文章重存一次即可 —— 保存时会自动补 `author:`（缺省取 `defaultAuthor`），front matter 里没这个键就不会生成作者页 |
| 装完主题觉得「跟没装一样」 | 主题自带**结构性**默认 `data/`（导航、首页布局、时刻页、SEO、工具清单、以及一份全空的 site.json），空站点也有导航和排版；站点自己的 `data/*.json` 按键覆盖主题默认、数组整份替换。带文字的占位（关于页、工坊、页脚版权与备案占位、作者表、示例友链）放在 `exampleSite/data/` —— 那是新建站点照抄的样板，不会跑到已有站点的页脚上去。另：站点没写 `data/nav.json` 却配了 `menus.*.toml` 时**菜单优先**，主题默认导航不抢别人的站 |
| 后台「前端管理 → 主题配置文件」显示读取不到 | 站点通常没有自己的 `config/_default/params.toml`。这种情形现在会把主题那份全量注释模板载入编辑器，改完保存就在你站点里建出这份文件；`create:site` 也会预先复制好一份 |
| 页面里用了 `{{< figure >}}` 就整站构建失败：`wrong number of args for return` | 已修（主题 `partials/shortcodes/safe-url.html`）：`return` 只能出现在模板体顶层，写进 `if` 分支会被 Hugo 当成一个叫 return 的函数去数参数。主题用 `hugo` 本地构建一遍即可复现 |

---

## 11. 上线后待办

- [ ] 后台「设置」逐项确认：站点信息、语言、评论与点赞开关、订阅双重确认、头像模板、SEO 默认值
- [ ] `zero-site` 里 `params.apiBaseURL` 指向正式 worker 地址（自定义域名更好）。`pnpm create:site` 生成的仓库写在根 `hugo.toml`，本仓库自带的示例站在 `config/_default/params.toml` —— 两处都只有这一个键，留空 = 整站退回纯静态（不加载评论组件、不发任何请求）
- [ ] 后台「设置」填 `siteUrl`（前台正式域名）与 `mediaPublicUrl`（同一个 API 地址），并把前台域名加进 `ALLOWED_ORIGINS` 后 `pnpm deploy:api`
- [ ] 前台页面验证评论、点赞、订阅、时刻、友链与统计埋点
- [ ] 停用 Waline / Twikoo 的旧部署与 CDN 引用
- [ ] 需要监控时把 `/api/health` 加进 Uptime 检查
- [ ] 备份：后台「备份」→「存档到 R2」出一份全站备份（内容与配置都在里面），再 `npx wrangler d1 export zero-db --remote --file=backup.sql` 存一份裸库

---

## 12. 免费额度测算

额度按 Cloudflare 官方 2026-10 的 Free plan 页面取值，配额在 UTC 零点重置：

| 资源 | 免费额度 |
|---|---|
| Workers 请求 | 100,000 次/天（10ms CPU/次，突发 1,000 次/分钟） |
| D1 行读取 | 5,000,000 行/天 |
| D1 行写入 | 100,000 行/天 |
| D1 存储 | 5 GB/账户 |
| KV | 读 100,000 次/天；写/删/列表各 1,000 次/天；1 GB |
| R2 | 10 GB·月；A 类操作 100 万/月；B 类 1,000 万/月 |
| Queues | 10,000 次操作/天，消息保留 24 小时 |
| Pages | 静态请求不限量且不占 Workers 额度；构建 500 次/月、1 并发；Functions 计入 Workers 额度 |
| 发信 | Resend 免费档 100 封/天、3,000 封/月（自建 SMTP 按服务商自己的上限） |

### 12.1 一次访问的成本

按本地实测：一篇文章页面加载打 4 个 API（`/api/config`、`/api/auth/me`、`/api/authors`、`/api/reactions`），
停留时长按平均 264 秒计。

| | 削减前 | 现在 |
|---|---|---|
| Workers 请求/访问 | 1 + 264/30 ≈ 9.8 | 2（进入记一次 + 离开结算一次） |
| D1 行写入/访问 | 1 明细 + 1 计数器 + 8.8 次心跳累加 ≈ 10.8 | 1 明细 + 1 结算 + 新访客才有 1 注册 ≈ 2–3 |
| KV 写入/访问 | 新访客 1 次注册写 | 0（注册表进了 D1） |

### 12.2 目标负载下的日用量

假设 日 5,000 访问 / 100 条评论 / 100 封邮件 / 100 个订阅者：

| 项目 | 估算日用量 | 占免费额度 |
|---|---|---|
| Workers 请求 | 统计 1 万 + 页面 2 万 + 评论与点赞读写 ≈ 3.2 万 | 32% |
| D1 行写入 | 访问 1.5 万 + 评论/邮件/任务/审计 ≈ 5 千 + Cron ≈ 1 千 ≈ 2.1 万 | 21% |
| D1 行读取 | 每次访问约 2 行 + 后台统计（60 秒内重复打开不重扫）≈ 数十万 | <10% |
| KV 写入 | 邮件模板缓存、推送位点、验证码状态 ≈ 个位到几十 | <5% |
| Queues | 100 封 × 入队+消费 ≈ 200 次 | 2% |
| Pages 构建 | 定时任务只在内容真变化时构建，通常 0–2 次/天 | <15%/月 |
| 发信 | 100 封/天是 Resend 免费档的硬上限 | 100%，由额度闸门兜住 |

### 12.3 这一版为了额度做了哪些取舍

- **停留时长改在本地累加**：`[analytics].beat_seconds`（默认 300）现在是「页面一直开着不切走时最久多久补报一次」的上限，
  正常访问只在切后台或关页面时结算一次。想彻底不记停留时长，把后台「访问统计」关掉（`analyticsEnabled = false`），
  连进入页面的记录也不发。
- **访客注册表从 KV 迁到 D1 `visitor_keys`**：KV 免费只有 1,000 次写/天，访客一多先打爆的是它；
  D1 走 `insert or ignore`，老访客一行都不改，只有真新访客产生一次行写入。
- **累计计数器批量落库**：增量先攒在 isolate 内存，攒够 100 或隔 5 分钟写一次 `site_config`，
  所以「总访问量」最多滞后不足一批；每天 Cron 会把内存里的零头结算落库。
  要把计数器重新校准，删掉 `site_config` 里的 `stats.totalViews` / `stats.totalVisitors`，
  下一次读取会用明细表与注册表现算一次基线。
- **后台统计不再全表扫描**：`totalViews` / `totalVisitors` 读计数器而不是 `count(*) from visits`，
  概览/趋势/设备/排行四个接口在 isolate 内缓存 60 秒。留存期越长明细表越大，这条对读额度越关键。
- **定时任务记账一行搞定**：`job_runs` 由「先插 running 再更新结果」改成跑完写一行，仪表盘看到的还是同一份结果。
- **仓库写回去重**：内容与仓库里现有的一致时不提交、也不算「有改动」，
  `data/poststats.json` 与友链两个 data 文件都不再带每次必变的时间戳字段，
  一轮 Cron 无论写几个文件都只触发一次 Pages 构建。
- **发信额度闸门**：设置里的「每日发信上限」（`emailDailyLimit`，默认 100，0 = 不限制）按 UTC 日界统计 `email_logs`。
  群发与订阅推送在启动前先算一次额度，不够就**整批不发**，任务留在队列里等第二天的 Cron 自动续跑 ——
  半途而废会重发已经收到过的人，所以宁可整批延后。验证码、新评论提醒这类单封信额度过小时照样发，
  由服务商报错，不替站点把用户的正常流程挡掉。
