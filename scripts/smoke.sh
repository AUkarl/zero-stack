#!/usr/bin/env bash
# ============================================================
# smoke.sh — 接口冒烟测试
# ------------------------------------------------------------
# 用法：
#   bash scripts/smoke.sh                                  # 只跑公开接口与「未登录必须 401」的守卫检查
#   API=http://127.0.0.1:8787 bash scripts/smoke.sh
#   ADMIN_COOKIE='zero_session=xxx' bash scripts/smoke.sh  # 追加跑需要管理员的接口
#
# 取 ADMIN_COOKIE：浏览器登录后台后，开发者工具里复制 zero_session 的值。
# 匿名那一档不写库、不删数据；匿名评论那条会在结尾自己删掉（靠 ownerKey）。
# 给了 ADMIN_COOKIE 时多两步真写入：建一篇临时文章（点赞收藏要有真文章可点），
# 结尾用 DELETE /api/admin/content/file 删掉它（带 build=0，不请求站点重建）。
# ============================================================
set -uo pipefail

API="${API:-http://127.0.0.1:8787}"
ADMIN_COOKIE="${ADMIN_COOKIE:-}"
PASS=0
FAIL=0
SKIP=0
SKIPPED=()
FAILED=()
BODY_TEXT=''
# 匿名评论落在静态页 /links/：文章/时刻的评论现在会核对仓库里的文件，脚本不能再用随机假 slug。
# 同一 IP 对 /links/ 的评论仍受后台 commentRateLimit 限制（默认 10 条/小时）。
SMOKE_SLUG="/links/"
# 点赞/收藏要文章在站上真的存在（接口会去仓库核对），所以有后台 Cookie 时先建一篇临时文章，
# 结尾删掉；没有 Cookie 就只能退回示例站那篇 /posts/nowork/，它不在就跳过（见下面那一节）。
SMOKE_POST_PATH=""
REACT_SLUG="/posts/nowork/"

# 每次跑用一个新的合成来源 IP：本机 wrangler dev 里所有请求的 IP 都是 127.0.0.1，而
# 匿名评论有一条「同 IP 突发 2 条 / 5 分钟」的限流，连跑两遍冒烟第二遍就会成片 429。
# 线上不用管这一条 —— Cloudflare 边缘会把客户端自带的 cf-connecting-ip 直接覆盖掉。
SMOKE_IP="198.51.100.$(( (RANDOM % 250) + 1 ))"

CURL=(curl -sS --max-time 20 -H 'accept: application/json' -H "cf-connecting-ip: $SMOKE_IP" -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36')

req() {
  local method="$1" path="$2" expect="$3" data="${4:-}" label="${5:-}" cookie="${6:-}"
  local args=("${CURL[@]}" -X "$method" "$API$path")
  [ -n "$data" ] && args+=(-H 'content-type: application/json' -d "$data")
  [ -n "$cookie" ] && args+=(-H "cookie: $cookie")
  local out code
  out="$("${args[@]}" -w $'\n%{http_code}' 2>/dev/null)"
  code="${out##*$'\n'}"
  BODY_TEXT="${out%$'\n'*}"
  local name="${label:-$method $path}" ok=false a
  local IFS=','
  for a in $expect; do [ "$a" = "$code" ] && ok=true; done
  unset IFS
  if $ok; then
    PASS=$((PASS + 1))
    printf '  \033[32m✓\033[0m %-56s %s\n' "$name" "$code"
  else
    FAIL=$((FAIL + 1))
    FAILED+=("$name -> 期望 $expect 实际 $code: $(printf '%s' "$BODY_TEXT" | head -c 160)")
    printf '  \033[31m✗\033[0m %-56s %s (期望 %s)\n' "$name" "$code" "$expect"
  fi
}

# json_get <key> — 整包 JSON 从 stdin 喂进来，出来的是那个 key 的字符串/数字值（取不到就给空，由调用方判「跳过」）。
#
# 为什么不用 sed：以前这里抠的是 sed -n 's/.*"key":"\([^"]*\)".*/\1/p'，开头那个 .* 是贪婪的，
# 会把「这个 key 后面的整包内容」一起吞进来 —— 回包里只要有带转义引号的值（出厂的 commentEmojiPacks
# 就是一串 emoji，值里带双引号），抠出来就是脏的；更怪的是脏不脏还取决于 locale：Git Bash 默认 locale 下
# 吞一大串，同一行前面加 LC_ALL=C 就正好。站长按 README 跑冒烟看到的那条「头像图床没生效」的红就是这么
# 来的，不是产品坏。仓库本来就要求 node ≥ 20，所以这里直接让 node 解析。
json_get() {
  local key="$1"
  node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      let v;
      try {
        v = pick(JSON.parse(raw), process.argv[1]);
      } catch {
        v = undefined;
      }
      if (typeof v === "string" || typeof v === "number") process.stdout.write(String(v));
    });
    function pick(o, want) {
      if (!o || typeof o !== "object") return undefined;
      for (const k of Object.keys(o)) {
        const val = o[k];
        if (k === want && (typeof val === "string" || typeof val === "number")) return val;
      }
      for (const k of Object.keys(o)) {
        const hit = pick(o[k], want);
        if (hit !== undefined) return hit;
      }
      return undefined;
    }
  ' "$key"
}

# 老的 field() 走的是同一条贪婪 sed，一起接到 json_get 上（调用点不变）。
field() { printf '%s' "$BODY_TEXT" | json_get "$1"; }
section() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
# 跳过：这条需要脚本拿不到的条件（没后台 Cookie、没配图床），既不算通过也不算失败。
# 冒烟脚本的目的是「真问题报红」，把没法判定的情形硬算成失败会让人直接忽略整个输出。
skip() { SKIP=$((SKIP + 1)); SKIPPED+=("$1 <- $2"); printf '  \033[33m•\033[0m %-56s \033[33m跳过：%s\033[0m\n' "$1" "$2"; }

# ---------------------------------------------------------------- 公开接口
section '公开：配置与内容'
req GET /api/health 200 '' '健康检查'
req GET /api/config 200 '' '运行时公开配置'
printf '%s' "$BODY_TEXT" | grep -q '"commentEmojiPacks"' \
  && { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '公开配置含 commentEmojiPacks（表情包）'; } \
  || { FAIL=$((FAIL + 1)); FAILED+=('公开配置缺 commentEmojiPacks'); printf '  \033[31m✗\033[0m %-56s\n' '公开配置含 commentEmojiPacks（表情包）'; }
printf '%s' "$BODY_TEXT" | grep -q '"commentShowMeta"' \
  && { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '公开配置含 commentShowMeta（属地/设备开关）'; } \
  || { FAIL=$((FAIL + 1)); FAILED+=('公开配置缺 commentShowMeta'); printf '  \033[31m✗\033[0m %-56s\n' '公开配置含 commentShowMeta'; }
req GET /api/auth/init-status 200 '' '初始化状态'
printf '%s' "$BODY_TEXT" | grep -q '"pending"' \
  && { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '初始化状态含 pending 字段'; } \
  || { FAIL=$((FAIL + 1)); FAILED+=('初始化状态缺 pending 字段'); printf '  \033[31m✗\033[0m %-56s\n' '初始化状态含 pending 字段'; }
req GET /api/comments/posts/nowork?depth=2 200 '' '文章评论列表（ASCII slug）'
req GET '/api/comments/posts/%E7%9F%A5%E6%AD%A2' 200 '' '文章评论列表（中文 slug 解码一致）'
req GET /api/moments 200 '' '时刻接口不再返回 D1 内容'
req GET /api/authors?ids=zhizhi 200 '' '作者卡片公开接口'
req GET /api/friends 200 '' '友链列表'
req GET /api/subscribe/status?email=nobody@example.invalid 200,400,404 '' '订阅状态查询'

# ---------------------------------------------------------------- 匿名评论闭环
section '匿名评论：邮箱必填 → 掩码 → 属地设备 → 点赞 → 自删'
req POST /api/comments 200 "{\"postSlug\":\"$SMOKE_SLUG\",\"content\":\"冒烟测试：匿名评论（会自动删除）\",\"email\":\"zhangsan@qq.com\"}" '匿名提交（只给邮箱）'
SMOKE_ID="$(field id)"
OWNER_KEY="$(field ownerKey)"
SUBMIT_BODY="$BODY_TEXT"
[ -n "$SMOKE_ID" ] && { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s %s\n' '拿到评论 id' "${SMOKE_ID:0:12}…"; } \
  || { FAIL=$((FAIL + 1)); FAILED+=("匿名评论未返回 id: $SUBMIT_BODY"); printf '  \033[31m✗\033[0m %-56s\n' '拿到评论 id'; }
[ -n "$OWNER_KEY" ] && { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '拿到 ownerKey（自删凭证）'; } \
  || { FAIL=$((FAIL + 1)); FAILED+=('响应缺 ownerKey'); printf '  \033[31m✗\033[0m %-56s\n' '拿到 ownerKey（自删凭证）'; }
printf '%s' "$SUBMIT_BODY" | grep -qF 'z***@qq.com' \
  && { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '昵称按邮箱掩码 z***@qq.com'; } \
  || { FAIL=$((FAIL + 1)); FAILED+=("昵称未按邮箱掩码: $SUBMIT_BODY"); printf '  \033[31m✗\033[0m %-56s\n' '昵称按邮箱掩码 z***@qq.com'; }
printf '%s' "$SUBMIT_BODY" | grep -qE '"browser":"(Chrome|Firefox|Safari|Edge|Opera)"' \
  && { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '评论带浏览器/系统/设备信息'; } \
  || { FAIL=$((FAIL + 1)); FAILED+=("评论缺浏览器信息: $SUBMIT_BODY"); printf '  \033[31m✗\033[0m %-56s\n' '评论带浏览器/系统/设备信息'; }
# 头像：内置链第一级是 Gravatar、第二级是 Cravatar（同一个邮箱 MD5），
# 后台「头像与媒体」填了 avatarTemplate 才会把模板顶到第一级。
# 所以匿名模式能验的不变量是「这两档是同一个 hash 的逐级退化」；
# 拿不到模板就没法判「按站点自己配的图床走」这种情况 —— 那种跳过，不判成失败。
AVATAR_URL=$(printf '%s' "$SUBMIT_BODY" | json_get avatar)
AVATAR_MD5=$(printf '%s' "$AVATAR_URL" | sed -n 's|.*/avatar/\([0-9a-f]\{32\}\).*|\1|p')
GRAVATAR_URL=$(printf '%s' "$SUBMIT_BODY" | json_get gravatar)
if printf '%s' "$AVATAR_URL" | grep -qE '^https://www\.gravatar\.com/avatar/[0-9a-f]{32}\?' \
  && printf '%s' "$GRAVATAR_URL" | grep -qF "avatar/$AVATAR_MD5" \
  && printf '%s' "$GRAVATAR_URL" | grep -qE '^https://cravatar\.cn/'; then
  PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '邮箱头像走 Gravatar→Cravatar 同一 hash 逐级退化'
elif [ -n "$ADMIN_COOKIE" ]; then
  # 有后台就读 avatarTemplate：填了就必须以它为准（等于整条链换图床）
  TPL=$(curl -sS --max-time 20 -H "cookie: $ADMIN_COOKIE" -H 'accept: application/json' "$API/api/admin/config" \
    | json_get avatarTemplate)
  TPL_HEAD=$(printf '%s' "$TPL" | sed 's/{.*$//')
  if [ -z "$TPL" ]; then
    skip '邮箱头像走后台配置的图床' "后台没配 avatarTemplate，而这条拿到的不是内置链（avatar=${AVATAR_URL:-空}）"
  elif printf '%s' "$AVATAR_URL" | grep -qF "$TPL_HEAD"; then
    PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' "邮箱头像走后台配置的图床（$(printf '%s' "$TPL_HEAD" | cut -d/ -f3)）"
  else
    FAIL=$((FAIL + 1)); FAILED+=("avatarTemplate 已配但没生效：模板 $TPL / 实际 $AVATAR_URL"); printf '  \033[31m✗\033[0m %-56s\n' '邮箱头像走后台配置的图床'
  fi
else
  skip '邮箱头像走后台配置的图床' "匿名模式读不到 avatarTemplate（当前 avatar=${AVATAR_URL:-空}）"
fi

req POST /api/comments 400 "{\"postSlug\":\"${SMOKE_SLUG}noemail/\",\"content\":\"缺邮箱必须被拒\"}" '缺邮箱 → 400'
req POST /api/comments 400 "{\"postSlug\":\"${SMOKE_SLUG}badmail/\",\"content\":\"邮箱格式错\",\"email\":\"not-a-mail\"}" '邮箱格式错 → 400'
req GET "/api/comments${SMOKE_SLUG%/}?owners=%7B%22${SMOKE_ID}%22%3A%22${OWNER_KEY}%22%7D&depth=6" 200 '' '带 ownerKey 能看见自己的待审评论'
printf '%s' "$BODY_TEXT" | grep -Eq '"ipHash":|"ip_hash":' \
  && { FAIL=$((FAIL + 1)); FAILED+=('评论响应泄漏了 ipHash'); printf '  \033[31m✗\033[0m %-56s\n' '评论响应不含 ipHash'; } \
  || { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '评论响应不外泄 ipHash/明文邮箱'; }

if [ -n "$SMOKE_ID" ]; then
  req POST "/api/comments/$SMOKE_ID/like" 200,404 '' '评论点赞（待审时拒绝也算通过）'
  req PATCH "/api/comments/$SMOKE_ID?owner=$OWNER_KEY" 200 "{\"content\":\"冒烟测试：已编辑 $OWNER_KEY\",\"ownerKey\":\"$OWNER_KEY\"}" '匿名编辑自己的评论'
  req DELETE "/api/comments/$SMOKE_ID?owner=$OWNER_KEY" 200 '' '匿名自删（ownerKey 生效）'
  req DELETE "/api/comments/$SMOKE_ID?owner=wrong-key" 401,403,404 '' '错误凭证不能删除'
fi

# ---------------------------------------------------------------- 点赞与收藏
section '反应：点赞与收藏'
# 这两个接口会去内容仓库核对「这篇在不在」（不在就 404，防止给任意地址刷计数），
# 所以点赞收藏要有真文章可点。有后台 Cookie 就先建一篇临时文章、结尾删掉；
# 匿名模式建不出来，这三项只能跳过 —— 新站上没有 /posts/nowork/，以前每轮必红 3 项，
# 看着像功能坏了，其实是脚本自己的假设。
if [ -n "$ADMIN_COOKIE" ]; then
  SMOKE_POST_PATH="content/zh/posts/smoke-$(date +%s)-$((10000+RANDOM)).md"
  SMOKE_POST_TITLE="${SMOKE_POST_PATH##*/}"; SMOKE_POST_TITLE="${SMOKE_POST_TITLE%.md}"
  req POST /api/admin/content/batch 200 \
    "{\"files\":[{\"path\":\"$SMOKE_POST_PATH\",\"content\":\"---\\ntitle: \\\"$SMOKE_POST_TITLE\\\"\\ndate: \\\"$(date +%Y-%m-%dT%H:%M:%S+08:00)\\\"\\ndraft: false\\n---\\n\\n冒烟测试临时文章，跑完即删。\\n\"}],\"triggerBuild\":false}" \
    '建临时文章（点赞收藏要有真文章可点）' "$ADMIN_COOKIE"
  REACT_SLUG="/posts/${SMOKE_POST_TITLE}/"
  req POST /api/reactions 200 "{\"slug\":\"$REACT_SLUG\",\"kind\":\"like\"}" '匿名点赞（toggle）'
  req POST /api/reactions 200,403 "{\"slug\":\"$REACT_SLUG\",\"kind\":\"star\"}" '匿名收藏（关掉则 403）'
  req GET "/api/reactions?slugs=${REACT_SLUG}&kind=like" 200 '' '计数查询'
else
  skip '匿名点赞（toggle）' '没有 ADMIN_COOKIE，建不出临时文章'
  skip '匿名收藏（关掉则 403）' '没有 ADMIN_COOKIE，建不出临时文章'
  skip '计数查询' '没有 ADMIN_COOKIE，建不出临时文章'
fi

# ---------------------------------------------------------------- 守卫：未登录必须 401
section '守卫：管理员接口未登录必须 401'
for p in /api/admin/config /api/admin/content /api/admin/users /api/admin/subscribers \
         /api/admin/posts /api/admin/media/buckets /api/admin/broadcast/jobs \
         /api/admin/spam/pattern-file /api/admin/deletions /api/account/overview /api/security; do
  req GET "$p" 401 '' "401 $p"
done

# ---------------------------------------------------------------- 管理员（需要 ADMIN_COOKIE）
if [ -n "$ADMIN_COOKIE" ]; then
  section '管理员：内容与时刻'
  req GET '/api/admin/content?path=content/zh/posts' 200 '' '文章目录列表' "$ADMIN_COOKIE"
  req GET '/api/admin/content/file?path=content/zh/posts/nowork.md' 200 '' '读单篇文章' "$ADMIN_COOKIE"
  req GET '/api/admin/posts' 200 '' '已发布文章下拉数据' "$ADMIN_COOKIE"
  req PUT /api/admin/content/file 200 '{"path":"content/zh/posts/zz-smoke-tmp.md","front":{"title":"smoke tmp title","date":"2026-01-01T00:00:00Z","draft":true},"body":"smoke body","message":"smoke"}' '结构化发布文章（写本地仓库）' "$ADMIN_COOKIE"
  req GET '/api/admin/content/file?path=content/zh/posts/zz-smoke-tmp.md' 200 '' '读回刚发布的文章' "$ADMIN_COOKIE"
  printf '%s' "$BODY_TEXT" | grep -qF '"exists":true' \
    && { PASS=$((PASS + 1)); printf '  [32m✓[0m %-56s\n' '刚发布的文章能读回并带 front'; } \
    || { FAIL=$((FAIL + 1)); FAILED+=('刚发布的文章读不回'); printf '  [31m✗[0m %-56s\n' '刚发布的文章能读回并带 front'; }
  req DELETE '/api/admin/content/file?path=content/zh/posts/zz-smoke-tmp.md' 200 '' '删除冒烟临时文章' "$ADMIN_COOKIE"
  # 中文（还有 emoji）走一遍「写进仓库 → 再读回来」：base64 解码口径错了就是乱码，
  # 而乱码存回去会一层层叠加，比构建失败更难查
  SMOKE_UTF8_BODY="$(pwd)/.smoke-utf8-body.json"
  # 请求体走文件而不是命令行参数：和上面批量推送那项同一套写法，Windows 下少一层命令行编码转换
  cat > "$SMOKE_UTF8_BODY" <<'SMOKE_UTF8_JSON'
{"path":"content/zh/posts/zz-smoke-utf8.md","front":{"title":"中文标题自测","date":"2026-01-03T00:00:00+08:00","draft":true},"body":"但行好事，莫问前程 🎂","message":"smoke"}
SMOKE_UTF8_JSON
  req PUT /api/admin/content/file 200 "@$SMOKE_UTF8_BODY" '发布一篇中文文章' "$ADMIN_COOKIE"
  rm -f "$SMOKE_UTF8_BODY"
  req GET '/api/admin/content/file?path=content/zh/posts/zz-smoke-utf8.md' 200 '' '读回那篇中文文章' "$ADMIN_COOKIE"
  printf '%s' "$BODY_TEXT" | grep -qF '中文标题自测' \
    && { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '中文标题原样读回（没有二次编码）'; } \
    || { FAIL=$((FAIL + 1)); FAILED+=('中文标题读回变成乱码'); printf '  \033[31m✗\033[0m %-56s\n' '中文标题原样读回（没有二次编码）'; }
  printf '%s' "$BODY_TEXT" | grep -qF '莫问前程' \
    && { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '正文原样读回（标题与正文一起走一遍）'; } \
    || { FAIL=$((FAIL + 1)); FAILED+=('正文读回不一致'); printf '  \033[31m✗\033[0m %-56s\n' '正文原样读回（标题与正文一起走一遍）'; }
  req DELETE '/api/admin/content/file?path=content/zh/posts/zz-smoke-utf8.md' 200 '' '删除中文自测文章' "$ADMIN_COOKIE"
  req GET '/api/admin/repo/files' 200 '' '可编辑的仓库文件清单' "$ADMIN_COOKIE"
  printf '%s' "$BODY_TEXT" | grep -qF 'links.yaml' \
    && { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '清单里的友链文件与写入用的是同一个路径'; } \
    || { FAIL=$((FAIL + 1)); FAILED+=('repo/files 缺友链文件'); printf '  \033[31m✗\033[0m %-56s\n' '清单里的友链文件与写入用的是同一个路径'; }
  # 时刻是朋友圈式动态：没有标题也能发布，靠 content/file 的结构化通道
  req PUT /api/admin/content/file 200 '{"path":"content/zh/moments/zz-smoke-moment.md","front":{"date":"2026-01-01T00:00:00Z","draft":true,"link":{"url":"https://example.com/x","title":"smoke link"}},"body":"smoke moment body","message":"smoke"}' '发布无标题时刻（写本地仓库）' "$ADMIN_COOKIE"
  req GET '/api/admin/content/file?path=content/zh/moments/zz-smoke-moment.md' 200 '' '读回刚发布的时刻' "$ADMIN_COOKIE"
  printf '%s' "$BODY_TEXT" | grep -qF '"exists":true'     && { PASS=$((PASS + 1)); printf '  [32m✓[0m %-56s
' '无标题时刻确实落进仓库'; }     || { FAIL=$((FAIL + 1)); FAILED+=('无标题时刻没落盘'); printf '  [31m✗[0m %-56s
' '无标题时刻确实落进仓库'; }
  req DELETE '/api/admin/content/file?path=content/zh/moments/zz-smoke-moment.md' 200 '' '删除冒烟临时时刻' "$ADMIN_COOKIE"
  req GET '/api/admin/frontend' 200 '' '前端管理九段读取' "$ADMIN_COOKIE"
  # 前台署名的真值是仓库里的 data/site.json.defaultAuthor，schema 少这个键就会被基本信息保存抹成空。
  # site 为 null 也算过：那表示这份文件还不存在（新站点没存过基本信息），键没地方露。
  printf '%s' "$BODY_TEXT" | grep -qE '"defaultAuthor"|"site":null' \
    && { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %-56s\n' '基本信息段带 defaultAuthor（前台署名的真值）'; } \
    || { FAIL=$((FAIL + 1)); FAILED+=('前端管理缺 defaultAuthor'); printf '  \033[31m✗\033[0m %-56s\n' '基本信息段带 defaultAuthor'; }
  printf '%s' "$BODY_TEXT" | grep -q '"nav"'     && { PASS=$((PASS + 1)); printf '  [32m✓[0m %-56s
' '前端管理返回 nav/home/footer/about/works'; }     || { FAIL=$((FAIL + 1)); FAILED+=('前端管理缺段'); printf '  [31m✗[0m %-56s
' '前端管理返回 nav/home/footer/about/works'; }
  printf '%s' "$BODY_TEXT" | grep -q '"seo"' && { PASS=$((PASS + 1)); printf '  [32m✓[0m %-56s\n' '前端管理返回 seo 段'; }     || { FAIL=$((FAIL + 1)); FAILED+=('前端管理缺 seo 段'); printf '  [31m✗[0m %-56s\n' '前端管理缺 seo 段'; }
  SMOKE_BATCH_BODY="$(pwd)/.smoke-batch-body.json"
  printf '%s' '{"files":[{"path":"content/zh/posts/zz-smoke-batch.md","front":{"title":"冒烟批量自测","date":"2026-01-02T03:00:00+08:00","draft":false},"body":"批量正文"}]}' > "$SMOKE_BATCH_BODY"
  req POST /api/admin/content/batch 200 "@$SMOKE_BATCH_BODY" '批量推送一篇' "$ADMIN_COOKIE"
  rm -f "$SMOKE_BATCH_BODY"
  printf '%s' "$BODY_TEXT" | grep -q '"done":1' && { PASS=$((PASS + 1)); printf '  [32m✓[0m %-56s\n' '批量推送回执 done=1'; }     || { FAIL=$((FAIL + 1)); FAILED+=('批量推送回执不对'); printf '  [31m✗[0m %-56s\n' '批量推送回执不对'; }
  req GET '/api/admin/content/file?path=content/zh/posts/zz-smoke-batch.md' 200 '' '批量推送的落点可读' "$ADMIN_COOKIE"
  printf '%s' "$BODY_TEXT" | grep -q '冒烟批量自测' && { PASS=$((PASS + 1)); printf '  [32m✓[0m %-56s\n' '批量推送内容一致'; }     || { FAIL=$((FAIL + 1)); FAILED+=('批量推送内容不符'); printf '  [31m✗[0m %-56s\n' '批量推送内容不符'; }
  req DELETE '/api/admin/content/file?path=content/zh/posts/zz-smoke-batch.md' 200 '' '删除批量自测文章' "$ADMIN_COOKIE"
  req GET '/api/account/author-request' 200 '' '作者认证入口状态' "$ADMIN_COOKIE"
  req PUT /api/admin/content/file 400 '{"path":"config/_default/params.toml","content":"nope"}' '拒绝写 content 之外的路径' "$ADMIN_COOKIE"

  section '管理员：订阅、群发、广告、媒体、作者表'
  req GET '/api/admin/subscribers?status=confirmed' 200 '' '订阅列表' "$ADMIN_COOKIE"
  req GET '/api/admin/broadcast/jobs' 200 '' '群发任务列表' "$ADMIN_COOKIE"
  req GET '/api/admin/spam/pattern-file' 200 '' '正则文件读取' "$ADMIN_COOKIE"
  req GET '/api/admin/media/buckets' 200 '' '存储桶列表（脱敏）' "$ADMIN_COOKIE"
  printf '%s' "$BODY_TEXT" | grep -q 'secretAccessKey' && printf '  \033[33m!\033[0m 存储桶响应里出现了 secretAccessKey，请核对脱敏\n'
  req GET '/api/admin/authors/file' 200,404 '' '作者表读取' "$ADMIN_COOKIE"
  req GET '/api/admin/drafts?status=pending' 200 '' '投稿列表' "$ADMIN_COOKIE"
  req GET '/api/admin/friends' 200 '' '友链与站点联盟分组列表' "$ADMIN_COOKIE"
  req GET '/api/admin/stats' 200 '' '后台统计汇总' "$ADMIN_COOKIE"
  req GET '/api/admin/translate/status' 200 '' '翻译可用引擎' "$ADMIN_COOKIE"
  req GET /api/security 200 '' '我的信息：安全设置' "$ADMIN_COOKIE"
  req GET /api/security/totp/status 200 '' '验证器状态（含「登录时要动态码」这一自己的开关）' "$ADMIN_COOKIE"
  req GET '/api/admin/deletions' 200 '' '注销申请列表' "$ADMIN_COOKIE"

  section '管理员：仪表盘与全站备份'
  req GET '/api/admin/health-detail' 200 '' '运行状况明细' "$ADMIN_COOKIE"
  printf '%s' "$BODY_TEXT" | grep -q '"cron":\['     && { PASS=$((PASS + 1)); printf '  ✓ %-56s
' '定时任务回的是数组（界面按数组遍历）'; }     || { FAIL=$((FAIL + 1)); FAILED+=('cron 不是数组'); printf '  ✗ %-56s
' '定时任务回的是数组（界面按数组遍历）'; }
  printf '%s' "$BODY_TEXT" | grep -q 'credentialSource'     && { PASS=$((PASS + 1)); printf '  ✓ %-56s
' '发信胶囊带凭据来源（后台填的密码也算）'; }     || { FAIL=$((FAIL + 1)); FAILED+=('缺 credentialSource'); printf '  ✗ %-56s
' '发信胶囊带凭据来源（后台填的密码也算）'; }
  printf '%s' "$BODY_TEXT" | grep -q '"last24h"'     && { PASS=$((PASS + 1)); printf '  ✓ %-56s
' '发信胶囊带近 24 小时成功/失败数'; }     || { FAIL=$((FAIL + 1)); FAILED+=('缺 last24h 统计'); printf '  ✗ %-56s
' '发信胶囊带近 24 小时成功/失败数'; }
  req GET '/api/admin/stats/content' 200 '' '文章与时刻的递归计数' "$ADMIN_COOKIE"
  printf '%s' "$BODY_TEXT" | grep -q '"posts":'     && { PASS=$((PASS + 1)); printf '  ✓ %-56s
' '文章数按 posts 目录递归统计'; }     || { FAIL=$((FAIL + 1)); FAILED+=('stats/content 缺 posts'); printf '  ✗ %-56s
' '文章数按 posts 目录递归统计'; }
  req GET '/api/admin/backup/catalog' 200 '' '备份分区目录' "$ADMIN_COOKIE"
  printf '%s' "$BODY_TEXT" | grep -q '"media"'     && { PASS=$((PASS + 1)); printf '  ✓ %-56s
' '备份分区目录含媒体清单'; }     || { FAIL=$((FAIL + 1)); FAILED+=('备份目录缺分区'); printf '  ✗ %-56s
' '备份分区目录含媒体清单'; }
  req GET '/api/admin/backup/export' 200 '' '全站备份导出' "$ADMIN_COOKIE"
  printf '%s' "$BODY_TEXT" | grep -q '"version":2'     && { PASS=$((PASS + 1)); printf '  ✓ %-56s
' '导出的是 v2 分区结构'; }     || { FAIL=$((FAIL + 1)); FAILED+=('导出不是 v2'); printf '  ✗ %-56s
' '导出的是 v2 分区结构'; }
  printf '%s' "$BODY_TEXT" | grep -qE '"(smtpPassword|resendApiKey|cloudflareEmailToken|cfTurnstileSecret|githubToken)":"[^"]+"'     && { FAIL=$((FAIL + 1)); FAILED+=('备份文件里出现密钥的值'); printf '  ✗ %-56s
' '备份不含密钥的值（omitted 里的键名与空值不算泄漏）'; }     || { PASS=$((PASS + 1)); printf '  ✓ %-56s
' '备份不含密钥的值（omitted 里的键名与空值不算泄漏）'; }
  req GET '/api/admin/users' 200 '' '用户列表（含站长自己）' "$ADMIN_COOKIE"
  printf '%s' "$BODY_TEXT" | grep -q '"role":"admin"'     && { PASS=$((PASS + 1)); printf '  ✓ %-56s
' '站长那一行默认就在用户列表里'; }     || { FAIL=$((FAIL + 1)); FAILED+=('用户列表没有管理员'); printf '  ✗ %-56s
' '站长那一行默认就在用户列表里'; }
  printf '%s' "$BODY_TEXT" | grep -q '"authorVerified":true'     && { PASS=$((PASS + 1)); printf '  ✓ %-56s
' '管理员读出来恒为已认证作者'; }     || { FAIL=$((FAIL + 1)); FAILED+=('管理员未认证'); printf '  ✗ %-56s
' '管理员读出来恒为已认证作者'; }
else
  printf '\n\033[33m未提供 ADMIN_COOKIE，管理员接口的实际数据检查已跳过。\033[0m\n'
  printf '想跑全量：ADMIN_COOKIE=\x27zero_session=…\x27 bash scripts/smoke.sh\n'
fi

# 自洁：删掉这一轮建的临时文章（build=0 不请求站点重建）
if [ -n "$SMOKE_POST_PATH" ]; then
  req DELETE "/api/admin/content/file?path=$SMOKE_POST_PATH&build=0" 200 '' '删掉临时文章（脚本自洁）' "$ADMIN_COOKIE"
fi

# ---------------------------------------------------------------- 汇总
printf '\n\033[1m== 汇总 ==\033[0m\n'
printf '  通过 %s / 失败 %s / 跳过 %s\n' "$PASS" "$FAIL" "$SKIP"
if [ "$SKIP" -gt 0 ]; then
  printf '\n跳过明细（这些需要脚本当前拿不到的条件，不是功能坏了）：\n'
  for s in "${SKIPPED[@]}"; do printf '  · %s\n' "$s"; done
fi
if [ "$FAIL" -gt 0 ]; then
  printf '\n失败明细：\n'
  for f in "${FAILED[@]}"; do printf '  · %s\n' "$f"; done
  exit 1
fi
printf '  \033[32m全绿\033[0m\n'
