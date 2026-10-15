import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

import { sql } from 'drizzle-orm';

/** 时间统一存 unix 秒；默认值必须由 DDL 表达，不能塞 JS 闭包 */
const unixNow = sql<number>`(strftime('%s', 'now'))`;

/* ------------------------------------------------------------------
 * 认证：账号、会话、第三方身份、邮箱验证码
 * ----------------------------------------------------------------*/

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    /** 作者标识：文章 front matter 的 author 用它署名，前台按它取作者卡片与认证徽章 */
    handle: text('handle'),
    email: text('email').notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    /** scrypt 派生密钥，格式 salt:hash（hex）；不落明文 */
    passwordHash: text('password_hash'),
    image: text('image'),
    /** 作者资料：一句话简介与个人站点，认证通过后前台在文章署名旁展示 */
    bio: text('bio'),
    website: text('website'),
    role: text('role').notNull().default('reader'),
    /** 以下三项只能由管理员在后台勾选，用户自己申请、管理员批准 */
    /** 允许在新文章里署名并投稿 */
    canPublish: integer('can_publish', { mode: 'boolean' }).notNull().default(false),
    /** 允许提交作者认证申请 */
    canAuthor: integer('can_author', { mode: 'boolean' }).notNull().default(false),
    /** 认证已通过，文章署名旁显示认证徽章 */
    authorVerified: integer('author_verified', { mode: 'boolean' }).notNull().default(false),
    /** 'active' | 'banned'，封禁后既不能登录也不能评论 */
    status: text('status').notNull().default('active'),
    /** 用户中心地址用的账号标识：邮箱前缀，重名时追加三位随机数 */
    accountSlug: text('account_slug'),
    /** 用户组：'friend'（朋友，注册默认）| 'coauthor'（共创，作者认证通过后自动进入），决定前台评论徽章 */
    userGroup: text('user_group').notNull().default('friend'),
    /** 身份验证器：base32 密钥（只存加密后的密文）与是否已启用 */
    totpSecret: text('totp_secret'),
    totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
    /**
     * 绑定验证器后，登录时是否要那枚动态码 —— 普通用户自己的开关，默认开启。
     * 站点那条「管理员登录方式」管不到这里：前台用户永远是邮箱 + 密码，
     * 要不要第二道验证由账号主人说了算。管理员不看这一列（走站点策略）。
     */
    totpAtLogin: integer('totp_at_login', { mode: 'boolean' }).notNull().default(true),
    /** 注册时消费的邀请码 id，未使用邀请码注册则为 null */
    invitedBy: text('invited_by'),
    createdAt: integer('created_at').notNull().default(unixNow),
    updatedAt: integer('updated_at').notNull().default(unixNow),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email), uniqueIndex('users_handle_idx').on(t.handle)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: integer('created_at').notNull().default(unixNow),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'credential' | 'github' …，GitHub OAuth 预留 */
    provider: text('provider').notNull().default('credential'),
    providerAccountId: text('provider_account_id'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    createdAt: integer('created_at').notNull().default(unixNow),
  },
  (t) => [index('accounts_user_idx').on(t.userId)],
);

export const verifications = sqliteTable('verifications', {
  identifier: text('identifier').primaryKey(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull().default(unixNow),
});

/* ------------------------------------------------------------------
 * 评论者：一次性的昵称/头像/邮箱档案，供未登录用户复用
 * ----------------------------------------------------------------*/

export const commenters = sqliteTable(
  'commenters',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email'),
    /** 邮箱 md5，用于前端拼头像服务地址 */
    emailMd5: text('email_md5'),
    link: text('link'),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(unixNow),
  },
  (t) => [index('commenters_user_idx').on(t.userId)],
);

/* ------------------------------------------------------------------
 * 评论：6 层嵌套靠 parent_id 串起，path 物化祖先便于取整棵子树
 * ----------------------------------------------------------------*/

export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    /** 文章标识，取 Hugo 的 page.RelPermalink */
    postSlug: text('post_slug').notNull(),
    parentId: text('parent_id').references((): any => comments.id, { onDelete: 'cascade' }),
    /** 从 1 开始，1 为顶层 */
    depth: integer('depth').notNull().default(1),
    /** 顶层评论 id，便于整棵子树一次取出 */
    rootId: text('root_id'),
    /** 'commenter' | 'user' */
    authorType: text('author_type').notNull().default('commenter'),
    authorId: text('author_id'),
    authorName: text('author_name').notNull(),
    authorEmail: text('author_email'),
    authorLink: text('author_link'),
    content: text('content').notNull(),
    status: text('status').notNull().default('approved'),
    /** 审核引擎打分 0-100，null 表示未参与打分 */
    spamScore: integer('spam_score'),
    /** 命中的规则说明，人工复核时用于判断是否误杀 */
    spamReason: text('spam_reason'),
    /** 加盐哈希后的 IP，明文一律不入库 */
    ipHash: text('ip_hash'),
    /** 属地：Cloudflare 请求携带的国家/城市，前台显示为「国家 · 城市」 */
    country: text('country'),
    city: text('city'),
    /** 由 UA 解析出的浏览器、系统、设备类型 */
    browser: text('browser'),
    os: text('os'),
    device: text('device'),
    /** 管理员置顶（列表最前）与精选标记 */
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
    /** 匿名评论的自删凭证，浏览器本地保存，只有带上它才允许删除这条评论 */
    ownerKey: text('owner_key'),
    userAgent: text('user_agent'),
    /** 从 Waline/Twikoo 迁移来的历史数据标记 */
    isLegacy: integer('is_legacy', { mode: 'boolean' }).notNull().default(false),
    legacyId: text('legacy_id'),
    createdAt: integer('created_at').notNull().default(unixNow),
    updatedAt: integer('updated_at').notNull().default(unixNow),
    /** 作者自己编辑过的时间，空表示未编辑 */
    editedAt: integer('edited_at'),
  },
  (t) => [
    index('comments_post_idx').on(t.postSlug, t.status, t.createdAt),
    index('comments_parent_idx').on(t.parentId),
    index('comments_root_idx').on(t.rootId),
    index('comments_author_idx').on(t.authorType, t.authorId, t.createdAt),
  ],
);

/* ------------------------------------------------------------------
 * 点赞 / 收藏：匿名按 IP+UA 指纹去重，登录用户关联 user_id
 * ----------------------------------------------------------------*/

export const reactions = sqliteTable(
  'reactions',
  {
    id: text('id').primaryKey(),
    targetSlug: text('target_slug').notNull(),
    /** 'like' | 'star' */
    kind: text('kind').notNull().default('like'),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** 匿名去重指纹 */
    fingerprint: text('fingerprint'),
    createdAt: integer('created_at').notNull().default(unixNow),
  },
  (t) => [
    uniqueIndex('reactions_unique_idx').on(t.targetSlug, t.kind, t.userId, t.fingerprint),
    index('reactions_target_idx').on(t.targetSlug, t.kind),
    index('reactions_user_idx').on(t.userId, t.kind, t.createdAt),
  ],
);

/* ------------------------------------------------------------------
 * 评论点赞：按评论 id 计数，登录用户与匿名指纹各自只算一次
 * ----------------------------------------------------------------*/

export const commentLikes = sqliteTable(
  'comment_likes',
  {
    id: text('id').primaryKey(),
    commentId: text('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint'),
    createdAt: integer('created_at').notNull().default(unixNow),
  },
  (t) => [
    uniqueIndex('comment_likes_unique_idx').on(t.commentId, t.userId, t.fingerprint),
    index('comment_likes_comment_idx').on(t.commentId),
  ],
);

/* ------------------------------------------------------------------
 * 账号注销：用户发起 + 双重确认，管理员审核通过后才级联删除全部数据
 * ----------------------------------------------------------------*/

export const accountDeletions = sqliteTable(
  'account_deletions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    /** 'pending' | 'approved' | 'rejected' */
    status: text('status').notNull().default('pending'),
    reviewerId: text('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    reviewNote: text('review_note'),
    createdAt: integer('created_at').notNull().default(unixNow),
    reviewedAt: integer('reviewed_at'),
  },
  (t) => [index('account_deletions_status_idx').on(t.status, t.createdAt)],
);

/* ------------------------------------------------------------------
 * 邮件订阅：双重确认，token 存这里，确认链接带回
 * ----------------------------------------------------------------*/

export const subscribers = sqliteTable(
  'subscribers',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    token: text('token').notNull(),
    status: text('status').notNull().default('pending'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull().default(unixNow),
    confirmedAt: integer('confirmed_at'),
    /** 退订时间，非空即不再群发 */
    unsubscribedAt: integer('unsubscribed_at'),
  },
  (t) => [uniqueIndex('subscribers_email_idx').on(t.email), index('subscribers_status_idx').on(t.status)],
);

/** 已发给订阅者的文章推送记录，避免重复群发 */
export const emailLogs = sqliteTable(
  'email_logs',
  {
    id: text('id').primaryKey(),
    to: text('to').notNull(),
    subject: text('subject').notNull(),
    /** 'queued' | 'sent' | 'failed' */
    status: text('status').notNull().default('queued'),
    error: text('error'),
    postId: text('post_id'),
    createdAt: integer('created_at').notNull().default(unixNow),
    sentAt: integer('sent_at'),
  },
  (t) => [index('email_logs_post_idx').on(t.postId, t.status)],
);

/** 定时与立即群发任务：到点由 cron 取出执行，结果计入 email_logs */
export const broadcastJobs = sqliteTable(
  'broadcast_jobs',
  {
    id: text('id').primaryKey(),
    subject: text('subject').notNull(),
    html: text('html').notNull(),
    postId: text('post_id'),
    /** 关联文章发布路径，用于「文章发布即群发」 */
    postPath: text('post_path'),
    /** 计划发送时间；空表示立即 */
    scheduleAt: integer('scheduled_at'),
    /** 'queued' | 'running' | 'done' | 'failed' | 'canceled' */
    status: text('status').notNull().default('queued'),
    recipientCount: integer('recipient_count').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),
    error: text('error'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull().default(unixNow),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('broadcast_jobs_status_idx').on(t.status, t.scheduleAt)],
);

/* ------------------------------------------------------------------
 * 友链 + RSS 聚合
 * ----------------------------------------------------------------*/

export const friends = sqliteTable(
  'friends',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    url: text('url').notNull(),
    description: text('description'),
    avatar: text('avatar'),
    rssUrl: text('rss_url'),
    /** 'friend'（友链）| 'alliance'（站点联盟），后台可互相移动 */
    kind: text('kind').notNull().default('friend'),
    /** 同组内排序，数字小的在前；相同则按加入时间 */
    sortOrder: integer('sort_order').notNull().default(0),
    /** 'active' | 'cooldown' | 'dead' */
    status: text('status').notNull().default('active'),
    /** 连续失败次数，达 3 次冷却 1 小时 */
    failCount: integer('fail_count').notNull().default(0),
    lastCheckedAt: integer('last_checked_at'),
    /** 最近一次「访问成功」的时间：30 天没成功访问过就进「迷失的小船」（failCount 只用来短期冷却） */
    lastOkAt: integer('last_ok_at'),
    cooldownUntil: integer('cooldown_until'),
    createdAt: integer('created_at').notNull().default(unixNow),
  },
  (t) => [uniqueIndex('friends_url_idx').on(t.url)],
);

export const friendPosts = sqliteTable(
  'friend_posts',
  {
    id: text('id').primaryKey(),
    friendId: text('friend_id')
      .notNull()
      .references(() => friends.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    link: text('link').notNull(),
    summary: text('summary'),
    pubDate: integer('pub_date'),
    fetchedAt: integer('fetched_at').notNull().default(unixNow),
  },
  (t) => [uniqueIndex('friend_posts_link_idx').on(t.friendId, t.link), index('friend_posts_date_idx').on(t.pubDate)],
);

/* ------------------------------------------------------------------
 * 自建访问统计：sendBeacon 进入页 + 每 30s 心跳 + 离开页结算时长
 * ----------------------------------------------------------------*/

export const visits = sqliteTable(
  'visits',
  {
    id: text('id').primaryKey(),
    /** 会话指纹，用于实时在线 */
    sessionId: text('session_id').notNull(),
    /** 加盐哈希后的访客 IP，访客数按它去重才是真实人数 */
    ipHash: text('ip_hash'),
    path: text('path').notNull(),
    /** 末段用于热门页 Top N，全量用于来源 Top N */
    referrer: text('referrer'),
    country: text('country'),
    device: text('device'),
    browser: text('browser'),
    os: text('os'),
    /** 秒 */
    duration: integer('duration').notNull().default(0),
    createdAt: integer('created_at').notNull().default(unixNow),
  },
  (t) => [
    index('visits_created_idx').on(t.createdAt),
    index('visits_session_idx').on(t.sessionId, t.createdAt),
    index('visits_path_idx').on(t.path),
  ],
);

/* ------------------------------------------------------------------
 * 站点配置：后台可改，覆盖 wrangler vars 的默认值
 * ----------------------------------------------------------------*/

export const siteConfig = sqliteTable(
  'site_config',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    valueType: text('value_type').notNull().default('string'),
    updatedAt: integer('updated_at').notNull().default(unixNow),
  },
);

/**
 * 访客注册表：一个加盐 IP 哈希一行，用来判断「这个访客是不是第一次来」。
 * 早先这份名单放在 KV（visitor:<hash>），但 KV 免费额度只有 1000 次写/天，
 * 访问一高就先把它打爆；D1 免费有 10 万行写/天，而且老访客走 insert or ignore
 * 一行都不改，只有真新访客才产生一次行写入。
 */
export const visitorKeys = sqliteTable('visitor_keys', {
  ipHash: text('ip_hash').primaryKey(),
  firstSeen: integer('first_seen').notNull().default(unixNow),
});

/** Cron / 队列任务的执行记录，供后台运行状况卡片读取 */
export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    detail: text('detail'),
    startedAt: integer('started_at').notNull().default(unixNow),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('job_runs_name_idx').on(t.name, t.startedAt)],
);

/* ------------------------------------------------------------------
 * 邀请码：限量次数 + 有效期 + 可作废，注册时消费一次计数
 * ----------------------------------------------------------------*/

export const inviteCodes = sqliteTable(
  'invite_codes',
  {
    id: text('id').primaryKey(),
    /** 大写去易混字符（0/O/1/I）后生成，比对时大小写不敏感 */
    code: text('code').notNull(),
    note: text('note'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** 0 表示不限次数 */
    maxUses: integer('max_uses').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    /** 空表示永久有效 */
    expiresAt: integer('expires_at'),
    /** 'active' | 'revoked' */
    status: text('status').notNull().default('active'),
    createdAt: integer('created_at').notNull().default(unixNow),
  },
  (t) => [uniqueIndex('invite_codes_code_idx').on(t.code), index('invite_codes_status_idx').on(t.status)],
);

/* ------------------------------------------------------------------
 * 友链在线申请：审核通过后自动写入 friends 表对外发布
 * ----------------------------------------------------------------*/

export const friendApplications = sqliteTable(
  'friend_applications',
  {
    id: text('id').primaryKey(),
    /** 登录用户提交时记录，匿名申请为空 */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    description: text('description'),
    avatar: text('avatar'),
    rssUrl: text('rss_url'),
    /** 联系邮箱，审核结果与到期提醒都发这里 */
    email: text('email'),
    /** 申请人自述，后台展示用 */
    reason: text('reason'),
    /** 'pending' | 'approved' | 'rejected' */
    status: text('status').notNull().default('pending'),
    reviewerId: text('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    reviewNote: text('review_note'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull().default(unixNow),
    reviewedAt: integer('reviewed_at'),
    /** 自动发布成功后的 friends.id，失败为空便于重试 */
    publishedFriendId: text('published_friend_id'),
  },
  (t) => [
    index('friend_apps_status_idx').on(t.status, t.createdAt),
    index('friend_apps_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('friend_apps_url_idx').on(t.url),
  ],
);

/* ------------------------------------------------------------------
 * 投稿：被授权的读者先写草稿进 D1，管理员审核通过后才落到 Git 仓库
 * ----------------------------------------------------------------*/

export const postDrafts = sqliteTable(
  'post_drafts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** 文件名（不含扩展名），审核后写入 content/<lang>/posts/<slug>.md */
    slug: text('slug').notNull(),
    /** Markdown 正文原样存，front matter 由发布环节拼装，渲染交给 Hugo */
    content: text('content').notNull(),
    /** 'zh' | 'en'，决定写入的语言目录 */
    lang: text('lang').notNull().default('zh'),
    category: text('category'),
    /** JSON 数组：标签 */
    tags: text('tags').notNull().default('[]'),
    summary: text('summary'),
    cover: text('cover'),
    /** 'draft'（作者还能改）| 'pending'（等审核）| 'approved' | 'rejected' */
    status: text('status').notNull().default('draft'),
    reviewerId: text('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    reviewNote: text('review_note'),
    /** 审核通过后真正写入仓库的路径，空表示还没落地 */
    publishedPath: text('published_path'),
    publishedAt: integer('published_at'),
    createdAt: integer('created_at').notNull().default(unixNow),
    updatedAt: integer('updated_at').notNull().default(unixNow),
  },
  (t) => [
    index('post_drafts_user_idx').on(t.userId, t.status, t.createdAt),
    index('post_drafts_review_idx').on(t.status, t.createdAt),
  ],
);

/* ------------------------------------------------------------------
 * 作者认证：读者提交笔名与社交证明，管理员核验后置 author_verified
 * ----------------------------------------------------------------*/

export const authorRequests = sqliteTable(
  'author_requests',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 期望使用的笔名，通过后即为文章署名 */
    penName: text('pen_name').notNull(),
    /** 个人简介，通过后写入 users.bio */
    bio: text('bio'),
    /** 作者头像 URL；留空则通过后按邮箱生成（QQ 邮箱走 QQ 头像，其余走 Cravatar） */
    avatar: text('avatar'),
    /** 个人站点 */
    website: text('website'),
    /** JSON 数组：赞赏图片 URL，最多三张 */
    donateImages: text('donate_images').notNull().default('[]'),
    /** JSON 数组：[{ platform, handle, proof }] */
    social: text('social').notNull().default('[]'),
    reason: text('reason'),
    /** 'pending' | 'approved' | 'rejected' */
    status: text('status').notNull().default('pending'),
    reviewerId: text('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
    adminNote: text('admin_note'),
    createdAt: integer('created_at').notNull().default(unixNow),
    reviewedAt: integer('reviewed_at'),
  },
  (t) => [
    index('author_requests_user_idx').on(t.userId, t.createdAt),
    index('author_requests_status_idx').on(t.status, t.createdAt),
  ],
);

/* ------------------------------------------------------------------
 * 操作留痕：后台改动与自动发布都可回溯
 * ----------------------------------------------------------------*/

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name'),
    /** 'config' | 'comment' | 'friend' | 'user' | 'invite' | 'content' | 'media' | 'params' */
    action: text('action').notNull(),
    /** 被操作对象的标识，例如 site_config 的 key 或评论 id */
    target: text('target'),
    /** JSON：改前改后值、发布结果等 */
    detail: text('detail'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull().default(unixNow),
  },
  (t) => [index('audit_logs_time_idx').on(t.createdAt), index('audit_logs_action_idx').on(t.action, t.createdAt)],
);
