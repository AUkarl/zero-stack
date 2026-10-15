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
  // 注册与邀请码
  | 'accountSystemEnabled'
  | 'allowRegister'
  | 'requireInviteCode'
  | 'requireEmailVerified'
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
  | 'gitWritebackEnabled'
  | 'githubLinksFile'
  | 'cloudflarePagesBuildHook'
  /* 评论提醒与展示 */
  | 'commentNotifyAdmin'
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
  'accountSystemEnabled',
  'allowRegister',
  'requireInviteCode',
  'requireEmailVerified',
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
  'gitWritebackEnabled',
  'githubLinksFile',
  'cloudflarePagesBuildHook',
  'commentNotifyAdmin',
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
  requireEmailVerified: 'false',
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
  avatarTemplate: 'https://cravatar.cn/avatar/{hash}?d=mp&s=64',
  smtpPort: '587',
  smtpSecure: 'true',
  friendsEnabled: 'true',
  friendsAutoCheck: 'true',
  /** true = 每天的可用性检测只检填了 RSS 地址的友链 */
  friendsCheckOnlyRss: 'true',
  friendsCheckIntervalHours: '24',
  friendsLostAfterDays: '30',
  friendsStaleAfterDays: '90',
  momentsEnabled: 'true',
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
  /** false（默认）= 命中垃圾直接标成 spam 进「垃圾评论」队列；true = 先压到「待审核」由人判定 */
  spamHoldPending: 'false',
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
  gitWritebackEnabled: 'false',
  githubLinksFile: 'data/links.yaml',
  cloudflarePagesBuildHook: '',
  githubBranch: 'main',
  commentNotifyAdmin: 'true',
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
  'spamExternalKey',
  'spamProviderKeyId',
  'spamProviderSecret',
  'translateKey',
];

export function isSecretKey(key: string): boolean {
  return (SECRET_KEYS as string[]).includes(key);
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
  'requireEmailVerified',
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
  'draftsEnabled',
  'authorVerifyEnabled',
  'analyticsEnabled',
];

/**
 * 站长联系邮箱：不再有配置键，直接取管理员账号注册时用的邮箱。
 * 「找回密码」提示与「登录已关闭」那句提示共用这一个来源，改密码用的邮箱和
 * 给用户看的邮箱不会各说一套；管理员换邮箱，前台提示跟着变。
 * /api/config 每次都要问一遍，压一层 5 分钟内存缓存，命中就省一次 D1 读。
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
  out.adminContactEmail = await getAdminContactEmail(env);
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
