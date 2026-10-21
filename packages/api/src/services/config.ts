import { eq } from 'drizzle-orm';
import { DEFAULT_TEMPLATES } from './email-templates';
import { siteConfig, users } from '../db/schema';
import { createDb } from '../db/client';

/**
 * 配置分层：site_config 表（后台可改） > wrangler vars > 代码默认值。
 * 公开版本不写死任何配置，全部走这条链路。
 */

export type ConfigKey =
  // 站点信息
  | 'siteName'
  | 'siteDescription'
  | 'siteLogo'
  | 'siteFavicon'
  | 'author'
  /** 站长本人在 data/authors.yaml 里的作者标识；邮件落款与 SEO 的作者兜底读它 */
  | 'defaultAuthor'
  | 'siteUrl'
  /**
   * 后台（zero-cms）自己的地址。前台「登录 → 管理员跳后台」读它：
   * 后台是独立的 Pages 项目，不同域，主题按同域 /admin/ 兜底必然是 404。
   * 管理员第一次登录时由后端记下请求来源，也可以在这里手工改。
   */
  | 'cmsAdminUrl'
  // 注册与邀请码
  | 'accountSystemEnabled'
  | 'allowRegister'
  | 'requireInviteCode'
  | 'inviteCodeLength'
  | 'inviteCodeUses'
  // 评论
  | 'commentEnabled'
  | 'commentProvider'
  | 'commentProviders'
  | 'momentCommentProvider'
  | 'commentRequireReview'
  | 'commentRateLimit'
  | 'commentMaxDepth'
  | 'commentAllowAnonymous'
  // 点赞
  | 'likeEnabled'
  | 'likeAllowAnonymous'
  | 'starEnabled'
  // 订阅
  | 'subscribeEnabled'
  | 'subscribeDoubleOptIn'
  | 'subscribePushEnabled'
  | 'subscribeFeedUrl'
  // 头像与媒体
  | 'avatarTemplate'
  | 'mediaBaseUrl'
  // 邮件
  | 'emailProvider'
  | 'emailFrom'
  | 'emailFromName'
  /** 每天最多发多少封（发信服务多按天限量，Resend 免费档 100 封/天）；0 = 不限制 */
  | 'emailDailyLimit'
  | 'smtpHost'
  | 'smtpPort'
  | 'smtpSecure'
  | 'smtpUser'
  /** 邮箱密码 / 授权码：可以在后台填（存 D1、读取脱敏），也可以继续用 wrangler secret */
  | 'smtpPassword'
  | 'resendApiKey'
  | 'cloudflareAccountId'
  | 'cloudflareEmailToken'
  // 友链
  | 'friendsEnabled'
  | 'friendsAutoCheck'
  | 'friendsCheckOnlyRss'
  | 'friendsCheckIntervalHours'
  /** 连续不可访问多少天进「迷失的小船」（页面承诺 30） */
  | 'friendsLostAfterDays'
  /** 多少天没有新动态进「迷失的小船」（页面承诺 90，只看填了 RSS 的站） */
  | 'friendsStaleAfterDays'
  | 'friendApplyEnabled'
  | 'friendApplyRequireReview'
  | 'friendApplyAutoPublish'
  | 'friendApplyBlocklist'
  // 时刻
  | 'momentsEnabled'
  /** 工坊页 /work/、关于页 /about/ 是否对外开放（关掉后前台隐藏入口，边缘直接 404） */
  | 'workEnabled'
  | 'aboutEnabled'
  // 统计
  | 'analyticsEnabled'
  | 'analyticsRetentionDays'
  /** 统计日界的时区偏移（小时），默认 8 = 东八区 */
  | 'statsUtcOffsetHours'
  // 文章统计导出：首页精选与「最热」在构建期排序的数据源
  | 'poststatsEnabled'
  | 'poststatsViewWindowDays'
  // 评论审核（广告、违法、色情、赌博等垃圾内容）
  | 'spamEnabled'
  | 'spamThreshold'
  | 'spamKeywords'
  | 'spamLinkRatio'
  | 'spamMaxUrls'
  | 'spamMinWords'
  | 'spamHoldPending'
  | 'spamRuleWeight'
  | 'spamUseBuiltinPatterns'
  | 'spamExternalProvider'
  | 'spamExternalEndpoint'
  | 'spamExternalKey'
  // 机器辅助翻译
  | 'translateProvider'
  | 'translateEndpoint'
  | 'translateModel'
  | 'translateKey'
  // 用户中心：投稿与作者认证的全站总闸（具体某人能不能用，看后台勾的权限位）
  | 'draftsEnabled'
  | 'authorVerifyEnabled'
  // SEO 不在这里：那一份参数是构建期的，走「前端管理 → SEO」写 data/seo.json
  // 内容提交回 Git（zero-cms 发布文章用）
  | 'githubOwner'
  | 'githubRepo'
  | 'githubBranch'
  | 'githubContentDir'
  | 'githubLinksFile'
  | 'cloudflarePagesBuildHook'
  /** 站点所在 Cloudflare 域（zone）的 ID：删文章后按 URL 清边缘缓存要用 */
  | 'cfZoneId'
  /** Purge Cache 的令牌，只写不回读 */
  | 'cfPurgeToken'
  /** 接口自己的域名（邮件里的确认 / 退订链接用它拼绝对地址），首次请求自动记下 */
  | 'apiBaseUrl'
  /* 评论提醒与展示 */
  | 'commentNotifyAdmin'
  /** 新评论等「给站长」的邮件收件地址；留空回落到发件邮箱 emailFrom */
  | 'adminNotifyEmail'
  | 'commentNotifyReply'
  | 'commentNotifyAuthor'
  | 'commentShowMeta'
  | 'commentEmojiPacks'
  /* 邮件 HTML 模板 */
  | 'emailTemplateCode'
  | 'emailTemplateSubscribe'
  | 'emailTemplateComment'
  | 'emailTemplateNotice'
  /* 评论审核扩展 */
  | 'spamCustomRegex'
  | 'spamProviderKind'
  | 'spamProviderEndpoint'
  | 'spamProviderKeyId'
  | 'spamProviderSecret'
  /* 媒体存储 */
  | 'mediaBuckets'
  | 'mediaPublicUrl'
  /* 仓库写入路径 */
  | 'githubPostsDir'
  | 'githubMomentsDir'
  | 'githubAuthorsFile'
  | 'githubDataDir'
  /* 管理员登录安全 */
  | 'adminLoginPolicy'
  | 'totpIssuer';

/** 全部可写配置项：后台读取列表与保存校验都以这份清单为准 */
export const ALL_CONFIG_KEYS: ConfigKey[] = [
  'siteName',
  'siteDescription',
  'siteLogo',
  'siteFavicon',
  'author',
  'defaultAuthor',
  'siteUrl',
  'cmsAdminUrl',
  'accountSystemEnabled',
  'allowRegister',
  'requireInviteCode',
  'inviteCodeLength',
  'inviteCodeUses',
  'commentEnabled',
  'commentProvider',
  'commentProviders',
  'momentCommentProvider',
  'commentRequireReview',
  'commentRateLimit',
  'commentMaxDepth',
  'commentAllowAnonymous',
  'likeEnabled',
  'likeAllowAnonymous',
  'starEnabled',
  'subscribeEnabled',
  'subscribeDoubleOptIn',
  'subscribePushEnabled',
  'subscribeFeedUrl',
  'avatarTemplate',
  'mediaBaseUrl',
  'emailProvider',
  'emailFrom',
  'emailFromName',
  'emailDailyLimit',
  'smtpHost',
  'smtpPort',
  'smtpSecure',
  'smtpUser',
  'smtpPassword',
  'resendApiKey',
  'cloudflareAccountId',
  'cloudflareEmailToken',
  'friendsEnabled',
  'friendsAutoCheck',
  'workEnabled',
  'aboutEnabled',
  'friendsCheckOnlyRss',
  'friendsCheckIntervalHours',
  'friendsLostAfterDays',
  'friendsStaleAfterDays',
  'friendApplyEnabled',
  'friendApplyRequireReview',
  'friendApplyAutoPublish',
  'friendApplyBlocklist',
  'momentsEnabled',
  'analyticsEnabled',
  'analyticsRetentionDays',
  'statsUtcOffsetHours',
  'poststatsEnabled',
  'poststatsViewWindowDays',
  'spamEnabled',
  'spamThreshold',
  'spamKeywords',
  'spamLinkRatio',
  'spamMaxUrls',
  'spamMinWords',
  'spamHoldPending',
  'spamRuleWeight',
  'spamUseBuiltinPatterns',
  'spamExternalProvider',
  'spamExternalEndpoint',
  'spamExternalKey',
  'translateProvider',
  'translateEndpoint',
  'translateModel',
  'translateKey',
  'draftsEnabled',
  'authorVerifyEnabled',
  'githubOwner',
  'githubRepo',
  'githubBranch',
  'githubContentDir',
  'githubLinksFile',
  'cloudflarePagesBuildHook',
  'cfZoneId',
  'cfPurgeToken',
  'apiBaseUrl',
  'commentNotifyAdmin',
  'adminNotifyEmail',
  'commentNotifyReply',
  'commentNotifyAuthor',
  'commentShowMeta',
  'commentEmojiPacks',
  'emailTemplateCode',
  'emailTemplateSubscribe',
  'emailTemplateComment',
  'emailTemplateNotice',
  'spamCustomRegex',
  'spamProviderKind',
  'spamProviderEndpoint',
  'spamProviderKeyId',
  'spamProviderSecret',
  'mediaBuckets',
  'mediaPublicUrl',
  'githubPostsDir',
  'githubMomentsDir',
  'githubAuthorsFile',
  'githubDataDir',
  'adminLoginPolicy',
  'totpIssuer',
];

interface Row {
  key: string;
  value: string;
  valueType: string;
}

/**  isolate 内的短期缓存：同一 Worker 实例复用，避免每请求全表扫描 */
const cache = new Map<string, Row | null>();
let cacheLoaded = false;
let cacheStamp = 0;
const CACHE_TTL_MS = 30_000;

/** wrangler vars 里的默认值，键名与 [params] 对齐 */
function fromVars(env: Env, key: ConfigKey): string | undefined {
  switch (key) {
    case 'siteName':
      return env.SITE_NAME;
    case 'commentMaxDepth':
      return env.COMMENT_MAX_DEPTH;
    case 'githubOwner':
      return env.GITHUB_OWNER;
    case 'githubRepo':
      return env.GITHUB_REPO;
    case 'githubBranch':
      return env.GITHUB_BRANCH;
    default:
      return undefined;
  }
}

/** 代码兜底：只放与安全无关的中性默认值 */
const STATIC_DEFAULTS: Partial<Record<ConfigKey, string>> = {
  accountSystemEnabled: 'true',
  allowRegister: 'true',
  requireInviteCode: 'false',
  inviteCodeLength: '8',
  inviteCodeUses: '1',
  commentEnabled: 'true',
  commentRequireReview: 'false',
  commentRateLimit: '10',
  commentMaxDepth: '6',
  commentAllowAnonymous: 'true',
  likeEnabled: 'true',
  likeAllowAnonymous: 'true',
  starEnabled: 'true',
  subscribeEnabled: 'true',
  subscribeDoubleOptIn: 'true',
  subscribePushEnabled: 'true',
  subscribeFeedUrl: '',
  emailProvider: 'smtp',
  emailDailyLimit: '100',
  /**
   * 头像模板默认留空 = 用内置那条链（Gravatar → Cravatar → QQ 号 → 首字母，见 lib/avatar.ts）。
   * 填了就整条链换图床、顶到最前面。以前默认值是 cravatar 的 `d=mp`（没有头像也给一张通用灰影人），
   * 那等于把链条锁死在第一级：本人明明在 Gravatar / QQ 上有图也永远取不到，
   * 所以这个默认必须空着，让链条自己往下退。
   */
  avatarTemplate: '',
  smtpPort: '587',
  /**
   * 握手方式主要看端口：465 一定是隐式 TLS（实测明文连过去对方不应答）。
   * 这一项只在非 465 端口上生效，勾了表示「这个端口也只收隐式 TLS」（自建中继常见）。
   * 默认必须是 false：静态默认一旦是 true，587 / 2525 也会被当成语义上的 TLS 端口，
   * 而对端要的是 STARTTLS —— 握手直接失败，验证码一封都发不出去。
   */
  smtpSecure: 'false',
  friendsEnabled: 'true',
  friendsAutoCheck: 'true',
  /** true = 每天的可用性检测只检填了 RSS 地址的友链 */
  friendsCheckOnlyRss: 'true',
  friendsCheckIntervalHours: '24',
  friendsLostAfterDays: '30',
  friendsStaleAfterDays: '90',
  momentsEnabled: 'true',
  /** 工坊页 /work/、关于页 /about/：默认开；关掉后前台入口隐藏、边缘直接 404（见内容仓库 functions/_middleware.ts） */
  workEnabled: 'true',
  aboutEnabled: 'true',
  analyticsEnabled: 'true',
  analyticsRetentionDays: '365',
  statsUtcOffsetHours: '8',
  poststatsEnabled: 'true',
  /** 0 = 阅读量按全量累计；填 N 只统计最近 N 天，让精选偏向新内容 */
  poststatsViewWindowDays: '0',
  commentProvider: 'zero',
  commentProviders: '{"waline":{},"twikoo":{},"giscus":{},"artalk":{}}',
  momentCommentProvider: 'zero',
  friendApplyEnabled: 'true',
  friendApplyRequireReview: 'true',
  friendApplyAutoPublish: 'true',
  friendApplyBlocklist: '[]',
  spamEnabled: 'true',
  spamThreshold: '60',
  spamKeywords: '[]',
  spamLinkRatio: '0.5',
  spamMaxUrls: '3',
  spamMinWords: '2',
  /** true（默认）= 命中垃圾先进「待审核」由人判定；false = 直接标成 spam 进「垃圾评论」队列 */
  spamHoldPending: 'true',
  /** 明确规则（关键词 / 默认规则集 / 自定义正则 / 仓库文件）的单条命中分；默认 70 高于 spamThreshold 60，一条即拦 */
  spamRuleWeight: '70',
  spamUseBuiltinPatterns: 'true',
  spamExternalProvider: 'none',
  spamExternalEndpoint: '',
  spamExternalKey: '',
  translateProvider: 'none',
  translateEndpoint: '',
  translateModel: '',
  translateKey: '',
  draftsEnabled: 'true',
  authorVerifyEnabled: 'true',
  githubLinksFile: 'data/links.yaml',
  cloudflarePagesBuildHook: '',
  cfZoneId: '',
  cfPurgeToken: '',
  apiBaseUrl: '',
  githubBranch: 'main',
  commentNotifyAdmin: 'true',
  // 站长的收件箱：不填就发到发件邮箱（很多站就是同一个邮箱，没必要多填一次）
  adminNotifyEmail: '',
  commentNotifyReply: 'true',
  commentNotifyAuthor: 'true',
  commentShowMeta: 'true',
  commentEmojiPacks:
    '["😀","😄","😂","🤣","😊","😍","😘","😜","🤔","😎","😭","😅","🙁","😡","👍","👎","👏","🙏","💪","🔥","✨","🎉","💯","❤️","💔","🌟","🌈","☕","🍺","🐶"]',
  emailTemplateCode: DEFAULT_TEMPLATES.code,
  emailTemplateSubscribe: DEFAULT_TEMPLATES.subscribe,
  emailTemplateComment: DEFAULT_TEMPLATES.comment,
  emailTemplateNotice: DEFAULT_TEMPLATES.notice,
  spamCustomRegex: '',
  spamProviderKind: 'none',
  spamProviderEndpoint: '',
  spamProviderKeyId: '',
  spamProviderSecret: '',
  mediaBuckets: '[{"id":"r2","label":"默认 R2","kind":"r2","binding":"R2","baseUrl":""}]',
  mediaPublicUrl: '',
  githubPostsDir: 'content/zh/posts',
  githubMomentsDir: 'content/zh/moments',
  githubAuthorsFile: 'data/authors.yaml',
  githubDataDir: 'data',
  adminLoginPolicy: 'password',
  totpIssuer: 'Zero',
};

async function loadRows(env: Env): Promise<void> {
  const now = Date.now();
  if (cacheLoaded && now - cacheStamp < CACHE_TTL_MS) return;
  cache.clear();
  try {
    const rows = await env.DB.prepare('select key, value, value_type from site_config').all<Row>();
    for (const r of rows.results ?? []) cache.set(r.key, r);
  } catch {
    // 表尚未建立（还没跑迁移）时不应让整个 API 挂掉
  }
  cacheLoaded = true;
  cacheStamp = now;
}

export async function getConfig(env: Env, key: ConfigKey): Promise<string | undefined> {
  await loadRows(env);
  const row = cache.get(key);
  if (row && row.value !== '') return row.value;
  return fromVars(env, key) ?? STATIC_DEFAULTS[key];
}

export async function getConfigBool(env: Env, key: ConfigKey, fallback = false): Promise<boolean> {
  const v = await getConfig(env, key);
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

export async function getConfigInt(env: Env, key: ConfigKey, fallback = 0): Promise<number> {
  const v = await getConfig(env, key);
  const n = v === undefined ? NaN : Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

export async function getConfigJson<T>(env: Env, key: ConfigKey, fallback: T): Promise<T> {
  const v = await getConfig(env, key);
  if (!v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/** 后台保存设置时调用，写入后立刻失效缓存 */
export async function setConfig(env: Env, key: ConfigKey, value: string, valueType = 'string'): Promise<void> {
  const db = createDb(env);
  await db
    .insert(siteConfig)
    .values({ key, value, valueType, updatedAt: Math.floor(Date.now() / 1000) })
    .onConflictDoUpdate({ target: siteConfig.key, set: { value, valueType, updatedAt: Math.floor(Date.now() / 1000) } });
  cache.delete(key);
  cacheLoaded = false;
}

/**
 * 直接写 site_config 的地方（备份恢复整批 upsert，里面可能有当前版本已不认识的键，
 * 走 setConfig 会被键名校验挡掉）之后调一次。
 * 不清缓存的话，恢复完最多 30 秒内读到的还是旧值，界面上看着像「导入没生效」。
 */
export function invalidateConfigCache(): void {
  cache.clear();
  cacheLoaded = false;
}

export async function getAllConfig(env: Env): Promise<Record<string, string>> {
  await loadRows(env);
  const out: Record<string, string> = {};
  for (const key of ALL_CONFIG_KEYS) {
    out[key] = (await getConfig(env, key)) ?? '';
  }
  return out;
}

export function isConfigKey(key: string): key is ConfigKey {
  return (ALL_CONFIG_KEYS as string[]).includes(key);
}

/**
 * 密钥类配置项：绝不把原文回传给浏览器。
 * 读取时统一返回空串，配合后台「只提交改动项」的保存语义——留空即保持不变。
 */
export const SECRET_KEYS: ConfigKey[] = [
  'smtpPassword',
  'resendApiKey',
  'cloudflareEmailToken',
  'cloudflarePagesBuildHook',
  'cfPurgeToken',
  'spamExternalKey',
  'spamProviderKeyId',
  'spamProviderSecret',
  'translateKey',
];

export function isSecretKey(key: string): boolean {
  return (SECRET_KEYS as string[]).includes(key);
}

/**
 * 只有「数字」这一种读法的配置项：接口一律走 getConfigInt / Number(getConfig(...))。
 *
 * 为什么要单独列出来：这些键在库里存的是字符串，入口不拦的话，一个非数字的值也能"保存成功"，
 * 而读的时候解析失败就悄悄回落默认值 —— 表现正是「后台改了、站点没反应」（P-08 那一类的另一半）。
 * 后台那些框是 `<input type="number">`，人手打不出字母，但接口是公开的写入面，得自己站住。
 */
export const NUMERIC_CONFIG_KEYS: ConfigKey[] = [
  'analyticsRetentionDays',
  'commentMaxDepth',
  'commentRateLimit',
  'emailDailyLimit',
  'inviteCodeLength',
  'inviteCodeUses',
  'poststatsViewWindowDays',
  'spamMaxUrls',
  'spamMinWords',
  'spamRuleWeight',
  'spamThreshold',
  'spamLinkRatio',
  'statsUtcOffsetHours',
  'friendsCheckIntervalHours',
  'friendsLostAfterDays',
  'friendsStaleAfterDays',
];

/** 空串表示「不改 / 用默认值」，所以只有非空且不是数字才算错 */
export function numericKeyBadValue(key: string, value: string): boolean {
  if (!(NUMERIC_CONFIG_KEYS as string[]).includes(key)) return false;
  return value !== '' && !/^[-+]?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * 只有「枚举里那几个值」这一种读法的配置项：值来自后台的 <select>，代码按值分流。
 *
 * 为什么要拦：评论那两项存成枚举外的值时不会报错，但主题运行时会拿它去覆盖服务端已经渲染好的
 * 评论区，而覆盖分支里没有这个值 —— 于是**每一篇文章页的评论区一起变成一句没有原因的
 * 「该评论系统暂时不可用」**，不重新构建就生效，界面与控制台都不给任何线索（体检台架就这么红过一整轮）。
 * 后台的框是 select，人手点不出非法值，但接口是公开的写入面，得自己站住。
 */
export const ENUM_CONFIG_KEYS: Record<string, string[]> = {
  commentProvider: ['zero', 'waline', 'twikoo', 'giscus', 'artalk'],
  momentCommentProvider: ['zero', 'waline', 'twikoo', 'giscus', 'artalk'],
  emailProvider: ['smtp', 'resend', 'cloudflare'],
};

/** 返回一句能直接给人看的文案；null 表示这个值可用（留空 = 用默认，也算可用） */
export function enumKeyBadValue(key: string, value: string): string | null {
  const allowed = ENUM_CONFIG_KEYS[key];
  if (!allowed) return null;
  const v = value.trim().toLowerCase();
  if (v === '' || allowed.includes(v)) return null;
  return `${key} 只接受 ${allowed.join(' / ')}（留空表示用默认），现在送的是「${value.trim().slice(0, 40)}」`;
}

/** 后台列表用的脱敏视图与「服务端是否已有值」标记 */
export function maskSecrets(all: Record<string, string>): { data: Record<string, string>; hasSecret: Record<string, boolean> } {
  const data: Record<string, string> = {};
  const hasSecret: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(all)) {
    if (isSecretKey(key)) {
      hasSecret[key] = value !== '';
      data[key] = '';
    } else {
      data[key] = value;
    }
  }
  return { data, hasSecret };
}

/** 前端一次拉全部公开配置，敏感项绝不进这个列表 */
const PUBLIC_KEYS: ConfigKey[] = [
  'siteName',
  'siteDescription',
  'siteLogo',
  'siteFavicon',
  'author',
  'siteUrl',
  'accountSystemEnabled',
  'allowRegister',
  'requireInviteCode',
  'commentEnabled',
  'commentProvider',
  'commentProviders',
  'momentCommentProvider',
  'commentMaxDepth',
  'commentAllowAnonymous',
  'commentRequireReview',
  'commentShowMeta',
  'commentEmojiPacks',
  'friendApplyEnabled',
  'friendApplyRequireReview',
  'likeEnabled',
  'likeAllowAnonymous',
  'starEnabled',
  'subscribeEnabled',
  'subscribeDoubleOptIn',
  'avatarTemplate',
  'friendsEnabled',
  'momentsEnabled',
  'workEnabled',
  'aboutEnabled',
  'draftsEnabled',
  'authorVerifyEnabled',
  'analyticsEnabled',
  'cmsAdminUrl',
];

/**
 * 站长联系邮箱：不再有配置键，直接取管理员账号注册时用的邮箱。
 * 「找回密码」提示与「登录已关闭」那句提示共用这一个来源，改密码用的邮箱和
 * 给用户看的邮箱不会各说一套；管理员换邮箱，前台提示跟着变。
 * 压一层 5 分钟内存缓存，命中就省一次 D1 读。
 *
 * 这个值**不进 /api/config**：Cloudflare 的邮箱保护只改写 HTML，JSON 接口是明文直达的，
 * 挂在整站公开配置里等于给每个来 curl 一下的爬虫送一份收件人名单。
 * 前端要它得走 GET /api/config/admin-email —— 只有真打开「找回密码」面板才会去要，且带限流。
 */
let contactCache: { at: number; value: string } | null = null;

export async function getAdminContactEmail(env: Env): Promise<string> {
  if (contactCache && Date.now() - contactCache.at < 300_000) return contactCache.value;
  const rows = await createDb(env)
    .select({ email: users.email })
    .from(users)
    .where(eq(users.role, 'admin'))
    .limit(1)
    .all();
  const value = String(rows[0]?.email ?? '').trim();
  contactCache = { at: Date.now(), value };
  return value;
}

export async function getPublicConfig(env: Env): Promise<Record<string, string | boolean | number>> {
  const out: Record<string, string | boolean | number> = {};
  for (const key of PUBLIC_KEYS) {
    const raw = await getConfig(env, key);
    if (raw === undefined) continue;
    if (raw === 'true' || raw === 'false') out[key] = raw === 'true';
    else if (/^-?\d+$/.test(raw)) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

/** CORS 白名单，逗号分隔；未配置则只允许同域 */
export async function getAllowedOrigins(env: Env): Promise<string[]> {
  const v = env.ALLOWED_ORIGINS ?? '';
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 记下后台自己的地址：管理员从哪个来源登录，cmsAdminUrl 就填那个来源。
 *
 * 后台是独立的 Pages 项目，前台「登录后跳后台」必须知道它的域名 —— 主题只能按同域
 * /admin/ 兜底，而那个路径上必然是 404。这里只在还没填过的时候写一次，
 * 之后以「设置 → 站点信息」里人工填的为准（换域名、加了自定义域都能自己改）。
 */
export async function rememberCmsOrigin(env: Env, origin: string | null | undefined): Promise<void> {
  const clean = String(origin ?? '').trim().replace(/\/+$/, '');
  // 只收纯来源；带路径的说明请求是从别的页面发过来的，不是后台本身
  if (!/^https?:\/\/[^/?#]+$/.test(clean)) return;
  if ((await getConfig(env, 'cmsAdminUrl')) !== undefined) return;
  await setConfig(env, 'cmsAdminUrl', `${clean}/`);
}

/**
 * 记下接口自己的域名（worker 或绑定的自定义域）。
 *
 * 为什么需要它：邮件里的「确认订阅」「退订」指向的是**接口自己**的 `/api/...`，
 * 而站点域名是 Pages 上的一份 Hugo 静态站，没有 /api 代理 —— 拿站点地址拼这种链接，
 * 点开就是 404（群发那封底部的退订行就是这么坏的）。定时任务、群发这些没有请求上下文
 * 的场合拿不到 origin，所以要趁有请求的时候记一次。
 *
 * 三条限制：
 *   · 只认自定义域。Cloudflare 白送的 `*.workers.dev` / `*.pages.dev` 在国内基本打不开，
 *     把它们记下来只会把链接带偏，比「没记」更糟；绑域之后的第一个请求会记上。
 *   · 公网域名一律记成 https（本地 127.0.0.1 / localhost 保持 http）。
 *   · 每个 isolate 只办一次（库里已有值、或自己已经写过就不再碰），不会变成每条请求都去 UPDATE 一次 D1。
 */
let apiOriginSettled = false;

export async function recordApiOrigin(env: Env, requestUrl: string | undefined): Promise<void> {
  if (apiOriginSettled) return;
  let origin = '';
  try {
    origin = new URL(String(requestUrl ?? '')).origin;
  } catch {
    return;
  }
  const host = origin.replace(/^https?:\/\//, '');
  // 只收纯来源，且排除 Cloudflare 的临时域名
  if (!/^https?:\/\/[^/?#]+$/.test(origin)) return;
  if (/\.(workers|pages)\.dev$/.test(host)) return;
  /* 有人用 http:// 打到接口时不能照原样记：那样退订链接就是明文地址。
     本地开发（127.0.0.1 / localhost）保持 http，其余一律归一到 https。 */
  if (origin.startsWith('http://') && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) origin = `https://${host}`;
  if ((await getConfig(env, 'apiBaseUrl'))?.trim()) {
    apiOriginSettled = true;
    return;
  }
  await setConfig(env, 'apiBaseUrl', origin);
  apiOriginSettled = true;
}

/**
 * 拼接口自己的绝对地址。没记过就退回站点地址 —— 同域部署（站点和接口共用一个域名）时那是对的，
 * 不同域时后台「设置 → 内容仓库」里手填一次即可。
 */
export async function apiBase(env: Env): Promise<string> {
  const stored = (await getConfig(env, 'apiBaseUrl'))?.trim();
  if (stored) return stored.replace(/\/+$/, '');
  const site = (await getConfig(env, 'siteUrl'))?.trim() || env.SITE_URL || '';
  return site.replace(/\/+$/, '');
}
