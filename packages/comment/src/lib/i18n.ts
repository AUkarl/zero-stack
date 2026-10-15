/**
 * i18n.ts — 评论区文案（默认中文，lang 以 en 开头时走英文）
 *
 * 只做「看得见的字」这一层：主题侧 <zero-comment lang="en"> 传什么就说什么，
 * 传别的值（zh-TW、ja…）暂时回落到中文，不编造没校对过的译文。
 */

export type Dict = Record<string, string>;

const ZH: Dict = {
  commentsTitle: '评论',
  loading: '评论加载中…',
  loadFailed: '评论加载失败',
  unavailable: '评论暂不可用',
  noApiBase: '未配置 api-base，评论组件无法连接后端',
  closed: '本站已关闭评论。',
  empty: '还没有评论，来抢沙发吧。',

  bold: '粗体',
  italic: '斜体',
  code: '代码',
  link: '链接',
  shortlink: '短链',
  quote: '引用',
  preview: '预览',
  previewEmpty: '（还没有内容，写点什么再预览）',
  emoji: '表情',
  closePanel: '关闭',

  placeholder: '支持 Markdown 与 [[文章标识符]] 短链…',
  nickname: '昵称（选填）',
  emailField: '邮箱（必填）',
  websiteField: '网站（选填，如 https://example.com）',
  guestHint: '邮箱必填（用于头像与回复通知，不会公开显示）；昵称与网站选填，昵称留空时按邮箱自动生成',
  emailRequired: '请先填写邮箱（用于头像与回复通知，不会公开显示）',
  submit: '发表评论',
  submitting: '提交中…',
  login: '登录',
  reviewHint: '评论需审核后公开',
  actingAs: '以 {name} 的身份',
  needLogin: '需登录后发言',

  sortOldest: '最早',
  sortLatest: '最新',
  sortHot: '最热',
  loadMore: '加载更多',
  loadingMore: '加载中…',

  posted: '发布成功',
  pendingMsg: '已提交，等待博主审核通过后显示',

  reply: '回复',
  replyPlaceholder: '回复 {name}…',
  replySubmit: '发布回复',
  cancel: '取消',
  save: '保存',
  edit: '编辑',
  del: '删除',
  edited: '已编辑',
  editPlaceholder: '修改评论内容…',

  pending: '审核中',
  myPending: '我的待审核评论',
  anonymous: '匿名',
  /** 身份只用文字标签表达：昵称后面直接跟「站长 / 共创 / 朋友」，不带「用户组：」这种前缀 */
  groupAdmin: '站长',
  groupCoauthor: '共创',
  groupFriend: '朋友',
  replyTo: '回复 @{name}',
  expandMore: '展开这 {n} 条回复中的更多…',

  likeTitle: '点赞',
  unlikeTitle: '取消点赞',
  confirmDelete: '确定删除这条评论及其回复？',
  metaTitle: '位置 / 浏览器 / 系统',

  justNow: '刚刚',
  minutesAgo: '{n} 分钟前',
  hoursAgo: '{n} 小时前',
  daysAgo: '{n} 天前',
};

const EN: Dict = {
  commentsTitle: 'Comments',
  loading: 'Loading comments…',
  loadFailed: 'Failed to load comments',
  unavailable: 'Comments are unavailable',
  noApiBase: 'api-base is not set, the comment component cannot reach the backend',
  closed: 'Comments are closed on this site.',
  empty: 'No comments yet — be the first.',

  bold: 'Bold',
  italic: 'Italic',
  code: 'Code',
  link: 'Link',
  shortlink: 'Short link',
  quote: 'Quote',
  preview: 'Preview',
  previewEmpty: '(nothing to preview yet — start typing)',
  emoji: 'Emoji',
  closePanel: 'Close',

  placeholder: 'Markdown and [[slug]] short links supported…',
  nickname: 'Nickname (optional)',
  emailField: 'Email (required)',
  websiteField: 'Website (optional, e.g. https://example.com)',
  guestHint: 'Email is required (avatar + reply notices, never shown publicly); nickname and website are optional — a blank nickname is derived from the email',
  emailRequired: 'Please fill in your email first (avatar + reply notices, never shown publicly)',
  submit: 'Post comment',
  submitting: 'Submitting…',
  login: 'Sign in',
  reviewHint: 'Comments are published after review',
  actingAs: 'Posting as {name}',
  needLogin: 'Sign in to comment',

  sortOldest: 'Oldest',
  sortLatest: 'Newest',
  sortHot: 'Hottest',
  loadMore: 'Load more',
  loadingMore: 'Loading…',

  posted: 'Posted',
  pendingMsg: 'Submitted — it shows up once the author approves it',

  reply: 'Reply',
  replyPlaceholder: 'Reply to {name}…',
  replySubmit: 'Post reply',
  cancel: 'Cancel',
  save: 'Save',
  edit: 'Edit',
  del: 'Delete',
  edited: 'Edited',
  editPlaceholder: 'Edit your comment…',

  pending: 'Pending',
  myPending: 'My pending comments',
  anonymous: 'Guest',
  groupAdmin: 'Admin',
  groupCoauthor: 'Co-author',
  groupFriend: 'Friend',
  replyTo: 'Reply to @{name}',
  expandMore: 'Show more of these {n} replies…',

  likeTitle: 'Like',
  unlikeTitle: 'Unlike',
  confirmDelete: 'Delete this comment and its replies?',
  metaTitle: 'Location / browser / OS',

  justNow: 'just now',
  minutesAgo: '{n} min ago',
  hoursAgo: '{n} h ago',
  daysAgo: '{n} days ago',
};

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** 归一语言：en* → 英文，其余（含空值、zh-TW/ja）→ 中文兜底 */
export function isEnglish(lang?: string): boolean {
  return /^en\b/i.test(String(lang || '').trim());
}

export function tr(lang?: string): Translate {
  const dict = isEnglish(lang) ? EN : ZH;
  return (key, vars) => {
    let out = dict[key] ?? ZH[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
    return out;
  };
}
