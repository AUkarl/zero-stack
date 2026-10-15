/**
 * types.ts — 与 packages/api/src/routes/comments.ts 的 makeShaper() 输出一一对应
 *
 * 以后端源码为准的几处语义：
 *   · isAuthor 表示「作者是注册用户」(authorType === 'user')，不再等于博主；
 *   · 访客维度由 visitorMeta() 写入，本地 dev 拿不到 cf 时是空串；
 *   · 列表接口改成「二级平铺」：顶层的 replies 是整条线程按时间正序的平铺数组，
 *     children 仍是旧的按 ?depth 嵌套的结构（前端已经不再渲染它，留着给老调用方）；
 *   · verified 已从后端删掉，前台身份只看 group。
 */

/** 'admin'（站长）| 'coauthor'（共创）| 'friend'（朋友）| null（游客） */
export type CommentGroup = 'admin' | 'coauthor' | 'friend' | null;

export interface Comment {
  id: string;
  postSlug: string;
  parentId: string | null;
  rootId: string | null;
  /** 服务端记录的嵌套层号，平铺展示后只作为「这条本来是第几层回复」的信息 */
  depth: number;
  content: string;
  authorName: string;
  /** 评论者填的网址（游客 link 字段 / 无则为 null），只有 http(s) 才渲染成链接 */
  authorLink: string | null;
  authorId: string | null;
  avatar: string;
  /** 邮箱 md5 拼的 gravatar，avatar 加载失败时的第二级退化 */
  gravatar?: string;
  emailDomain?: string;
  isAuthor: boolean;
  group?: CommentGroup;
  /** 平铺回复才有：被回复者的昵称，顶层是空串 */
  replyToName?: string;
  status?: string;
  createdAt: number;
  editedAt?: number | null;
  /** 这条线程的回复数（平铺数组长度） */
  replyCount: number;
  /** 同一 root 的全部可见回复，按 createdAt 正序平铺；回复项自己是空数组 */
  replies: Comment[];
  /** 旧字段：按 ?depth 嵌套的子树，前端不再渲染 */
  children?: Comment[];
  /** 旧字段：深度被截断的标记，平铺后不再用它做展开 */
  collapsed?: boolean;
  country?: string | null;
  city?: string | null;
  browser?: string | null;
  os?: string | null;
  device?: string | null;
  pinned?: boolean;
  featured?: boolean;
  likeCount?: number;
  liked?: boolean;
  /** 只有本次请求用 ?owners= 证明过身份的那条才会带回来 */
  ownerKey?: string | null;
}

export interface CommentListData {
  comments: Comment[];
  /** 分页窗口外的「我自己的待审」，前端拼在列表里显示 */
  mine?: Comment[];
  total: number;
  threadTotal: number;
  offset: number;
  limit: number;
  sort: SortKey;
  hasMore: boolean;
  maxDepth: number;
  depth: number;
  commentEnabled: boolean;
  requireReview: boolean;
  allowAnonymous: boolean;
}

export interface CommentPostData {
  id: string;
  depth: number;
  status: string;
  message: string;
  ownerKey: string | null;
  comment: Comment;
}

export type SortKey = 'oldest' | 'latest' | 'hot';

/** CommentSection 下发给每条评论的共享状态与动作（沿用 $state 对象，避免逐条传 props） */
export interface CommentCtx {
  replyingId: string | null;
  draft: string;
  submitting: boolean;
  error: string;
  editingId: string | null;
  editDraft: string;
  editError: string;
  editBusy: boolean;
  replyTo(id: string): void;
  cancelReply(): void;
  submitReply(id: string): void;
  startEdit(node: Comment): void;
  cancelEdit(): void;
  saveEdit(id: string): void;
  remove(id: string): void;
  like(node: Comment): Promise<void>;
}
