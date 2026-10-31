<script lang="ts">
  import { get, post, patch, put, getApiBase } from '#lib/api';
  import { flash } from '#lib/toast.svelte';

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

  /** 与后端 services/ai.ts 的 AI_PROVIDERS 对齐：切服务商时把默认端点/模型填进下面两格 */
  const AI_PROVIDERS = [
    { value: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { value: 'qianwen', label: '通义千问（阿里云）', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { value: 'moonshot', label: 'Moonshot Kimi', endpoint: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { value: 'doubao', label: '豆包（火山方舟）', endpoint: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' },
    { value: 'zhipu', label: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { value: 'wenxin', label: '百度文心一言', endpoint: 'https://qianfan.baidubce.com/v2', model: 'ernie-4.0-8k' },
    { value: 'hunyuan', label: '腾讯混元', endpoint: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-turbos-latest' },
    { value: 'spark', label: '讯飞星火', endpoint: 'https://spark-api-open.xf-yun.com/v1', model: 'generalv3.5' },
    { value: 'siliconflow', label: '硅基流动', endpoint: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    { value: 'openai', label: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { value: 'gemini', label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
    { value: 'claude', label: 'Anthropic Claude', endpoint: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
    { value: 'grok', label: 'Grok（xAI）', endpoint: 'https://api.x.ai/v1', model: 'grok-2-latest' },
    { value: 'minimax', label: 'MiniMax', endpoint: 'https://api.minimax.chat/v1', model: 'abab6.5s-chat' },
    { value: 'custom', label: '自定义 / 自建（OpenAI 兼容）', endpoint: '', model: '' },
  ];
  const AI_DEFAULTS = new Map(AI_PROVIDERS.map((p) => [p.value, { endpoint: p.endpoint, model: p.model }]));

  const GROUPS: Group[] = [
    {
      title: '注册与邀请码',
      desc: '「前台账号系统」关掉后 /account/ 整页只留提示，用户无法登录；管理员仍可从站点后台路径登录。「允许注册」只下线注册 tab 与验证码注册通道，已注册用户照常登录。',
      fields: [
        { key: 'accountSystemEnabled', label: '前台账号系统', kind: 'bool' },
        { key: 'allowRegister', label: '允许注册', kind: 'bool', hint: '只控制新账号注册；已注册用户是否还能登录看下面一项' },
        { key: 'readerLoginEnabled', label: '注册用户可登录', kind: 'bool', hint: '关掉后只有站长/管理员能登录，普通用户会被拒绝；不影响注册开关' },
        { key: 'requireInviteCode', label: '注册需邀请码', kind: 'bool', hint: '邀请码在「用户」页的「邀请码」tab 生成' },
        { key: 'cmsAdminUrl', label: '后台地址', hint: '管理员在前台登录成功后跳这里。留空时只能按同域 /admin/ 兜底，路径必然是 404。' },
        { key: 'inviteCodeLength', label: '随机码长度', kind: 'number', hint: '4 ~ 16' },
        { key: 'inviteCodeUses', label: '随机码默认可用次数', kind: 'number', hint: '0 表示不限' },
      ],
    },
    {
      title: '用户中心',
      desc: '这里是全站总闸；具体哪个人能投稿、能申请认证，在「用户」页按账号勾选。关掉总闸后即便已勾权限也不会开放——接口侧同样会拒，不只是前端把入口藏起来。',
      fields: [
        { key: 'draftsEnabled', label: '开放投稿', kind: 'bool', hint: '投稿先进库，审核通过才写入仓库' },
        { key: 'authorVerifyEnabled', label: '开放作者认证申请', kind: 'bool' },
        { key: 'newUserCanPublish', label: '新注册默认可投稿', kind: 'bool', hint: '开关只影响之后注册的账号，已有账号仍在「用户」页按人勾选' },
        { key: 'newUserCanAuthor', label: '新注册默认可申请认证', kind: 'bool', hint: '同上：新账号自带「作者认证申请」权限位，认证本身仍要审核' },
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
          hint: '只有开启登录注册时才有作用，否则一律按游客处理；不控制第三方评论',
        },
        { key: 'commentRequireReview', label: '游客评论需审核', kind: 'bool', hint: '登录用户评论始终直接通过' },
        { key: 'commentMaxDepth', label: '最大嵌套层级', kind: 'number', hint: '2 ~ 7' },
        { key: 'commentRateLimit', label: '每小时评论上限', kind: 'number', hint: '同一 IP 对同一篇文章，0 表示不限流' },
        { key: 'commentProvider', label: '文章评论区', kind: 'select', options: PROVIDERS },
        {
          key: 'commentProviders',
          label: '第三方评论参数（JSON）',
          kind: 'textarea',
          hint: '{"waline":{"serverURL":"…"},"twikoo":{"envId":"…"},"giscus":{…},"artalk":{…}}；切到 zero 时不需要填。'
            + '保存时会自动把 waline/artalk 的接口域补进站点 CSP（含 wss://，改了 static/_headers 与 functions/_middleware.ts 两份，Pages 随之重建）；'
            + 'twikoo 只给 envId 时认不出域，请写 "serviceUrl":"https://你的域名"',
        },
      ],
    },
    {
      title: '评论审核服务商',
      desc:
        '评论入库前先过本地规则（关键词 / 正则 / 仓库规则文件），这里配的是「再加一道外部服务商」：它说垃圾才算加分，' +
        '异常或超时一律 fail-open。审核规则本身在「评论审核」页调，这里只放凭据。',
      fields: [
        {
          key: 'spamProviderEndpoint',
          label: 'Endpoint',
          hint: '留空用服务商默认地址；自建 HTTP 服务必须填。选「不使用」时这一项不生效',
        },
        {
          key: 'spamProviderKeyId',
          label: 'KeyId / AccessKey',
          kind: 'secret',
          hint: '各服务商控制台签发的 AccessKey / KeyId；读取只显示「已设置」，留空表示不修改',
        },
        {
          key: 'spamProviderSecret',
          label: 'Secret',
          kind: 'secret',
          hint: '与 KeyId 配对的密钥；只有「自建 HTTP 服务」这类只认一个 Bearer 的通道可以不填',
        },
      ],
    },
    {
      title: 'AI 模型配置',
      desc:
        'AI 模型配置，供评论审核、AI 回复、翻译等共用。开启后相关内容会发送到你选的服务商，' +
        '介意隐私或服务商在境外时建议保持关闭。',
      fields: [
        {
          key: 'aiProvider',
          label: '服务商',
          kind: 'select',
          options: AI_PROVIDERS,
          hint: '选中后会把该服务商的默认端点与模型填到下面两格，可按需改；清空下面两格则运行时继续跟随预设',
        },
        {
          key: 'aiEndpoint',
          label: '接口地址（选填）',
          hint: '留空用所选服务商的默认地址；也可以填完整 …/chat/completions。自建服务（custom）必填',
        },
        {
          key: 'aiModel',
          label: '模型（选填）',
          hint: '留空用预设模型；豆包通常填控制台里的接入点 ID（ep-…）而不是产品名。自建服务（custom）必填',
        },
        {
          key: 'aiKey',
          label: 'API Key',
          kind: 'secret',
          hint: '云端服务商必填；本地自建端点不需要密钥，留空即可。读取只显示「已设置」，留空表示不修改',
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
        { key: 'subscribePushEnabled', label: '新文章自动推送', kind: 'bool', hint: '每天一次的定时任务（北京时间 10:00），只发给已确认订阅者' },
        { key: 'subscribeFeedUrl', label: '用于比对的 RSS 地址', hint: '留空则按「站点地址 + /index.xml」拼；填错的话推送只会报「RSS 里没有条目」' },
      ],
    },
    {
      title: '头像与媒体',
      desc:
        '这一组只管三件全站兜底：① 匿名评论者的头像地址模板（留空按内置链 Gravatar→Cravatar→QQ→首字母，填了整条链换图床；注册者自己填的头像永远优先）；' +
        '② 媒体直链域名（R2 自定义域或 CDN，只对默认 r2 桶生效）；' +
        '③ 走 Worker 代理时补在站内路径前面的接口根地址（站点与接口不同源才需要）。' +
        '站点 Logo / 分享图在「前端管理 → 基本信息」，时刻横幅与头像在「前端管理 → 时刻页」，管理员自己的头像在「我的信息 → 账号资料」，都在别处，这里不重复。',
      fields: [
        { key: 'avatarTemplate', label: '头像地址模板', hint: '' },
        {
          key: 'mediaBaseUrl',
          label: '媒体直链域名',
          hint: 'R2 自定义域或 CDN 根地址，填了以后新上传的图片外链成 <域名>/uploads/…，不占 Worker 请求数；只对没单独填域名的 r2 桶生效（「媒体 → 管理存储桶」里每个桶还能各填一个，桶的优先）',
        },
        {
          key: 'mediaPublicUrl',
          label: '代理地址前缀',
          hint: '没填直链域名时图片走 Worker 代理（站内路径 /api/media/桶/键）。站点与接口不同源时，正文里要写绝对地址 —— 这里填**接口自己的根地址**（如 https://zero-api.xxx.workers.dev），留空则按 apiBaseUrl 兜底。它不是图片域名，别填成 CDN',
        },
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
        { key: 'emailDailyLimit', label: '每日发信上限', kind: 'number', hint: '按 UTC 日界计数，填 0 表示不限制' },
        { key: 'emailFrom', label: '发件邮箱' },
        { key: 'emailFromName', label: '发件人名称' },
        { key: 'smtpHost', label: 'SMTP 服务器' },
        { key: 'smtpPort', label: 'SMTP 端口', kind: 'number' },
        {
          key: 'smtpSecure',
          label: '使用 SSL/TLS',
          kind: 'bool',
          hint: '',
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
        { key: 'friendsAutoCheck', label: '定时检测存活', kind: 'bool' },
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
        { key: 'friendApplyRequireReview', label: '申请需人工审核', kind: 'bool' },
        { key: 'friendApplyAutoPublish', label: '通过后自动写友链文件', kind: 'bool', hint: '只管这一条路径：关掉就只进数据库、不提交 links.yaml，与投稿那个开关互不影响' },
        { key: 'friendApplyBlocklist', label: '申请黑名单关键词', kind: 'lines', hint: '一行一个，站名/网址/描述命中即直接拒绝' },
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
        {
          key: 'githubDataDir',
          label: '数据目录',
          hint: '后台读写 data/*.json（导航、首页、页脚、友链状态、变体清单…）与 links.yaml、authors.yaml 时用的前缀，默认 data；把站点数据挪到别的目录才需要改，改完「前端管理」九段与友链检测都跟着走这里',
        },
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
        },
        {
          key: 'emailTemplateSubscribe',
          label: '② 订阅确认模板',
          kind: 'textarea',
        },
        {
          key: 'emailTemplateComment',
          label: '③ 新评论提醒模板',
          kind: 'textarea',
          hint: '回复提醒那一封会多出「你原来的评论」那一段（占位符 {parent}，非回复时不留痕）',
        },
        {
          key: 'emailTemplateNotice',
          label: '④ 其它通知模板（默认信）',
          kind: 'textarea',
          hint: '审核结果、新文章推送等都走这一封',
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
          hint: '评论通知等给站长的信发到这里。留空就发到「发信方式」里的发件邮箱。此项方便发信邮箱配置与站长邮箱不一致的情况',
        },
        { key: 'commentNotifyReply', label: '被回复时提醒', kind: 'bool' },
        { key: 'commentNotifyAuthor', label: '提醒文章作者', kind: 'bool' },
        { key: 'commentShowMeta', label: '前台展示属地 / 设备等信息', kind: 'bool' },
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
  /**
   * 每封能用的占位符表也来自后端同一份 TEMPLATE_VARS。
   * 以前这四个字段的提示语是这里手抄的，接口加了 {parent} 后台却还写着旧的六个，
   * 站主照提示写模板就会漏参数 —— 一份事实不该在这里抄第二遍。
   */
  let emailVars = $state<Record<string, { name: string; desc: string }[]>>({});

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
      const d = await get<{ data: { defaults: Record<string, string>; vars?: Record<string, { name: string; desc: string }[]> } }>('/api/admin/email/templates');
      emailDefaults = d.data.defaults || {};
      emailVars = d.data.vars || {};
    } catch {
      // 拿不到默认文本只影响「填回默认」按钮，编辑与保存照常
      emailDefaults = {};
      emailVars = {};
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

  /** 配置键 → 模板种类：emailTemplateComment → comment（后端那份占位符表按种类给） */
  const tplKind = (key: string) => key.replace(/^emailTemplate/, '').toLowerCase();

  /** 一节显示哪几个字段：顺序按 keys 给，fields 只是键的元数据来源 */
  function sectionFields(group: Group, s: Section): Field[] {
    const byKey = new Map(group.fields.map((f) => [f.key, f]));
    return s.keys.flatMap((k) => byKey.get(k) ?? []);
  }

  /**
   * 没选中的发信通道那一节直接不显示；配置还没读回来时按默认值 smtp 对待。
   */
  function visibleSections(g: Group, values: Record<string, string>): Section[] {
    const now = (values['emailProvider'] || 'smtp').trim();
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
    const value =
      typeof raw === 'number' ? String(raw) : typeof raw === 'boolean' ? String(raw) : String(raw ?? '');
    cfg[key] = value;
    /* 切 AI 服务商时把默认端点/模型带出来：否则下面两格一直是空的，站主不知道到底会用哪个模型 */
    if (key === 'aiProvider') {
      const preset = AI_DEFAULTS.get(value);
      if (preset) {
        cfg.aiEndpoint = preset.endpoint;
        cfg.aiModel = preset.model;
      }
    }
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
  /** 每个键的输入上限：由接口和写入闸门共用一张表算出来，界面不另抄一份数字（抄了就会漂） */
  let maxLen = $state<Record<string, number>>({});
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let notice = $state('');
  /* 保存结果不再写在页面最上方（页面一长就看不见），统一走右上角浮层 */
  flash('err', () => error);
  flash('ok', () => notice);
  let openGroup = $state<string | null>('注册与邀请码');

  async function load() {
    void loadEmailTemplates();
    loading = true;
    error = '';
    try {
      const d = await get<{ data: Record<string, string>; hasSecret?: Record<string, boolean>; maxLen?: Record<string, number> }>('/api/admin/config');
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
      maxLen = d.maxLen ?? {};
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
      const d = await patch<{
        data: {
          updated: number;
          failed?: { key: string; error: string }[];
          cspSync?: { written: string[]; origins: string[]; notes?: string[]; error?: string };
        };
      }>('/api/admin/config', payload);
      clearSecrets = [];
      await load();
      /* 后端现在是逐项写的，个别项失败必须说清楚是哪几项：以前一律「已保存 N 项」，写失败也照说 */
      const failed = d.data?.failed ?? [];
      if (failed.length) error = `${failed.length} 项没写进去：${failed.map((f) => `${f.key}（${f.error}）`).join('、')}`;
      notice = d.data?.updated ? `已保存 ${d.data.updated} 项` : '提交的内容与现值相同，没有改动';
      /* 评论接口域进 CSP 这件事是「保存顺带改了仓库两份文件」，必须让他看得见改了什么：
         看不见的话，将来评论区空白时会先怀疑评论系统本身。这句比上面那句长，多留几秒。 */
      const csp = d.data?.cspSync;
      if (csp) {
        if (csp.error) notice += `；CSP 没同步：${csp.error}`;
        else if (csp.written?.length) {
          notice += `；评论接口域已写进 CSP（${csp.origins.join('、') || '已摘除不再用的域'}，改了 ${csp.written.join(' 与 ')}，Pages 会随之重建）`;
        } else if (csp.notes?.length) notice += `；CSP：${csp.notes.join(' ')}`;
        setTimeout(() => (notice = ''), 12000);
      } else {
        setTimeout(() => (notice = ''), 3000);
      }
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

  /** 设置项搜索：按键名或标签过滤；有搜索词时各组自动展开、只留命中的字段 */
  let q = $state('');
  const matchField = (f: { key: string; label: string }) => {
    const k = q.trim().toLowerCase();
    return !k || (f.label + ' ' + f.key).toLowerCase().includes(k);
  };
  const groupHasMatch = (g: Group) => {
    const list = g.sections ? g.sections.flatMap((s) => sectionFields(g, s)) : g.fields;
    return list.some(matchField);
  };
</script>

<div class="row spread head">
  <h2>站点设置</h2>
  <div class="row">
    <input class="cfgq" type="search" placeholder="搜索设置项" bind:value={q} aria-label="搜索设置项" />
    <span class="muted small">{changed.length ? `${changed.length} 项未保存` : '全部已保存'}</span>
    <button class="sm" onclick={() => void load()} disabled={loading}>{loading ? '读取中…' : '重新读取'}</button>
    <button class="primary" onclick={() => void save()} disabled={saving || !changed.length}>
      {saving ? '保存中…' : '保存修改'}
    </button>
  </div>
</div>

{#if changed.length}
  <div class="savebar" role="status">
    <span>{changed.length} 项未保存</span>
    <button class="primary" onclick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存修改'}</button>
  </div>
{/if}

{#snippet fieldList(list: Field[])}
  {@const bools = list.filter((f) => f.kind === 'bool')}
  {@const rest = list.filter((f) => f.kind !== 'bool')}
  {#if bools.length}
    <div class="bools">
      {#each bools as f (f.key)}
        <div class="bool">
          <label class="switch">
            <input type="checkbox" checked={boolValue(f.key)} onchange={(e) => setVal(f.key, e.currentTarget.checked)} />
            <span>{f.label}</span>
          </label>
          {#if f.hint}<span class="muted hint">{f.hint}</span>{/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if rest.length}
  <div class="fields">
    {#each rest as f (f.key)}
      <div class="field {f.kind === 'textarea' || f.kind === 'lines' ? 'wide' : ''}">
        {#if f.kind === 'select'}
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
              maxlength={maxLen[f.key]}
              value={cfg[f.key] ?? ''}
              oninput={(e) => setVal(f.key, e.currentTarget.value)}
            ></textarea>
          </label>
        {:else}
          <label>
            {f.label}
            {#if f.kind === 'secret'}
              <div class="secretrow">
                <input
                  type="password"
                  maxlength={maxLen[f.key]}
                  value={cfg[f.key] ?? ''}
                  oninput={(e) => setVal(f.key, e.currentTarget.value)}
                  placeholder={secretSet.includes(f.key) ? '已设置（留空不修改）' : ''}
                  autocomplete="new-password"
                />
                {#if secretSet.includes(f.key)}
                  <button type="button" class="sm" title="清除服务端已存的这份密钥" onclick={() => toggleClear(f.key)}>
                    {clearSecrets.includes(f.key) ? '撤回' : '清除'}
                  </button>
                {/if}
              </div>
            {:else}
              <input
                type={f.kind === 'number' ? 'number' : 'text'}
                maxlength={maxLen[f.key]}
                value={cfg[f.key] ?? ''}
                oninput={(e) => setVal(f.key, e.currentTarget.value)}
                autocomplete="on"
              />
            {/if}
          </label>
        {/if}
        {#if f.hint}<span class="muted hint">{f.hint}</span>{/if}
        {#if (emailVars[tplKind(f.key)] ?? []).length}
          <span class="muted hint">
            可用占位符：
            {#each emailVars[tplKind(f.key)] as v (v.name)}
              <code>{v.name}</code>{v.desc}
            {/each}
          </span>
        {/if}
      </div>
    {/each}
  </div>
  {/if}
{/snippet}

{#snippet testSend()}
  <div class="row testrow">
    <label class="inline testto">
      测试收件人
      <input bind:value={testTo} placeholder="you@example.com" />
    </label>
  </div>
  <div class="row testrow">
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
    <button class="sm" onclick={() => void runNotifyTest()} disabled={notifyBusy}>
      {notifyBusy ? '两封发送中…' : '通知链路自检（站长那封 + 用户那封各一封）'}
    </button>
  </div>
  <span class="muted small">收件人不填就发给你自己；通知链路自检走的是新评论提醒真正用的那套收件人算法与模板。</span>
  {#if testResult}
    <p class="small testresult {testResult.ok ? 'ok' : 'err'}">{testResult.text}</p>
  {/if}
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
  {#if !q.trim() || groupHasMatch(g)}
  <section class="card group">
    <button class="group-head" onclick={() => (openGroup = openGroup === g.title ? null : g.title)}>
      <span>{g.title}</span>
      <span class="muted small">{openGroup === g.title || q.trim() ? '收起' : '展开'}</span>
    </button>
    {#if openGroup === g.title || q.trim()}
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
        {#each visibleSections(g, cfg) as s (s.title)}
          <div class="subgroup">
            <h3 class="subgroup-title">{s.title}</h3>
            {#if s.desc}<p class="muted small subdesc">{s.desc}</p>{/if}
            {#if s.test}
              {@render testSend()}
            {:else}
              {@render fieldList(sectionFields(g, s).filter(matchField))}
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
        {@render fieldList(g.fields.filter(matchField))}
      {/if}
    {/if}
  </section>
  {/if}
{/each}

<p class="muted small foot">修改后立即生效（配置缓存 30 秒内刷新）；前台需重新构建的项以 Hugo 参数为准。</p>

<style>
  .head {
    margin-bottom: 0.7rem;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .cfgq {
    width: 12rem;
  }
  .savebar {
    position: fixed;
    left: 50%;
    transform: translateX(-50%);
    bottom: 1.1rem;
    z-index: 50;
    display: flex;
    align-items: center;
    gap: 0.8rem;
    padding: 0.55rem 0.7rem 0.55rem 1rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--panel);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
    font-size: 0.84rem;
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
  .testto {
    flex: 1 1 100%;
  }
  .testto input {
    width: 100%;
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
  .bools {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.7rem 1.2rem;
    padding: 0.8rem 1rem 0.2rem;
  }
  .bool {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
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
  .secretrow {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .secretrow input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .secretrow button {
    flex: none;
    min-height: var(--ctl-h);
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
  @media (max-width: 720px) {
    .bools,
    .fields {
      grid-template-columns: 1fr;
    }
  }
  .foot {
    margin-top: 1rem;
  }
</style>
