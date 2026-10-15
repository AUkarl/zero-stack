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
- **统计**：按 IP 去重的 PV / UV、累计访客、热门页面、来源与设备，可导出 CSV。
- **后台**：文章结构化编辑（含短代码面板、封面从媒体库选、本地暂存 + 批量保存到 Git）、
  媒体多桶上传、评论 / 投稿 / 认证 / 注销四类审核、用户组与权限、邀请码、站点设置、
  前端管理（导航 / 首页 / 页脚 / 关于 / 工坊 / 时刻 / SEO 七个子页写进 `data/*.json`）、
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
- **R2**：后台上传的媒体对象，多桶配置，可挂自定义域名直链。
- **KV**：`CACHE` 存只读热点（文章列表等），`SESSION` 存会话与滑动限流计数。
- **Queue**：`zero-email` 异步出站邮件，最多重试 3 次。
- **Git**：文章与时刻 Markdown、作者表 `data/authors.yaml`、友链数据 `data/links.yaml`、
  前端参数 `data/*.json` —— 后台写的都是这些文件，静态站点仍由 Hugo 构建。

## 环境要求

| 依赖 | 版本 | 校验 |
| --- | --- | --- |
| Node.js | ≥ 22（wrangler 4.149+ 的要求，仓库 `engines` 已锁） | `node -v` |
| pnpm | ≥ 9（workspace 协议必需，npm / yarn 装不上） | `pnpm -v` |
| Hugo | extended，本地已验证 0.165.0；主题 `min_version = 0.128.0` | `hugo version` 必须带 `+extended` |
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

`wrangler.jsonc` 与 `.dev.vars` 都被 gitignore，仓库只提供 `.example`。
本地要改的一般只有 `name`（避免和线上 worker 撞名）与 `vars.SITE_URL`。

### 2. 起 API 并建库

```bash
pnpm dev:api                 # http://127.0.0.1:8787
pnpm db:migrate:local        # 在另一个终端执行，应用 migrations/0000…0010
```

迁移必须在 `packages/api` 目录下由 wrangler 执行（`pnpm db:migrate:local` 已经帮你切好目录，
在仓库根直接 `npx wrangler d1 execute` 会报 `Couldn't find a D1 DB with the name 'zero-db'`）。

### 3. 起后台

```bash
pnpm dev:cms                 # http://127.0.0.1:5173，/api 由 vite 代理到 8787
```

后台登录页的 API 地址留空即可（同源代理，Cookie 不会被浏览器当成跨站丢掉）。

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

### 5. 两个本地替身（可选，但要测「回写」就得开）

```bash
pnpm repo:bridge       # 127.0.0.1:8792：把后台的 Git 写入落到本地站点目录
pnpm mock:translate    # 127.0.0.1:8791：假的翻译服务，用来验证整篇翻译链路
```

`GIT_LOCAL_DIR` 指向站点目录时，后台的文章 / 时刻 / 作者表 / 友链文件都直接写文件，
不碰 GitHub；线上**不要**设 `GIT_LOCAL_DIR`。同一件事在线上的路径是
「fine-grained PAT（`Contents: write`）提交 → Pages 构建 Hook 重建」，
代码里两条路径都在 `packages/api/src/services/repo.ts`，行为一致。

### 6. 冒烟测试（71 项）

```bash
bash scripts/smoke.sh                                   # 公开接口 + 「未登录必须 401」守卫
ADMIN_COOKIE='zero_session=…' bash scripts/smoke.sh     # 追加后台接口
```

`ADMIN_COOKIE` 从浏览器登录后台后复制。脚本不写库、不删数据，
匿名评论那条结尾自己用 `ownerKey` 删掉。全绿输出是 `通过 71 / 失败 0`。

### 7. 端口一览

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
pnpm setup                     # 交互式：登录检查 → 建 / 复用 D1、R2、KV、Queue → 渲染 wrangler.jsonc
                               #           → 写 secrets → 应用远程迁移 → 部署 API 与后台
pnpm setup -- --no-deploy      # 只准备资源与配置，不部署
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
   然后在后台「设置 → 内容仓库」填 `owner / repo / branch / 各目录 / 友链文件 /
   写回开关 / Pages 重建 Hook`。

8. **GitHub Actions 部署**：把 `docs/deploy-template.yml` 复制成 `zero-site` 仓库的
   `.github/workflows/deploy.yml`，替换里面的站点名、D1 / Pages 项目 id 与 `CF_*` secrets 名称。

## 站点侧还差一步（**很容易漏**）

`apiBaseURL` 只在开发环境参数里给了本地地址。**生产构建不会带上它，前台就是一片纯静态**
（没有评论、没有点赞、没有运行期接管）。上线要做的二选一：

- 建 `me/zero-site/config/production/params.toml` 写 `apiBaseURL = "https://api.你的域名"`；或
- 直接在站点 `config/_default/params.toml` 写死线上地址（本地联调时靠 `config/development/` 覆盖回 8787）。

> 别用环境变量 `HUGO_PARAMS_APIBASEURL=…` 覆盖：Hugo 会把参数名小写成 `apibaseurl`，
> 而主题读的是 `params.apiBaseURL`，看着进了 `hugo config` 实际渲染不出任何东西。

---

# 三、上线后的配置教程（按这个顺序做）

1. **建第一个账号** —— 它就是站长 / `admin`。后台登录页**只有登录没有注册**，所以先调一次接口：
   `curl -X POST https://<worker 地址>/api/auth/register -H 'Content-Type: application/json' --data-binary '{"email":"你@域名","password":"至少 8 位","name":"站长"}'`
   （前台 `apiBaseURL` 已配好时，在 `/account/` 注册同一个账号也一样）。回 `role: "admin"` 就说明建好了，
   回后台用这个邮箱密码登录即可。之后在「设置 → 注册与邀请码」里
   按需关闭注册、打开邀请码（随机码在「用户」页生成，可设可用次数与有效期）。
2. **基本信息**（前端管理 → 基本信息）：站点名、Logo、Favicon、导航项、社交链接 ——
   写进 `data/*.json`，一处改全站生效（标题、RSS、落地页、404 都读它）。
3. **发信方式**（设置）：选 SMTP / Resend / Cloudflare，填发件邮箱与授权码，
   页面按通道分节显示，没选的通道不会出现。先用那一节的「发一封测试信」验证，
   再用「邮件模板」的预览确认正文。每日上限是给免费档留余量的：额度不够时群发与订阅推送
   整批不发，第二天自动续跑。
4. **评论**（设置 → 评论）：文章评论区选 `zero` 就是自建评论；选第三方时前台会在 60 秒内自动接管，
   不用重新构建。要不要游客评论、是否需要审核、嵌套层数、每小时限流都在这里。
   广告拦截在「评论审核」：命中正则进待审、可维护正则文件、也能接第三方审核服务。
5. **点赞与收藏**（设置 → 点赞与收藏）：两个开关 + 是否允许游客（按设备指纹去重）。
6. **时刻页**（前端管理 → 时刻页）：卡片模式、每页条数、评论区用哪套系统；
   内容走 Git 发布，见「时刻」页。
7. **友链**（设置 → 友情链接 + 后台「友情链接」页）：开关联动导航项与 `/links/` 整页，
   在线申请与站点联盟分组、失联阈值（默认 30 天不可访问 / 90 天无动态）都在这。
   新增 / 改名 / 换组 / 删除都会同步 `data/links.yaml`，接口把结果放在 `linksFile` 里带回，
   写不回时页面会明说原因（前台那两个板块是构建期读这份 yaml 渲染的）。
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
    想不统计自己可以在「设置」里排除。导出 CSV。
13. **备份**（后台「备份」）：一键导出 D1（评论 / 订阅 / 用户 / 友链 / 统计）成 JSON，
    也能导入恢复。导出文件含邮箱等个人信息，属敏感数据，别提交进仓库。

---

# 四、后台页面地图

| 路径 | 干什么 |
| --- | --- |
| `/login` | 管理员登录；API 地址优先取这里填的，其次取构建时内置的值，本地开发两者都不填走同源代理。按登录方式可能要动态码或邮箱验证码 |
| `/` | 仪表盘：待办数量、最近评论 / 申请 / 任务、快捷入口 |
| `/stats` | 访问统计：趋势、热门页面、来源、设备、CSV 导出 |
| `/content` | 文章结构化编辑：字段 + 正文 + 短代码面板 + 封面选图、本地暂存与「保存到 Git（N）」批量推送、删除会连构建产物一起清 |
| `/moments` | 时刻发布与编辑（Git 里的 Markdown） |
| `/media` | 媒体库：多桶浏览、上传、复制绝对地址 |
| `/comments` | 评论管理：搜索、审核、删除（连带子树）、按文章聚合 |
| `/spam` | 评论审核：正则规则文件、命中记录、第三方审核服务配置 |
| `/friends` | 友情链接 + 待审申请两个 tab：分组、排序、失联阈值、同步 `data/links.yaml` |
| `/users` | 用户与邀请码：权限勾选（投稿 / 认证）、封禁、重置密码、删除账号（级联清理） |
| `/drafts` | 投稿审核：编辑、直接发布进仓库、驳回并邮件通知 |
| `/author-verify` | 作者认证申请：通过后写 `data/authors.yaml`，自动进「共创」组 |
| `/subscribers` | 订阅者：状态、确认时间、导出 |
| `/broadcast` | 邮件群发：任务列表、分批发送、失败重发、每日上限提示 |
| `/frontend` | 前端管理七个子页（基本信息 / 导航栏 / 首页 / 页脚 / 关于页 / 工坊 / 时刻页）+ SEO，共用一个保存按钮，可选择同时请求重建 |
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

Cron 与队列消费者没有 HTTP 入口，走 `scheduled` / `queue` 事件。

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

日常备份用后台「备份」页导出 JSON，恢复也是同一页导入。

---

# 七、免费额度与写入削减

Cloudflare 免费档的量是硬约束，这套代码刻意做了这些收敛：

- **统计**：按 IP 去重 + 会话键缓存，同一次浏览不重复写 D1；累计访客单独存计数。
- **配置**：只读热点进 KV（60 秒），`/api/config` 不打 D1。
- **前台请求**：`/api/auth/me` 全站只问一次（主题侧共用同一在途请求），`/api/config` 同理。
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
| `pnpm setup` | 交互式部署向导（资源 → 配置 → 密钥 → 迁移 → 发布），`-- --no-deploy` 只准备资源 |
| `pnpm deploy:api` | 同步 D1 迁移并部署 Worker，`-- --no-migrate` / `-- --dry-run` / `-- --local` |
| `pnpm deploy:cms` | 构建后台并部署 Pages，`-- --api <worker 地址>` / `-- --no-build` / `-- --project <名称>` |
| `pnpm create:site` | 生成私密的 `zero-site` 内容仓库骨架（含 CI 与 submodule） |
| `pnpm migrate:waline` | Waline / Twikoo 导出 → D1 评论表 |
| `pnpm dev:api` / `pnpm dev:cms` | 本地开发（8787 / 5173） |
| `pnpm repo:bridge` / `pnpm mock:translate` | 本地回写替身（8792）/ 翻译替身（8791） |
| `pnpm build:comment` | 产出 `packages/comment/dist/zero-comment.js`，再由主题 `scripts/sync-comment.mjs` 复制过去 |
| `pnpm db:migrate:local` / `:remote` | 单独应用迁移 |
| `pnpm check` | `typecheck:scripts` → `-r typecheck` → `-r build`，与 `ci.yml` 一致 |
| `bash scripts/smoke.sh` | 接口冒烟（71 项），带 `ADMIN_COOKIE` 时追加后台用例 |

更细的生产步骤、故障排查与 GitHub Actions 模板见 **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

## 许可证

MIT。第三方依赖各自的许可证见各包的 `package.json`。
