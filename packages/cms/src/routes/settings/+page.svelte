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
        { key: 'allowRegister', label: '允许注册', kind: 'bool' },
        { key: 'requireInviteCode', label: '注册需邀请码', kind: 'bool', hint: '邀请码在「用户」页的「邀请码」tab 生成' },
        { key: 'requireEmailVerified', label: '登录前必须验证邮箱', kind: 'bool' },
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
        { key: 'commentAllowAnonymous', label: '允许游客评论', kind: 'bool' },
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
        { key: 'subscribePushEnabled', label: '新文章自动推送', kind: 'bool', hint: '定时任务比对 RSS，只发给已确认订阅者' },
        { key: 'subscribeFeedUrl', label: '用于比对的 RSS 地址', hint: '例如 https://你的站点/index.xml' },
      ],
    },
    {
      title: '头像与媒体',
      desc: '{hash} 会被替换为邮箱的 MD5；公开版不内置任何个人信息。',
      fields: [
        { key: 'avatarTemplate', label: '头像地址模板', hint: 'cravatar.cn（国内可达）或 gravatar.com' },
        { key: 'mediaBaseUrl', label: '媒体公开域名', hint: 'R2 自定义域名或 CDN，留空则走后台代理链接' },
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
        { key: 'smtpSecure', label: '使用 SSL/TLS', kind: 'bool' },
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
        { title: '测试发送', desc: '真发一封才知道配置对不对 —— 本地没有邮件服务，看着填对了也可能发不出去。', keys: [], test: true },
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
        { key: 'friendApplyAutoPublish', label: '通过后自动写友链文件', kind: 'bool', hint: '需要仓库写回开关打开，否则只记录不发布' },
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
        { key: 'gitWritebackEnabled', label: '开启前端参数写回', kind: 'bool', hint: '「前端管理」页与友链数据写回都依赖此开关' },
        { key: 'githubLinksFile', label: '友链文件', hint: '如 data/links.yaml' },
        { key: 'githubAuthorsFile', label: '作者数据文件', hint: '如 data/authors.yaml' },
        { key: 'cloudflarePagesBuildHook', label: 'Pages 重建 Hook', hint: '选填，填了改完友链会自动重建站点' },
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
        { key: 'commentNotifyAdmin', label: '新评论提醒管理员', kind: 'bool' },
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
      const d = await post<{ data: { sent: boolean; error: string | null; to: string } }>('/api/admin/email/test', {
        to: testTo.trim(),
        kind: testKind,
      });
      testResult = d.data.sent
        ? { ok: true, text: `已发到 ${d.data.to}，去邮箱（含垃圾邮件箱）看一下` }
        : { ok: false, text: `发送失败：${d.data.error ?? '未知原因'}` };
    } catch (e) {
      testResult = { ok: false, text: `发送失败：${e instanceof Error ? e.message : '请求出错'}` };
    } finally {
      testBusy = false;
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
    { label: 'QQ 邮箱 587', host: 'smtp.qq.com', port: '587', secure: 'true' },
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
   * 保存时决定一个键写回什么类型。不能从面板字段反查：评论审核规则这类键在别的页面维护，
   * 反查不到就会把 true 存成 "true" 字符串，前台开关直接失效。
   */
  function coerce(key: string, raw: string): string | number | boolean {
    if (LINES_KEYS.has(key)) {
      return JSON.stringify(
        raw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    if (TEXT_KEYS.has(key)) return raw;
    if (raw === 'true' || raw === 'false') return raw === 'true';
    if (raw !== '' && /^-?\d+(\.\d+)?$/.test(raw.trim())) return Number(raw);
    if (/^\[.*\]$/.test(raw.trim())) return raw;
    return raw;
  }

  let cfg = $state<Record<string, string>>({});
  let saved = $state<Record<string, string>>({});
  /** 服务端已经存了值的密钥键名（读取不回传原文，靠这个标记提示「已设置」） */
  let secretSet = $state<string[]>([]);
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
      const next: Record<string, string> = { ...d.data };
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
    Object.keys(cfg).filter((k) => (cfg[k] ?? '') !== (saved[k] ?? '')),
  );

  async function save() {
    if (!changed.length) return;
    const count = changed.length;
    const payload: Record<string, string | number | boolean> = {};
    for (const key of changed) {
      payload[key] = coerce(key, cfg[key] ?? '');
    }
    saving = true;
    error = '';
    try {
      await patch('/api/admin/config', payload);
      await load();
      notice = `已保存 ${count} 项`;
      setTimeout(() => (notice = ''), 3000);
    } catch (e) {
      error = e instanceof Error ? e.message : '保存失败';
    } finally {
      saving = false;
    }
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
            <input type="checkbox" checked={boolValue(f.key)} onchange={(e) => (cfg[f.key] = e.currentTarget.checked ? 'true' : 'false')} />
            <span>{f.label}</span>
          </label>
        {:else if f.kind === 'select'}
          <label>
            {f.label}
            <select bind:value={cfg[f.key]}>
              {#each f.options ?? [] as o}<option value={o.value}>{o.label}</option>{/each}
            </select>
          </label>
        {:else if f.kind === 'textarea' || f.kind === 'lines'}
          <label>
            {f.label}
            <textarea rows={f.kind === 'lines' ? 4 : 3} bind:value={cfg[f.key]}></textarea>
          </label>
        {:else}
          <label>
            {f.label}
            <input
              type={f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'number' : 'text'}
              bind:value={cfg[f.key]}
              placeholder={f.kind === 'secret' && secretSet.includes(f.key) ? '已设置（留空不修改）' : ''}
              autocomplete={f.kind === 'secret' ? 'new-password' : 'on'}
            />
          </label>
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
  <p class="muted small">测试信用的就是上面几节的发信配置与「邮件模板」里填的正文，改了先保存再发才准。</p>
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
