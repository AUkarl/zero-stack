<script lang="ts">
  import { get, post, patch, put, getApiBase } from '#lib/api';

  type Kind = 'text' | 'textarea' | 'bool' | 'number' | 'select' | 'secret' | 'lines';
  interface Field {
    key: string;
    label: string;
    hint?: string;
    kind?: Kind;
    options?: { value: string; label: string }[];
  }
  /** 一节：标题 + 说明 + 这一节显示哪几个键（顺序按 keys，不按 fields） */
  interface Section {
    title: string;
    desc?: string;
    keys: string[];
    /** 只有 emailProvider 取这些值时才显示这一节 */
    onlyFor?: string[];
    /** 这一节底部带「常用 SMTP」预设按钮 */
    presets?: boolean;
    /** 这一节是「测试发送」那块（不在 fields 里） */
    test?: boolean;
  }
  interface Group {
    title: string;
    desc?: string;
    /** 全部键的元数据：保存时按这里的类型判定，分节显示也用它取字段 */
    fields: Field[];
    /** 分了小节的组按节显示，隐藏的通道字段不占位；没写的组一马平川 */
    sections?: Section[];
  }

  const PROVIDERS = [
    { value: 'zero', label: 'Zero 自带' },
    { value: 'waline', label: 'Waline' },
    { value: 'twikoo', label: 'Twikoo' },
    { value: 'giscus', label: 'Giscus' },
    { value: 'artalk', label: 'Artalk' },
  ];

  const GROUPS: Group[] = [
    {
      title: '注册与邀请码',
      desc: '「前台账号系统」关掉后 /account/ 整页只留提示，用户无法登录；管理员仍可从站点后台路径登录。「允许注册」只下线注册 tab 与验证码注册通道，已注册用户照常登录。',
      fields: [
        { key: 'accountSystemEnabled', label: '前台账号系统', kind: 'bool' },
        { key: 'allowRegister', label: '允许注册', kind: 'bool', hint: '关掉后普通账号也无法登录（只有站长与管理员还能进），需要收口时再关' },
        { key: 'requireInviteCode', label: '注册需邀请码', kind: 'bool', hint: '邀请码在「用户」页的「邀请码」tab 生成' },
        { key: 'cmsAdminUrl', label: '后台地址', hint: '管理员在前台登录成功后跳这里。后台是独立的 Pages 项目，与站点不同域：留空时前端只能按同域 /admin/ 兜底，那个路径必然是 404。管理员第一次从后台登录时会自动记下后台自己的域名，换域名后在这里改' },
        { key: 'inviteCodeLength', label: '随机码长度', kind: 'number', hint: '4 ~ 16' },
        { key: 'inviteCodeUses', label: '随机码默认可用次数', kind: 'number', hint: '0 表示不限' },
      ],
    },
    {
      title: '用户中心',
      desc: '这里是全站总闸；具体哪个人能投稿、能申请认证，在「用户」页按账号勾选。关掉总闸后即便已勾权限也不会开放。',
      fields: [
        { key: 'draftsEnabled', label: '开放投稿', kind: 'bool', hint: '投稿先进库，审核通过才写入仓库' },
        { key: 'authorVerifyEnabled', label: '开放作者认证申请', kind: 'bool' },
      ],
    },
    {
      title: '评论',
      desc: '评论区按 /api/config 在运行时挂载对应系统，与构建期写死的 provider 不一致时前台会自动接管，60 秒内生效，不用重新构建站点。',
      fields: [
        { key: 'commentEnabled', label: '开启评论', kind: 'bool' },
        {
          key: 'commentAllowAnonymous',
          label: '允许游客评论',
          kind: 'bool',
          hint: '只有「注册与邀请码 → 前台账号系统」打开时这一项才有作用：账号系统关着时前台本来就没有登录入口，评论一律按游客处理（接口会强制放行，见 api routes/comments.ts 的 allowAnonymous）；评论选用 Waline 等第三方服务商时也不归这项管，去服务商自己的后台设',
        },
        { key: 'commentRequireReview', label: '游客评论需审核', kind: 'bool', hint: '登录用户评论始终直接通过' },
        { key: 'commentMaxDepth', label: '最大嵌套层级', kind: 'number', hint: '2 ~ 7' },
        { key: 'commentRateLimit', label: '每小时评论上限', kind: 'number', hint: '同一 IP 对同一篇文章，0 表示不限流' },
        { key: 'commentProvider', label: '文章评论区', kind: 'select', options: PROVIDERS },
        {
          key: 'commentProviders',
          label: '第三方评论参数（JSON）',
          kind: 'textarea',
          hint: '{"waline":{"serverURL":"…"},"twikoo":{"envId":"…"},"giscus":{…},"artalk":{…}}；切到 zero 时不需要填',
        },
      ],
    },
    {
      title: '点赞与收藏',
      fields: [
        { key: 'likeEnabled', label: '开启点赞', kind: 'bool' },
        { key: 'likeAllowAnonymous', label: '允许游客点赞', kind: 'bool', hint: '按设备指纹去重' },
        { key: 'starEnabled', label: '开启收藏', kind: 'bool' },
      ],
    },
    {
      title: '邮件订阅',
      fields: [
        { key: 'subscribeEnabled', label: '开启订阅', kind: 'bool' },
        { key: 'subscribeDoubleOptIn', label: '双重确认', kind: 'bool', hint: '关闭后直接置为已确认，容易被灌订阅' },
        { key: 'subscribePushEnabled', label: '新文章自动推送', kind: 'bool', hint: '每天一次的定时任务（世界时 02:00，北京 10:00）抓下面这个 RSS，比上次位点新的文章就发一封汇总信，只发给已确认订阅者。这一页改完不会立刻发信，要验证去「群发」页点「推送新文章」，它会写明卡在哪一步（开关关着 / RSS 抓不到 / 没有已确认订阅者 / 发信额度不够）' },
        { key: 'subscribeFeedUrl', label: '用于比对的 RSS 地址', hint: '留空则按「站点地址 + /index.xml」拼；Pages 的站点是 https://你的域名/index.xml，Hugo 的 RSS 就是这个。填错的话推送只会报「RSS 里没有条目」' },
      ],
    },
    {
      title: '头像与媒体',
      desc:
        '这一组只管两件全站兜底：① 匿名评论者的头像地址模板（留空按内置链 Gravatar→Cravatar→QQ→首字母，填了整条链换图床；注册者自己填的头像永远优先）；' +
        '② 媒体库的公开域名（R2 自定义域或 CDN，只对默认 r2 桶生效）。' +
        '站点 Logo / 分享图在「前端管理 → 基本信息」，时刻横幅与头像在「前端管理 → 时刻页」，管理员自己的头像在「我的信息 → 账号资料」，都在别处，这里不重复。',
      fields: [
        { key: 'avatarTemplate', label: '头像地址模板', hint: '留空就是内置那条链：Gravatar → Cravatar →（QQ 号）QQ 头像 → 首字母。填了就整条链换图床并顶到最前（{hash} 换成邮箱 MD5，{email} 换成 URL 编码后的邮箱）。别写 d=mp 这类「没有也给一张通用灰影人」的参数，那样链条当场断在第一级，本人真有头像也取不到' },
        { key: 'mediaBaseUrl', label: '媒体公开域名', hint: 'R2 自定义域名或 CDN，只作用到默认 r2 桶；留空则复制 / 插入的是 Worker 代理链接 —— 访客不用登录也打得开，但每张图都要接口转发一次。桶自己填了 baseUrl 的以桶为准' },
      ],
    },
    {
      title: '发信方式',
      desc: '先选通道，只填下面对应的那一节，其它通道的字段不显示也不会被改动。',
      fields: [
        {
          key: 'emailProvider',
          label: '服务商',
          kind: 'select',
          options: [
            { value: 'smtp', label: 'SMTP（默认）' },
            { value: 'resend', label: 'Resend' },
            { value: 'cloudflare', label: 'Cloudflare Email Sending' },
          ],
        },
        { key: 'emailDailyLimit', label: '每日发信上限', kind: 'number', hint: '按 UTC 日界计数，Resend 免费档是 100 封/天；填 0 表示不限制' },
        { key: 'emailFrom', label: '发件邮箱' },
        { key: 'emailFromName', label: '发件人名称' },
        { key: 'smtpHost', label: 'SMTP 服务器' },
        { key: 'smtpPort', label: 'SMTP 端口', kind: 'number' },
        {
          key: 'smtpSecure',
          label: '使用 SSL/TLS',
          kind: 'bool',
          hint: '465 端口一定走隐式 TLS（实测明文连过去对方不应答），这一项不勾也照样是 TLS；' +
            '它只给「587 / 2525 之类的端口但服务端只收隐式 TLS」的自建环境用，勾上表示那个端口也直接上 TLS',
        },
        { key: 'smtpUser', label: 'SMTP 用户名' },
        {
          key: 'smtpPassword',
          label: 'SMTP 密码 / 授权码',
          kind: 'secret',
          hint: 'QQ 邮箱、163 等要填「授权码 / 应用专用密码」，不是登录密码；留空表示不修改已存的那个',
        },
        { key: 'resendApiKey', label: 'Resend API Key', kind: 'secret' },
        { key: 'cloudflareAccountId', label: 'Cloudflare Account ID' },
        { key: 'cloudflareEmailToken', label: 'Cloudflare Email Token', kind: 'secret' },
      ],
      sections: [
        {
          title: '通道与发件人',
          desc: '密码 / 授权码可以直接填在这里（保存后读取只显示「已设置」，留空即不修改；导出的备份属于敏感数据）。也可以用 wrangler secret 配 SMTP_PASSWORD / RESEND_API_KEY，两处都有时以这里填的为准。每日上限是给发信服务的免费档留的余量：额度不够时群发与订阅推送整批不发，留到明天自动续跑。',
          keys: ['emailProvider', 'emailFrom', 'emailFromName', 'emailDailyLimit'],
        },
        {
          title: 'SMTP',
          desc: '465 与 587 都要开 SSL/TLS；用户名一般就是发件邮箱本身，密码填服务商给的授权码。',
          keys: ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPassword'],
          onlyFor: ['smtp'],
          presets: true,
        },
        {
          title: 'Resend',
          desc: 'API Key 形如 re_…，在 Resend 控制台 Dashboard → API Keys 里拿。',
          keys: ['resendApiKey'],
          onlyFor: ['resend'],
        },
        {
          title: 'Cloudflare Email Sending',
          desc: 'Account ID 在 Workers 控制台右侧；Token 是 Email Sending 里签发的 API Token（权限要含 Message: send）。',
          keys: ['cloudflareAccountId', 'cloudflareEmailToken'],
          onlyFor: ['cloudflare'],
        },
        { title: '测试发送', desc: '真发一封才知道配置对不对 —— 本地没有邮件服务，看着填对了也可能发不出去。下面「通知链路自检」会把新评论提醒的站长那封和用户那封各发一遍，并摊开发信服务器原文。', keys: [], test: true },
      ],
    },
    {
      title: '友情链接',
      fields: [
        { key: 'friendsEnabled', label: '开启友链', kind: 'bool' },
        { key: 'friendsAutoCheck', label: '定时检测存活', kind: 'bool' },
        {
          key: 'friendsCheckOnlyRss',
          label: '只检测填了 RSS 的友链',
          kind: 'bool',
          hint: '默认开。没填 RSS 的站不会进朋友动态，每天为它们各等一次超时不值；关掉就是全站都检',
        },
        {
          key: 'friendsCheckIntervalHours',
          label: '检测间隔（小时）',
          kind: 'number',
          hint: '每条友链自己的最小重检间隔，默认 24。Cron 一天跑多次也只按这个间隔出网，省 Workers 子请求',
        },
        {
          key: 'friendsLostAfterDays',
          label: '多少天不可访问进「迷失的小船」',
          kind: 'number',
          hint: '默认 30，与友链页写明的规则一致；按最近一次访问成功的时间算，填 0 表示不按可达性降级',
        },
        {
          key: 'friendsStaleAfterDays',
          label: '多少天没更新进「迷失的小船」',
          kind: 'number',
          hint: '默认 90，只看填了 RSS 的站（没 RSS 抓不到更新时间）；填 0 表示不按更新频率降级',
        },
        { key: 'friendApplyEnabled', label: '开放在线申请', kind: 'bool', hint: '前台友链页把「提交示例」换成在线表单' },
        { key: 'friendApplyRequireReview', label: '申请需人工审核', kind: 'bool' },
        { key: 'friendApplyAutoPublish', label: '通过后自动写友链文件', kind: 'bool', hint: '只管这一条路径：关掉就只进数据库、不提交 links.yaml，与投稿那个开关互不影响' },
        { key: 'friendApplyBlocklist', label: '申请黑名单关键词', kind: 'lines', hint: '一行一个，站名/网址/描述命中即直接拒绝' },
      ],
    },
    {
      title: '工坊 / 关于',
      desc: '这两个页面没有独立的管理页，开关放在这里（工坊的项目在「前端管理 → 工坊」，关于的文案在「前端管理 → 关于」，关掉开关只下线页面，内容本身不动）。关掉后前台导航里的入口消失、页面正文换成「已关闭」提示；内容仓库里带了那个边缘中间件（functions/_middleware.ts）的站，还会直接返回 404 并带上 noindex，旧链接和搜索引擎都拿不到内容。',
      fields: [
        { key: 'workEnabled', label: '开放工坊页 /work/', kind: 'bool' },
        { key: 'aboutEnabled', label: '开放关于页 /about/', kind: 'bool' },
      ],
    },
    {
      title: '访问统计',
      fields: [
        { key: 'analyticsEnabled', label: '开启统计', kind: 'bool' },
        { key: 'analyticsRetentionDays', label: '保留天数', kind: 'number' },
        {
          key: 'statsUtcOffsetHours',
          label: '日界时区偏移（小时）',
          kind: 'number',
          hint: '默认 8 = 东八区。统计里的「今天」与趋势图的每一天按这个时区切；填 0 就回到 UTC 日界',
        },
        {
          key: 'poststatsEnabled',
          label: '导出文章统计',
          kind: 'bool',
          hint: '每天定时把每篇的阅读 / 评论 / 点赞 / 收藏写回站点 data/poststats.json，首页精选与「最热」构建期按它排序（改完点「统计导出」页的立即导出）',
        },
        {
          key: 'poststatsViewWindowDays',
          label: '阅读量窗口（天）',
          kind: 'number',
          hint: '0 = 全量累计；填 N 只算最近 N 天的阅读，让精选与「最热」偏向新内容。评论 / 点赞 / 收藏始终算全量',
        },
      ],
    },
    {
      title: '内容仓库',
      desc: '后台发文、发时刻、写回作者表与友链文件都要落到这个仓库。令牌不在此处，使用 wrangler secret put GITHUB_TOKEN 配置 fine-grained PAT（Contents 读写）；本地开发用 GIT_LOCAL_DIR 指向站点目录，不走 GitHub。',
      fields: [
        { key: 'githubOwner', label: 'owner' },
        { key: 'githubRepo', label: 'repo' },
        { key: 'githubBranch', label: 'branch' },
        { key: 'githubContentDir', label: '内容目录', hint: '如 content' },
        { key: 'githubPostsDir', label: '文章目录', hint: '如 content/zh/posts（多语言）或 content/posts（单语言扁平），「文章」页写这里' },
        { key: 'githubMomentsDir', label: '时刻目录', hint: '如 content/zh/moments，「时刻」页读写这里' },
        { key: 'githubLinksFile', label: '友链文件', hint: '留空 = 「数据目录」（默认 data）下的 links.yaml；只有主题装在别处、或数据目录挪走了才需要填，填了以后后台列出的、审核通过写入的、定时任务读的都是这一份' },
        { key: 'githubAuthorsFile', label: '作者数据文件', hint: '如 data/authors.yaml' },
        { key: 'cloudflarePagesBuildHook', label: 'Pages 重建 Hook', hint: '选填，填了改完友链会自动重建站点' },
        {
          key: 'cfZoneId',
          label: 'Cloudflare Zone ID',
          hint: '删文章后要把那条地址从边缘缓存里清掉（Pages 的 HTML 在 CDN 上缓存 7 天，不清就还能用老链接打开，强刷也没用）。在 Cloudflare 控制台选中站点域名，右侧概览里能复制 Zone ID',
        },
        {
          key: 'cfPurgeToken',
          label: 'Purge Cache 令牌',
          kind: 'secret',
          hint: 'My Profile → API Tokens → 自定义令牌，权限只给「Zone - Cache - Purge」（清除缓存）即可；令牌只存不回读，这一栏显示为空是正常的，留空表示不改动',
        },
        {
          key: 'apiBaseUrl',
          label: '接口地址',
          hint: '邮件里的「确认订阅」「退订」指向接口自己的 /api/...，必须用这个域名拼（站点域名是 Pages 上的静态站，没有 /api 代理，写成站点地址点开就是 404）。第一次有人订阅时会自动记下，之后换域名在这里改',
        },
      ],
    },
    {
      title: '邮件模板',
      desc: '四封信只写正文那一段：站点名、Logo、称呼「亲爱的 X：您好！」、落款与页脚由主题外壳统一包好（取「前端管理 → 基本信息」的站点名 / Logo / 署名）。留空即回落到代码里的默认文本。',
      fields: [
        {
          key: 'emailTemplateCode',
          label: '① 验证码模板',
          kind: 'textarea',
          hint: '可用 {code} 验证码、{minutes} 有效分钟、{siteName} 站点名',
        },
        {
          key: 'emailTemplateSubscribe',
          label: '② 订阅确认模板',
          kind: 'textarea',
          hint: '可用 {url} 确认链接、{siteName} 站点名、{email} 待确认邮箱',
        },
        {
          key: 'emailTemplateComment',
          label: '③ 新评论提醒模板',
          kind: 'textarea',
          hint: '可用 {author} 评论者、{where} 位置、{content} 正文、{url} 锚点链接、{title} 原文标题、{siteName} 站点名',
        },
        {
          key: 'emailTemplateNotice',
          label: '④ 其它通知模板（默认信）',
          kind: 'textarea',
          hint: '审核结果、新文章推送等都走这一封。可用 {intro} 开头一句、{content} 正文、{title} 标题、{url} 链接、{action} 按钮文字、{siteName} 站点名',
        },
      ],
    },
    {
      title: '评论提醒与展示',
      desc: '提醒邮件走「发信方式」里配好的通道；关闭对应开关只是不再发信，评论本身不受影响。',
      fields: [
        { key: 'commentNotifyAdmin', label: '新评论提醒管理员', kind: 'bool', hint: '别人发评论、以及待审核的评论才提醒。**你自己发的评论与回复不会再提醒你自己** —— 以前站主每发一条就给自己来一封「新评论待处理」，那是这一条没排自己' },
        {
          key: 'adminNotifyEmail',
          label: '站长收件邮箱',
          hint: '「新评论提醒管理员」「投稿 / 友链申请待处理」这类给站长的信发到这里。留空就发到「发信方式」里的发件邮箱 —— 很多站两者本来就是同一个地址。以前没有这一项，给站长的提醒永远发回发件邮箱自己',
        },
        { key: 'commentNotifyReply', label: '被回复时提醒', kind: 'bool' },
        { key: 'commentNotifyAuthor', label: '提醒文章作者', kind: 'bool' },
        { key: 'commentShowMeta', label: '前台展示属地 / 设备等信息', kind: 'bool' },
        { key: 'commentEmojiPacks', label: '表情面板', kind: 'lines', hint: '一行一个 emoji，保存为 JSON 数组' },
      ],
    },
  ];

  /* ---------------- 邮件模板：默认正文、预览地址 ---------------- */

  type EmailKind = 'code' | 'subscribe' | 'comment' | 'notice';
  const EMAIL_KINDS: { kind: EmailKind; key: string; label: string }[] = [
    { kind: 'code', key: 'emailTemplateCode', label: '① 验证码' },
    { kind: 'subscribe', key: 'emailTemplateSubscribe', label: '② 订阅确认' },
    { kind: 'comment', key: 'emailTemplateComment', label: '③ 新评论提醒' },
    { kind: 'notice', key: 'emailTemplateNotice', label: '④ 其它通知' },
  ];

  /** 四封正文的默认文本由后端给出（与代码里那份同源），这里缓存一次供「填回默认」用 */
  let emailDefaults = $state<Record<string, string>>({});

  /** 预览地址带后台登录态打开，看到的就是收件人实际收到的样子 */
  function emailPreviewUrl(kind: EmailKind): string {
    return getApiBase() + '/api/admin/email/preview?kind=' + kind;
  }

  /* ---------------- 发信方式：测试发送 ---------------- */

  let testTo = $state('');
  let testKind = $state<'code' | 'subscribe' | 'comment' | 'notice'>('code');
  let testBusy = $state(false);
  let testResult = $state<{ ok: boolean; text: string } | null>(null);

  /** 真发一封测试信到填的邮箱：本地没有邮件服务，配置对不对只有发出去才知道 */
  async function sendTestEmail() {
    if (testBusy || !testTo.trim()) return;
    testBusy = true;
    testResult = null;
    try {
      /* R43 起失败是 5xx + { error, message }，不再回 200 带 sent:false ——
         界面上这句话由下面那个 catch 从 message 里拿（原因文字一个字没少）。
         状态码改对是为了让「接 Uptime/脚本测信」那种监控也能看见失败。 */
      const d = await post<{ data: { sent: true; to: string; kind: string } }>('/api/admin/email/test', {
        to: testTo.trim(),
        kind: testKind,
      });
      testResult = { ok: true, text: `已发到 ${d.data.to}，去邮箱（含垃圾邮件箱）看一下` };
    } catch (e) {
      testResult = { ok: false, text: `发送失败：${e instanceof Error ? e.message : '请求出错'}` };
    } finally {
      testBusy = false;
    }
  }

  /**
   * 通知链路自检：后端按 notifyNewComment 真正用的那套配置各发一封
   * （站长那封 + 用户那封），把算出来的收件人和 SMTP 原文回执摊开。
   * 「库里写着已发送、邮箱里却没有」只能这样分开看：是没发、发给谁，还是发出去没送达。
   */
  interface NotifyTestRow {
    label: string;
    to: string;
    subject: string;
    sent: boolean;
    error: string | null;
    detail: string | null;
    logId: string | null;
  }
  interface NotifyTestOut {
    provider: string;
    smtp: string;
    from: string;
    adminEmail: string;
    adminEmailSource: string;
    siteUrl: string;
    toggles: { commentNotifyAdmin: boolean; commentNotifyReply: boolean; commentNotifyAuthor: boolean };
    rows: NotifyTestRow[];
    note: string;
  }
  let notifyBusy = $state(false);
  let notifyResult = $state<NotifyTestOut | null>(null);

  async function runNotifyTest() {
    if (notifyBusy) return;
    notifyBusy = true;
    notifyResult = null;
    try {
      const d = await post<{ data: NotifyTestOut }>('/api/admin/email/notify-test', testTo.trim() ? { to: testTo.trim() } : {});
      notifyResult = d.data;
    } catch (e) {
      notifyResult = {
        provider: '',
        smtp: '',
        from: '',
        adminEmail: '',
        adminEmailSource: '',
        siteUrl: '',
        toggles: { commentNotifyAdmin: false, commentNotifyReply: false, commentNotifyAuthor: false },
        rows: [],
        note: e instanceof Error ? e.message : '请求出错',
      };
    } finally {
      notifyBusy = false;
    }
  }

  async function loadEmailTemplates() {
    try {
      const d = await get<{ data: { defaults: Record<string, string> } }>('/api/admin/email/templates');
      emailDefaults = d.data.defaults || {};
    } catch {
      // 拿不到默认文本只影响「填回默认」按钮，编辑与保存照常
      emailDefaults = {};
    }
  }

  const SMTP_PRESETS = [
    { label: 'QQ 邮箱 465', host: 'smtp.qq.com', port: '465', secure: 'true' },
    // 587 是 STARTTLS：secure 必须留 false，勾上等于对这个端口要求隐式 TLS，握手直接谈不拢
    { label: 'QQ 邮箱 587', host: 'smtp.qq.com', port: '587', secure: 'false' },
    { label: '网易 163', host: 'smtp.163.com', port: '465', secure: 'true' },
    { label: 'Gmail', host: 'smtp.gmail.com', port: '465', secure: 'true' },
    { label: '阿里企业邮箱', host: 'smtp.qiye.aliyun.com', port: '465', secure: 'true' },
    { label: '腾讯企业邮箱', host: 'smtp.exmail.qq.com', port: '465', secure: 'true' },
  ];

  /** 一节显示哪几个字段：顺序按 keys 给，fields 只是键的元数据来源 */
  function sectionFields(group: Group, s: Section): Field[] {
    const byKey = new Map(group.fields.map((f) => [f.key, f]));
    return s.keys.flatMap((k) => byKey.get(k) ?? []);
  }

  /** 没选中的通道那一节直接不显示；配置还没读回来时按默认的 smtp 对待 */
  function visibleSections(g: Group, provider: string): Section[] {
    const now = (provider || 'smtp').trim();
    return (g.sections ?? []).filter((s) => !s.onlyFor || s.onlyFor.includes(now));
  }

  /** 面板里明确标了类型的键；其余按键名兜一层，剩下的靠取值形态推断 */
  const TEXT_KEYS = new Set(
    GROUPS.flatMap((g) => g.fields)
      .filter((f) => f.kind === 'textarea' || f.kind === 'lines' || f.kind === 'select')
      .map((f) => f.key),
  );
  const LINES_KEYS = new Set(GROUPS.flatMap((g) => g.fields).filter((f) => f.kind === 'lines').map((f) => f.key));

  /**
   * 所有面板字段的值都归一成字符串再进 cfg。
   *
   * 为什么必须归一：`<input type="number" bind:value>` 给 Svelte 的是**数字**（465 而不是 "465"），
   * 于是 ① 「哪一项被改过」的比较 465 !== "465" 永远算改过，② `coerce()` 里那句 `raw.trim()`
   * 直接抛 TypeError —— 而它跑在 `saving = true` 之前、`try` 之外，结果就是点「保存」
   * 既不报错也不发请求，SMTP 授权码之类的内容根本没写进库（后台健康检查就一直说没配）。
   */
  function setVal(key: string, raw: unknown): void {
    cfg[key] =
      typeof raw === 'number' ? String(raw) : typeof raw === 'boolean' ? String(raw) : String(raw ?? '');
  }

  /**
   * 保存时决定一个键写回什么类型。不能从面板字段反查：评论审核规则这类键在别的页面维护，
   * 反查不到就会把 true 存成 "true" 字符串，前台开关直接失效。
   */
  function coerce(key: string, raw: unknown): string | number | boolean {
    const value = typeof raw === 'number' ? String(raw) : typeof raw === 'boolean' ? String(raw) : String(raw ?? '');
    if (LINES_KEYS.has(key)) {
      return JSON.stringify(
        value
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    if (TEXT_KEYS.has(key)) return value;
    if (value === 'true' || value === 'false') return value === 'true';
    if (value !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
    return value;
  }

  let cfg = $state<Record<string, string>>({});
  let saved = $state<Record<string, string>>({});
  /** 服务端已经存了值的密钥键名（读取不回传原文，靠这个标记提示「已设置」） */
  let secretSet = $state<string[]>([]);
  /** 被标记「清除已存密钥」的项：保存时按 null 提交，后端才真的把这列清空 */
  let clearSecrets = $state<string[]>([]);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let notice = $state('');
  let openGroup = $state<string | null>('注册与邀请码');

  async function load() {
    void loadEmailTemplates();
    loading = true;
    error = '';
    try {
      const d = await get<{ data: Record<string, string>; hasSecret?: Record<string, boolean> }>('/api/admin/config');
      // 配置键的值一律按字符串进面板：数字绑定会让「改过没有」的比较和 coerce 一起出错
      const next: Record<string, string> = Object.fromEntries(
        Object.entries(d.data ?? {}).map(([k, v]) => [k, String(v ?? '')]),
      );
      for (const key of LINES_KEYS) {
        try {
          const arr = JSON.parse(next[key] || '[]');
          next[key] = Array.isArray(arr) ? arr.join('\n') : '';
        } catch {
          next[key] = '';
        }
      }
      cfg = next;
      saved = { ...next };
      // 密钥不回传原文，只回「服务端是否已有值」：输入框留空就等于不修改
      secretSet = Object.keys(d.hasSecret ?? {}).filter((k) => d.hasSecret?.[k]);
    } catch (e) {
      error = e instanceof Error ? e.message : '读取配置失败';
    } finally {
      loading = false;
    }
  }

  const changed = $derived(
    [...new Set([...Object.keys(cfg).filter((k) => (cfg[k] ?? '') !== (saved[k] ?? '')), ...clearSecrets])],
  );

  async function save() {
    if (!changed.length) return;
    saving = true;
    error = '';
    try {
      const payload: Record<string, string | number | boolean | null> = {};
      for (const key of changed) payload[key] = clearSecrets.includes(key) && !cfg[key] ? null : coerce(key, cfg[key]);
      const d = await patch<{ data: { updated: number; failed?: { key: string; error: string }[] } }>('/api/admin/config', payload);
      clearSecrets = [];
      await load();
      /* 后端现在是逐项写的，个别项失败必须说清楚是哪几项：以前一律「已保存 N 项」，写失败也照说 */
      const failed = d.data?.failed ?? [];
      if (failed.length) error = `${failed.length} 项没写进去：${failed.map((f) => `${f.key}（${f.error}）`).join('、')}`;
      notice = d.data?.updated ? `已保存 ${d.data.updated} 项` : '提交的内容与现值相同，没有改动';
      setTimeout(() => (notice = ''), 3000);
    } catch (e) {
      error = e instanceof Error ? e.message : '保存失败';
    } finally {
      saving = false;
    }
  }

  /** 密钥读回来永远是空串，「留空」等于不改；要真删掉已存的那份得显式标记，后端按 null 处理 */
  function toggleClear(key: string) {
    clearSecrets = clearSecrets.includes(key) ? clearSecrets.filter((k) => k !== key) : [...clearSecrets, key];
  }

  function applyPreset(p: (typeof SMTP_PRESETS)[number]) {
    cfg.smtpHost = p.host;
    cfg.smtpPort = p.port;
    cfg.smtpSecure = p.secure;
  }

  $effect(() => void load());

  const boolValue = (k: string) => (cfg[k] ?? '') === 'true';
</script>

<div class="row spread head">
  <h2>站点设置</h2>
  <div class="row">
    <span class="muted small">{changed.length ? `${changed.length} 项未保存` : '全部已保存'}</span>
    <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '读取中…' : '重新读取'}</button>
    <button class="primary" onclick={() => void save()} disabled={saving || !changed.length}>
      {saving ? '保存中…' : '保存修改'}
    </button>
  </div>
</div>

{#if error}<p class="err">{error}</p>{/if}
{#if notice}<p class="ok">{notice}</p>{/if}

{#snippet fieldList(list: Field[])}
  <div class="fields">
    {#each list as f (f.key)}
      <div class="field {f.kind === 'textarea' || f.kind === 'lines' ? 'wide' : ''}">
        {#if f.kind === 'bool'}
          <label class="switch">
            <input type="checkbox" checked={boolValue(f.key)} onchange={(e) => setVal(f.key, e.currentTarget.checked)} />
            <span>{f.label}</span>
          </label>
        {:else if f.kind === 'select'}
          <label>
            {f.label}
            <select value={cfg[f.key] ?? ''} onchange={(e) => setVal(f.key, e.currentTarget.value)}>
              {#each f.options ?? [] as o}<option value={o.value}>{o.label}</option>{/each}
            </select>
          </label>
        {:else if f.kind === 'textarea' || f.kind === 'lines'}
          <label>
            {f.label}
            <textarea
              rows={f.kind === 'lines' ? 4 : 3}
              value={cfg[f.key] ?? ''}
              oninput={(e) => setVal(f.key, e.currentTarget.value)}
            ></textarea>
          </label>
        {:else}
          <label>
            {f.label}
            <input
              type={f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'number' : 'text'}
              value={cfg[f.key] ?? ''}
              oninput={(e) => setVal(f.key, e.currentTarget.value)}
              placeholder={f.kind === 'secret' && secretSet.includes(f.key) ? '已设置（留空不修改）' : ''}
              autocomplete={f.kind === 'secret' ? 'new-password' : 'on'}
            />
          </label>
          {#if f.kind === 'secret' && secretSet.includes(f.key)}
            <button type="button" class="sm" onclick={() => toggleClear(f.key)}>
              {clearSecrets.includes(f.key) ? '已标记清除（点这里撤回）' : '清除已存密钥'}
            </button>
          {/if}
        {/if}
        {#if f.hint}<span class="muted hint">{f.hint}</span>{/if}
      </div>
    {/each}
  </div>
{/snippet}

{#snippet testSend()}
  <div class="row testrow">
    <label class="inline grow">
      测试收件人
      <input bind:value={testTo} placeholder="you@example.com" />
    </label>
    <label class="inline">
      发哪一封
      <select bind:value={testKind}>
        <option value="code">验证码</option>
        <option value="subscribe">订阅确认</option>
        <option value="comment">新评论提醒</option>
        <option value="notice">其它通知</option>
      </select>
    </label>
    <button class="sm" onclick={() => void sendTestEmail()} disabled={testBusy || !testTo.trim()}>
      {testBusy ? '发送中…' : '发一封测试信'}
    </button>
  </div>
  {#if testResult}
    <p class="small testresult {testResult.ok ? 'ok' : 'err'}">{testResult.text}</p>
  {/if}
  <div class="row testrow">
    <button class="sm" onclick={() => void runNotifyTest()} disabled={notifyBusy}>
      {notifyBusy ? '两封发送中…' : '通知链路自检（站长那封 + 用户那封各一封）'}
    </button>
    <span class="muted small">收件人不填就发给你自己；这一步走的是新评论提醒真正用的那套收件人算法与模板。</span>
  </div>
  {#if notifyResult}
    <div class="notifybox">
      <p class="small">
        通道 <b>{notifyResult.provider || '—'}</b> · 服务器 <b>{notifyResult.smtp || '—'}</b> · 发件人 <b>{notifyResult.from || '—'}</b> ·
        站长收件邮箱 <b>{notifyResult.adminEmail || '—'}</b>（取于 {notifyResult.adminEmailSource || '—'}）
      </p>
      <p class="small">
        站点地址 <b>{notifyResult.siteUrl || '—'}</b> · 三个提醒开关：
        站长 {notifyResult.toggles.commentNotifyAdmin ? '开' : '关'} / 回复 {notifyResult.toggles.commentNotifyReply ? '开' : '关'} / 文章作者 {notifyResult.toggles.commentNotifyAuthor ? '开' : '关'}
        （关着的那类本来就不会发，跟通道没关系）
      </p>
      {#each notifyResult.rows as r (r.label)}
        <p class="small testresult {r.sent ? 'ok' : 'err'}">
          {r.label}：{r.sent ? '已送出' : '失败'} → {r.to}｜主题「{r.subject}」
        </p>
        {#if r.error}<p class="small err">原因：{r.error}</p>{/if}
        {#if r.detail}<p class="small muted">服务器原文：{r.detail}</p>{/if}
        {#if r.logId}<p class="small muted">已记进「群发 → 发信记录」，行号 {r.logId}</p>{/if}
      {/each}
      {#if !notifyResult.rows.length}<p class="small err">{notifyResult.note}</p>{/if}
      {#if notifyResult.rows.length}<p class="muted small">{notifyResult.note}</p>{/if}
    </div>
  {/if}
  <p class="muted small">测试信用的就是上面几节的发信配置与「邮件模板」里填的正文，改了先保存再发才准。</p>
  <p class="muted small">
    「已发送 / sent」只代表中继收下了这封信（SMTP 回 250）。250 不等于投进对方收件箱：地址不存在、被判为垃圾、
    服务商限流都照样回 250。这里显示已送出而邮箱（含垃圾邮件箱）里没有，就查发信邮箱服务商的投递日志。
  </p>
{/snippet}

{#each GROUPS as g (g.title)}
  <section class="card group">
    <button class="group-head" onclick={() => (openGroup = openGroup === g.title ? null : g.title)}>
      <span>{g.title}</span>
      <span class="muted small">{openGroup === g.title ? '收起' : '展开'}</span>
    </button>
    {#if openGroup === g.title}
      {#if g.desc}<p class="muted small desc">{g.desc}</p>{/if}
      {#if g.title === '邮件模板'}
        <div class="presets">
          <span class="muted small">预览（用当前填的模板与「基本信息」里的站点名 / Logo / 署名渲染，不发送）：</span>
          {#each EMAIL_KINDS as k (k.kind)}
            <a class="sm linkbtn" href={emailPreviewUrl(k.kind)} target="_blank" rel="noreferrer">{k.label}</a>
            <button
              class="sm ghost"
              onclick={() => {
                cfg[k.key] = emailDefaults[k.kind] ?? '';
                notice = `已把「${k.label}」的默认正文填回输入框，记得点底部「保存设置」`;
                setTimeout(() => (notice = ''), 4000);
              }}>填回默认</button>
          {/each}
        </div>
        <p class="muted small">
          预览要带着后台登录态打开，新标签里看到的就是收件人实际收到的样子（窄屏下会自动收窄，手机上不用横向拖）。
        </p>
      {/if}
      {#if g.sections}
        {#each visibleSections(g, cfg.emailProvider) as s (s.title)}
          <div class="subgroup">
            <h3 class="subgroup-title">{s.title}</h3>
            {#if s.desc}<p class="muted small subdesc">{s.desc}</p>{/if}
            {#if s.test}
              {@render testSend()}
            {:else}
              {@render fieldList(sectionFields(g, s))}
              {#if s.presets}
                <div class="presets">
                  <span class="muted small">常用 SMTP（只填服务器与端口，点一下就行）：</span>
                  {#each SMTP_PRESETS as p (p.label)}
                    <button class="sm" onclick={() => applyPreset(p)}>{p.label}</button>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        {/each}
      {:else}
        {@render fieldList(g.fields)}
      {/if}
    {/if}
  </section>
{/each}

<p class="muted small foot">修改后立即生效（配置缓存 30 秒内刷新）；前台需重新构建的项以 Hugo 参数为准。</p>

<style>
  .head {
    margin-bottom: 0.7rem;
  }
  .group {
    margin-bottom: 0.6rem;
    padding: 0;
    overflow: hidden;
  }
  .group-head {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 0.75rem 1rem;
    font-weight: 600;
  }
  .desc {
    margin: 0 1rem;
  }
  .testrow {
    align-items: flex-end;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-bottom: 0.4rem;
  }

  .grow {
    min-width: 240px;
    flex: 1 1 240px;
  }

  .linkbtn {
    display: inline-flex;
    align-items: center;
    padding: 0.18rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 0.78rem;
    text-decoration: none;
    color: inherit;
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
    margin: 0.6rem 1rem 0;
  }
  /* 「发信方式」这类条目多的组：一通道一节，没选中的通道整节收起，
     不再把十几个键平铺成一片 —— 小标题 + 一句说明 + 自己的字段网格。 */
  .subgroup {
    margin: 0 1rem;
    padding: 0.85rem 0 0.35rem;
    border-top: 1px solid var(--border);
  }
  .subgroup:first-of-type {
    border-top: 0;
    padding-top: 0.3rem;
  }
  .subgroup-title {
    margin: 0 0 0.15rem;
    font-size: 0.88rem;
    font-weight: 600;
  }
  .subgroup .subdesc {
    margin: 0;
    max-width: 62rem;
    line-height: 1.65;
  }
  .subgroup .fields {
    padding: 0.7rem 0 0.15rem;
  }
  .subgroup .presets {
    margin: 0.7rem 0 0;
  }
  .subgroup .testrow {
    margin-top: 0.75rem;
  }
  .testresult {
    margin: 0.35rem 0 0;
  }
  .notifybox {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0.6rem 0.75rem;
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    word-break: break-all;
  }
  .fields {
    display: grid;
    /* min(100%, 230px)：窄屏时列宽不会超过容器，否则整块被撑出横向滚动，字也挤变形 */
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr));
    gap: 0.7rem 0.9rem;
    padding: 0.8rem 1rem 1rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    /* 没有这行，一长串地址会把所在列撑破（grid 子项默认 min-width:auto） */
    min-width: 0;
  }
  .field input,
  .field select,
  .field textarea {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }
  .field label {
    overflow-wrap: anywhere;
  }
  .field.wide {
    grid-column: 1 / -1;
  }
  .switch {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.88rem;
    color: var(--fg);
  }
  .switch input {
    width: 16px;
    height: 16px;
  }
  .hint {
    font-size: 0.74rem;
    /* .field 是纵向 flex，这里不是网格项：写 grid-column 没用，靠换行读完整句 */
    overflow-wrap: anywhere;
  }
  /* 邮件模板 / 正则 / JSON 都是代码类文本，等宽才不会看错缩进 */
  .fields textarea {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .small {
    font-size: 0.76rem;
  }
  .foot {
    margin-top: 1rem;
  }
</style>
