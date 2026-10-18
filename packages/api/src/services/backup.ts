/**
 * 全站备份：一份文件装下一个站点的全部内容、样式与配置，可以再灌回一个空站点。
 *
 * 为什么不再只有 D1：文章、时刻、主题覆盖文件（data/*.json、params.toml）都在 Git 仓库里，
 * 评论与设置才是 D1 的。只导 D1 的备份搬到新站，结果是「配置导了、站还是空的」，
 * 所以这一版把两类来源合到一份文件里，并按分区组织。
 *
 * 分区（导入时逐个勾选、逐个演习）：
 *   站点设置   site_config 里非密钥、不绑定本站的项
 *   主题样式   仓库 data/*.json + params.toml
 *   文章       仓库文章目录里的 .md
 *   时刻       仓库时刻目录里的 .md
 *   友链       D1 的 friends / friend_posts + 仓库 links.yaml
 *   订阅名单   D1 subscribers（邮箱名单本身；发信日志与群发任务不备份）
 *   评论       comments + commenters
 *   点赞收藏   reactions(kind=like|star) + comment_likes
 *   账号       users（管理员除外，含密码哈希）+ 仓库 authors.yaml
 *   媒体清单   R2 里图片的 key 与体积、被哪篇文章引用（二进制不进文件）
 *
 * 明确不备份：邮件发送日志、群发任务、邀请码使用记录、访问统计、审计流水、
 * sessions / accounts / verifications（导出来就是一把能登录别人后台的钥匙）。
 * 密钥类配置项（SMTP 密码、各家 API Key）永远不进文件，界面上也不再给「包含密钥」这个开关。
 */

import { desc, getTableColumns, inArray, ne } from 'drizzle-orm';
import { createDb } from '../db/client';
import {
  commentLikes,
  commenters,
  comments,
  friendPosts,
  friends,
  reactions,
  siteConfig,
  subscribers,
  users,
} from '../db/schema';
import { SECRET_KEYS, getConfig, invalidateConfigCache } from './config';
import { readFileFrom, resolveRepoTarget, walkFiles, writeViaTarget, type RepoTarget } from './repo';
import { triggerPagesBuild } from './git';
import { listBuckets, listMediaObjects } from './media';

export const BACKUP_VERSION = 2;

/* ------------------------------------------------------------------ 分区定义 */

export type SectionId =
  | 'settings'
  | 'theme'
  | 'posts'
  | 'moments'
  | 'friends'
  | 'subscribers'
  | 'comments'
  | 'likes'
  | 'users'
  | 'media';

export const SECTION_CATALOG: { id: SectionId; label: string; what: string }[] = [
  { id: 'settings', label: '站点设置', what: '后台各处开关与文案（评论、点赞、友链、时刻、统计、审核、邮件模板…）' },
  { id: 'theme', label: '主题样式', what: '仓库 data/*.json 八份覆盖文件与 config 下的 params.toml' },
  { id: 'posts', label: '文章', what: '文章目录里的全部 .md（含子目录）' },
  { id: 'moments', label: '时刻', what: '时刻目录里的全部 .md' },
  { id: 'friends', label: '友链', what: 'D1 的友链与已抓到的博客动态 + 仓库 links.yaml' },
  { id: 'subscribers', label: '订阅名单', what: '已订阅的邮箱与确认状态；发信日志与群发记录不备份' },
  { id: 'comments', label: '评论', what: '评论正文、层级关系与评论者身份' },
  { id: 'likes', label: '点赞与收藏', what: '文章/时刻的 like、star 记录与评论点赞' },
  { id: 'users', label: '用户账号', what: '普通用户（含密码哈希）与仓库 authors.yaml；管理员账号不导出' },
  { id: 'media', label: '媒体清单', what: 'R2 图片的 key、体积与被引用位置；图片本体在这一节核对，导与搬用后台「图片（媒体本体）」那个图片包' },
];

export const SECTION_IDS = SECTION_CATALOG.map((s) => s.id);
const SECTION_LABEL = new Map(SECTION_CATALOG.map((s) => [s.id, s.label]));

/**
 * 绑定「这一个账号 / 这一个域名」的配置项：导出时列出来给人工对照，恢复时一律不写。
 * 写回的后果是把新站的仓库坐标与域名盖成旧站的，表现为「后台一发文就 404、所有链接指向别人的域名」。
 */
const SITE_BOUND_KEYS = [
  'siteUrl',
  'githubOwner',
  'githubRepo',
  'githubBranch',
  'cloudflareAccountId',
  'mediaBaseUrl',
  'mediaPublicUrl',
  // 这份 JSON 里可能带明文 S3 accessKeyId / secretAccessKey，绝不能进备份文件
  'mediaBuckets',
];

/* -------------------------------------------------------------------- 上限 */

/**
 * Worker 单次请求的软限制：128MB 内存、1000 个子请求、响应体也不能无限大。
 * 超限时不静默丢弃，而是在分区里写一条 note，让人知道这份备份不完整。
 */
const FILE_CAP = 600;
const TABLE_CAP = 20000;
const MEDIA_CAP = 3000;
const DIR_DEPTH = 4;

/* -------------------------------------------------------------------- 形状 */

export interface BackupFile {
  path: string;
  content: string;
}

export interface MediaObject {
  key: string;
  /** 在哪个桶里；老备份没这个字段，核对时按「任一桶里有同名」算 */
  bucket?: string;
  size: number;
  uploaded: string | null;
  /** 哪些文章/时刻正文里提到了这个 key */
  usedBy: string[];
}

export interface BackupSection {
  id: SectionId;
  counts: Record<string, number>;
  tables?: Record<string, Record<string, unknown>[]>;
  files?: BackupFile[];
  objects?: MediaObject[];
  notes?: string[];
}

export interface BackupPayload {
  version: number;
  createdAt: number;
  siteName: string;
  note: string;
  /** 备份来自哪个仓库、哪套目录：恢复时用来对照本站配置，不参与写入 */
  origin: {
    owner: string;
    repo: string;
    branch: string;
    siteUrl: string;
    dataDir: string;
    postsDir: string;
    momentsDir: string;
    linksFile: string;
    authorsFile: string;
  };
  /** 没写进文件、也没配到本站的项：分区之外单独列一份，界面上给出旧值供人工搬 */
  omitted: { key: string; reason: string; value: string }[];
  sections: BackupSection[];
}

/* -------------------------------------------------------------------- 导出 */

export async function exportBackup(
  env: Env,
  opts: { note?: string } = {},
): Promise<{ payload: BackupPayload; warnings: string[] }> {
  const db = createDb(env);
  const warnings: string[] = [];
  const sections: BackupSection[] = [];

  const dataDir = (await getConfig(env, 'githubDataDir'))?.trim() || 'data';
  const postsDir = (await getConfig(env, 'githubPostsDir'))?.trim() || 'content/zh/posts';
  const momentsDir = (await getConfig(env, 'githubMomentsDir'))?.trim() || 'content/zh/moments';
  const linksFile = (await getConfig(env, 'githubLinksFile'))?.trim() || `${dataDir}/links.yaml`;
  const authorsFile = (await getConfig(env, 'githubAuthorsFile'))?.trim() || `${dataDir}/authors.yaml`;
  const origin: BackupPayload['origin'] = {
    owner: (await getConfig(env, 'githubOwner')) ?? '',
    repo: (await getConfig(env, 'githubRepo')) ?? '',
    branch: (await getConfig(env, 'githubBranch')) || 'main',
    siteUrl: (await getConfig(env, 'siteUrl')) ?? '',
    dataDir,
    postsDir,
    momentsDir,
    linksFile,
    authorsFile,
  };

  /* --- 站点设置：site_config 去掉密钥与本站绑定项 --- */
  const configRows = await db.select().from(siteConfig);
  const secretSet = new Set<string>(SECRET_KEYS);
  const boundSet = new Set<string>(SITE_BOUND_KEYS);
  const keepConfig: Record<string, unknown>[] = [];
  const omitted: BackupPayload['omitted'] = [];
  for (const r of configRows) {
    if (secretSet.has(r.key)) {
      // 值一律不带出去：这一列本身就是「密码 / API Key」
      omitted.push({ key: r.key, reason: '密钥类配置，不进备份文件（到新站后台重新填）', value: '' });
      continue;
    }
    if (boundSet.has(r.key)) {
      omitted.push({ key: r.key, reason: '绑定本站账号或域名，恢复时不写', value: r.value });
      continue;
    }
    keepConfig.push({ key: r.key, value: r.value, valueType: r.valueType, updatedAt: r.updatedAt });
  }
  sections.push({
    id: 'settings',
    counts: { 配置项: keepConfig.length },
    tables: { siteConfig: keepConfig },
    notes: omitted.length ? [`另有 ${omitted.length} 项不写入，见「未包含」列表`] : [],
  });

  /* --- 仓库里的那些分区 --- */
  let target: RepoTarget | null = null;
  try {
    target = await resolveRepoTarget(env);
  } catch (e) {
    warnings.push(`读不到内容仓库，文章/时刻/主题样式/友链文件这次是空的：${briefError(e)}`);
  }

  /** 仓库文件读不到不算失败，只记一条 note：新装的站本来就没几篇 */
  const readRepo = async (paths: string[], noteSink: string[]): Promise<BackupFile[]> => {
    if (!target) {
      if (paths.length) noteSink.push(`${paths[0]}：内容仓库没配好（仓库坐标 / 令牌 / 本地目录），这份备份里没有仓库文件`);
      return [];
    }
    const out: BackupFile[] = [];
    for (const p of paths) {
      try {
        const f = await readFileFrom(target, p);
        if (f?.content !== undefined && f.content !== '') out.push({ path: p, content: f.content });
        else noteSink.push(`${p}：仓库里没有或内容为空`);
      } catch (e) {
        noteSink.push(`${p}：读取失败（${briefError(e)}）`);
      }
      if (out.length >= FILE_CAP) {
        noteSink.push(`文件数达到上限 ${FILE_CAP}，多余的没导出来`);
        break;
      }
    }
    return out;
  };

  /* 主题样式：data/*.json 的覆盖文件 + config 下的 params.toml。
     links.yaml / authors.yaml 归友链与账号分区；poststats / linksstatus / friendfeed 是定时任务
     重算出来的派生数据，导过去只会在下一次构建前显示旧数字，所以不导。 */
  const DERIVED_DATA = /\/(poststats|linksstatus|friendfeed)\.json$/;
  const themeNotes: string[] = [];
  const dataFiles: string[] = [];
  if (target) {
    try {
      const listed = await walkFiles(target, dataDir, { exts: ['.json'], cap: FILE_CAP, maxDepth: DIR_DEPTH });
      dataFiles.push(...listed.filter((p) => !DERIVED_DATA.test(p)));
      const skippedDerived = listed.length - dataFiles.length;
      if (skippedDerived) themeNotes.push(`${skippedDerived} 份派生统计文件（精选/友链状态/朋友动态）由定时任务重算，不导`);
    } catch (e) {
      themeNotes.push(`列 ${dataDir} 失败：${briefError(e)}`);
    }
  }
  const themePaths = [...dataFiles, ...(await paramFiles(target))];
  const themeFiles = await readRepo(themePaths, themeNotes);
  themeNotes.push('hugo.toml 不在备份里：它带本站域名与 API 地址，新站用 pnpm create:site 生成的那一份');
  sections.push({
    id: 'theme',
    counts: { 文件: themeFiles.length },
    files: themeFiles,
    notes: themeNotes,
  });

  const postsNotes: string[] = [];
  const postPaths = target ? await safeList(target, postsDir, ['.md'], postsNotes) : [];
  const postFiles = await readRepo(postPaths, postsNotes);
  sections.push({ id: 'posts', counts: { 文章: postFiles.length }, files: postFiles, notes: postsNotes });

  const momentNotes: string[] = [];
  const momentPaths = target ? await safeList(target, momentsDir, ['.md'], momentNotes) : [];
  const momentFiles = await readRepo(momentPaths, momentNotes);
  sections.push({ id: 'moments', counts: { 时刻: momentFiles.length }, files: momentFiles, notes: momentNotes });

  const friendNotes: string[] = [];
  const linksFileRows = await readRepo([linksFile], friendNotes);
  const friendRows = await readTable(db, friends);
  const friendPostRows = await readTable(db, friendPosts, 'fetchedAt');
  sections.push({
    id: 'friends',
    counts: { 友链: friendRows.rows.length, 动态: friendPostRows.rows.length, 文件: linksFileRows.length },
    tables: { friends: friendRows.rows, friendPosts: friendPostRows.rows },
    files: linksFileRows,
    notes: [...(friendRows.truncated || friendPostRows.truncated ? [`超过 ${TABLE_CAP} 行的部分没导出来`] : []), ...friendNotes],
  });

  const subscriberRows = await readTable(db, subscribers);
  sections.push({
    id: 'subscribers',
    counts: { 订阅者: subscriberRows.rows.length },
    tables: { subscribers: subscriberRows.rows },
    notes: subscriberRows.truncated ? [`超过 ${TABLE_CAP} 行的部分没导出来`] : [],
  });

  const commentRows = await readTable(db, comments);
  const commenterRows = await readTable(db, commenters);
  sections.push({
    id: 'comments',
    counts: { 评论: commentRows.rows.length, 评论者: commenterRows.rows.length },
    tables: { comments: commentRows.rows, commenters: commenterRows.rows },
    notes: commentRows.truncated || commenterRows.truncated ? [`超过 ${TABLE_CAP} 行的部分没导出来`] : [],
  });

  const reactionRows = await readTable(db, reactions);
  const clikeRows = await readTable(db, commentLikes);
  sections.push({
    id: 'likes',
    counts: { 点赞收藏: reactionRows.rows.length, 评论点赞: clikeRows.rows.length },
    tables: { reactions: reactionRows.rows, commentLikes: clikeRows.rows },
    notes: reactionRows.truncated || clikeRows.truncated ? [`超过 ${TABLE_CAP} 行的部分没导出来`] : [],
  });

  const userNotes: string[] = [];
  const authorFileRows = await readRepo([authorsFile], userNotes);
  let userRows: Record<string, unknown>[] = [];
  try {
    userRows = (await db.select().from(users).where(ne(users.role, 'admin'))).map((r) => ({ ...r }));
  } catch (e) {
    userNotes.push(`读用户表失败：${briefError(e)}`);
  }
  sections.push({
    id: 'users',
    counts: { 用户: userRows.length, 文件: authorFileRows.length },
    tables: { users: userRows },
    files: authorFileRows,
    notes: ['管理员账号不导出：到新站后台自己注册第一个账号', ...userNotes],
  });

  /* --- 媒体清单：列每个桶的 uploads/，图片本体走后台那个图片包 --- */
  const media: MediaObject[] = [];
  const mediaNotes: string[] = [];
  for (const b of await listBuckets(env)) {
    try {
      let cursor: string | undefined;
      do {
        const listed = await listMediaObjects(env, b, { prefix: 'uploads/', limit: 1000, cursor });
        for (const o of listed.objects) {
          media.push({ key: o.key, bucket: b.id, size: o.size, uploaded: o.lastModified, usedBy: [] });
          if (media.length >= MEDIA_CAP) break;
        }
        cursor = listed.truncated && media.length < MEDIA_CAP ? (listed.cursor ?? undefined) : undefined;
      } while (cursor);
      if (media.length >= MEDIA_CAP) mediaNotes.push(`对象数达到上限 ${MEDIA_CAP}，清单不完整`);
    } catch (e) {
      mediaNotes.push(`列 ${b.id} 失败：${briefError(e)}`);
    }
  }
  // 反查引用：把文章/时刻正文里出现的 key 找出来，新站复制图片时知道哪些真的在用
  const textBlob = [...postFiles, ...momentFiles, ...themeFiles].map((f) => ({ path: f.path, hay: f.content }));
  for (const m of media) {
    const tail = m.key.split('/').pop() ?? m.key;
    for (const f of textBlob) if (f.hay.includes(m.key) || (tail.length > 8 && f.hay.includes(tail))) m.usedBy.push(f.path);
  }
  sections.push({
    id: 'media',
    counts: { 对象: media.length, 被引用: media.filter((m) => m.usedBy.length).length },
    objects: media,
    notes: [
      '图片本体不在备份文件里：在后台「图片（媒体本体）」那节点「导出图片包」另存一份，到新站同一节逐张写入（按原键，本站已有同名的会跳过）',
      ...mediaNotes,
    ],
  });

  /* 仓库一个文件也没读到 = 桥接进程没起 / GitHub 连不上 / 仓库没配。
     这种备份导到新站什么也写不进去，只记在分区 notes 里太隐蔽（界面仍然显示「导出成功」），顶到 warnings。 */
  const repoFileCount =
    themeFiles.length + postFiles.length + momentFiles.length + linksFileRows.length + authorFileRows.length;
  if (repoFileCount === 0) {
    const failure = [...themeNotes, ...postsNotes, ...momentNotes, ...friendNotes, ...userNotes].find((n) =>
      /读取失败|失败：|没有读到文件|没配好/.test(n),
    );
    if (failure) warnings.push(`内容仓库一个文件都没读到，这份备份里没有文章/时刻/主题样式/友链文件。原因：${failure}`);
  }

  const siteNameRow = configRows.find((r) => r.key === 'siteName');
  return {
    payload: {
      version: BACKUP_VERSION,
      createdAt: Math.floor(Date.now() / 1000),
      siteName: siteNameRow?.value ?? '',
      note: (opts.note ?? '').slice(0, 200),
      origin,
      omitted,
      sections,
    },
    warnings,
  };
}

/* ---------------------------------------------------------------- 仓库列举 */

/** walkFiles 读不到目录时回空数组；这里补一条说明，免得界面看起来像「备份成功但什么都没有」 */
async function safeList(target: RepoTarget, dir: string, exts: string[], notes: string[]): Promise<string[]> {
  const found = await walkFiles(target, dir, { exts, cap: FILE_CAP, maxDepth: DIR_DEPTH });
  if (!found.length) notes.push(`${dir}：没有读到文件（目录不存在、为空，或仓库坐标没配）`);
  return found;
}

/** params.toml 在两种布局下的位置都要试：config/_default/ 与根 config.toml */
async function paramFiles(target: RepoTarget | null): Promise<string[]> {
  if (!target) return [];
  const candidates = ['config/_default/params.toml', 'config/params.toml', 'params.toml'];
  const found: string[] = [];
  for (const p of candidates) {
    try {
      const f = await readFileFrom(target, p);
      if (f?.content) {
        found.push(p);
        break;
      }
    } catch {
      /* 换下一个候选路径 */
    }
  }
  return found;
}

/* ---------------------------------------------------------------- 读表 */

async function readTable(
  db: ReturnType<typeof createDb>,
  table: any,
  orderColumn = 'createdAt',
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  try {
    const sortColumn = (table as Record<string, any>)[orderColumn];
    const query = db.select().from(table);
    const rows = (sortColumn
      ? await query.orderBy(desc(sortColumn)).limit(TABLE_CAP + 1)
      : await query.limit(TABLE_CAP + 1)) as Record<string, unknown>[];
    const truncated = rows.length > TABLE_CAP;
    return { rows: truncated ? rows.slice(0, TABLE_CAP) : rows, truncated };
  } catch {
    return { rows: [], truncated: false };
  }
}

/* -------------------------------------------------------------------- 导入 */

export interface SectionFileResult {
  total: number;
  write: number;
  skip: number;
  unchanged: number;
  /** 本站已存在同名文件的这些路径：没勾覆盖就不动它们 */
  conflicts: string[];
}

export interface SectionTableResult {
  name: string;
  rows: number;
  inserted: number;
  skipped: number;
  note: string | null;
}

export interface SectionOutcome {
  id: SectionId;
  label: string;
  files?: SectionFileResult;
  tables?: SectionTableResult[];
  /** 站点设置单独说：改了几项、哪几项与本站现值不同 */
  settings?: { write: number; changed: { key: string; from: string; to: string }[] };
  media?: { total: number; present: number; absent: number };
  notes: string[];
  errors: string[];
}

export interface ImportOutcome {
  dryRun: boolean;
  overwrite: boolean;
  source: { version: number; createdAt: number; siteName: string; origin: BackupPayload['origin'] };
  /** 本站与备份来源的差异提示，比如文章目录不一样 */
  layout: { postsDir: { from: string; to: string }; momentsDir: { from: string; to: string }; dataDir: { from: string; to: string } };
  sections: SectionOutcome[];
  build: { triggered: boolean; error?: string } | null;
  /** 分批写入时回给后台的续跑坐标：这一区还有 from 之后的文件没写 */
  resume: { section: SectionId; from: number; total: number } | null;
}

const TABLES_BY_SECTION: Record<string, Record<string, any>> = {
  friends: { friends, friendPosts },
  subscribers: { subscribers },
  comments: { comments, commenters },
  likes: { reactions, commentLikes },
  users: { users },
};

export interface ImportBackupOptions {
  sections?: SectionId[];
  dryRun?: boolean;
  /** 本站已有同名文件时是否覆盖（只对文件类分区有意义） */
  overwrite?: boolean;
  /**
   * 分批写入：一个 Worker 请求里逐文件调 GitHub Contents API，二十几篇就会中途断掉
   * （请求超限但没有任何错误冒出来，界面还报成功）。所以后台改成一次只推一批，
   * fileStart 是本区文件数组的起点，fileCount 是这批最多写几个。
   */
  fileStart?: number;
  fileCount?: number;
  actor?: { id?: string | null; name?: string | null } | null;
  ip?: string;
}

/** params.toml 里后端地址那一行，取值与替换都用它 */
const API_LINE_RE = /^apiBaseURL\s*=\s*"([^"]*)"/m;

/** 只有像样的 http 地址才值得保留（空值说明本站本来就当纯静态跑） */
function siteApiBase(content: string): string {
  const value = (API_LINE_RE.exec(content)?.[1] ?? '').trim();
  return /^https?:\/\//i.test(value) ? value : '';
}

/** 正文里残留的源站本机地址（导入到线上就是访客打不开的链接） */
const LOCAL_ADDR_RE = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/;

export async function importBackup(env: Env, raw: unknown, opts: ImportBackupOptions = {}): Promise<ImportOutcome> {
  const payload = normalizePayload(raw);
  const db = createDb(env);
  const dryRun = opts.dryRun !== false;
  const overwrite = opts.overwrite === true;
  const wanted = new Set<SectionId>((opts.sections?.length ? opts.sections : SECTION_IDS).filter((s) => SECTION_IDS.includes(s)));

  const postsDir = (await getConfig(env, 'githubPostsDir'))?.trim() || 'content/zh/posts';
  const momentsDir = (await getConfig(env, 'githubMomentsDir'))?.trim() || 'content/zh/moments';
  const dataDir = (await getConfig(env, 'githubDataDir'))?.trim() || 'data';

  const outcome: ImportOutcome = {
    dryRun,
    overwrite,
    source: { version: payload.version, createdAt: payload.createdAt, siteName: payload.siteName, origin: payload.origin },
    layout: {
      postsDir: { from: payload.origin.postsDir, to: postsDir },
      momentsDir: { from: payload.origin.momentsDir, to: momentsDir },
      dataDir: { from: payload.origin.dataDir, to: dataDir },
    },
    sections: [],
    build: null,
    resume: null,
  };

  // 恢复仓库文件的分区才需要仓库坐标
  const needRepo = payload.sections.some((s) => wanted.has(s.id) && (s.files?.length ?? 0) > 0);
  let target: RepoTarget | null = null;
  if (needRepo) {
    try {
      target = await resolveRepoTarget(env);
    } catch (e) {
      outcome.sections.push({
        id: 'theme',
        label: '仓库文件',
        notes: [],
        errors: [`读不到本站的内容仓库，文件类分区这次都跳过：${briefError(e)}`],
      });
      for (const s of payload.sections) if (wanted.has(s.id) && s.files?.length) outcome.sections.push({ id: s.id, label: labelOf(s.id), notes: [], errors: ['内容仓库不可用'] });
      return outcome;
    }
  }

  let wroteFiles = false;

  for (const section of payload.sections) {
    if (!wanted.has(section.id)) continue;
    const result: SectionOutcome = { id: section.id, label: labelOf(section.id), notes: [], errors: [] };

    /* 站点设置：覆盖式写回 site_config */
    if (section.id === 'settings') {
      const rows = (section.tables?.siteConfig ?? []) as { key: string; value: string; valueType?: string }[];
      const changed: { key: string; from: string; to: string }[] = [];
      let write = 0;
      const existing = new Map<string, string>();
      try {
        const keys = rows.map((r) => r.key);
        for (let i = 0; i < keys.length; i += 90) {
          const found = await db.select().from(siteConfig).where(inArray(siteConfig.key, keys.slice(i, i + 90)));
          for (const f of found) existing.set(f.key, f.value);
        }
      } catch (e) {
        result.errors.push(briefError(e));
      }
      for (const r of rows) {
        if (SECRET_KEYS.includes(r.key as never) || SITE_BOUND_KEYS.includes(r.key)) continue;
        const before = existing.get(r.key);
        if (before === r.value) continue;
        changed.push({ key: r.key, from: before ?? '', to: r.value });
        write++;
        if (!dryRun) {
          try {
            await db
              .insert(siteConfig)
              .values({ key: r.key, value: r.value, valueType: r.valueType ?? 'string', updatedAt: Math.floor(Date.now() / 1000) })
              .onConflictDoUpdate({ target: siteConfig.key, set: { value: r.value, valueType: r.valueType ?? 'string', updatedAt: Math.floor(Date.now() / 1000) } });
          } catch (e) {
            result.errors.push(`${r.key}: ${briefError(e)}`);
          }
        }
      }
      if (!dryRun && write) invalidateConfigCache();
      result.settings = { write, changed };
      if (changed.length > 40) result.notes.push(`改动项很多，只列出前 40 项：${changed.slice(0, 40).map((c) => c.key).join('、')}`);
      else if (changed.length) result.notes.push(`将改这些项：${changed.map((c) => c.key).join('、')}`);
      outcome.sections.push(result);
      continue;
    }

    /* 媒体清单：不写任何东西，只对比本站各个桶里有没有同名对象 */
    if (section.id === 'media') {
      const objects = section.objects ?? [];
      let present = 0;
      try {
        const keyed = new Set<string>();
        const bare = new Set<string>();
        for (const b of await listBuckets(env)) {
          let cursor: string | undefined;
          let n = 0;
          do {
            const listed = await listMediaObjects(env, b, { prefix: 'uploads/', limit: 1000, cursor });
            for (const o of listed.objects) {
              keyed.add(`${b.id}/${o.key}`);
              bare.add(o.key);
            }
            n += listed.objects.length;
            cursor = listed.truncated && n < MEDIA_CAP ? (listed.cursor ?? undefined) : undefined;
          } while (cursor);
        }
        /* 老备份没有桶信息（bucket 字段是后加的），退化成「任一桶里有同名就算有」 */
        present = objects.filter((o) => (o.bucket ? keyed.has(`${o.bucket}/${o.key}`) : bare.has(o.key))).length;
      } catch (e) {
        result.errors.push(briefError(e));
      }
      const absent = objects.length - present;
      result.media = { total: objects.length, present, absent };
      result.notes.push(
        dryRun
          ? `演习：这一区永远不写数据，只告诉你缺多少张图（缺的在后台「图片（媒体本体）」导入图片包补齐）`
          : absent
            ? `还缺 ${absent} 张：本站桶里没有同名对象。到「图片（媒体本体）」那一节导入原站的图片包`
            : '图片清单与本站桶里的对象对得上，一张不缺',
      );
      outcome.sections.push(result);
      continue;
    }

    /* 数据表类分区 */
    const tableMap = TABLES_BY_SECTION[section.id];
    if (tableMap && section.tables) {
      for (const [name, rows] of Object.entries(section.tables)) {
        const table = tableMap[name];
        if (!table) {
          result.tables ??= [];
          result.tables.push({ name, rows: rows.length, inserted: 0, skipped: rows.length, note: '当前版本不认识这张表' });
          continue;
        }
        result.tables ??= [];
        result.tables.push(await mergeTable(db, table, name, rows, dryRun));
      }
    }

    /* 仓库文件类分区 */
    const files = section.files ?? [];
    if (files.length && target) {
      const start = Math.max(0, Math.min(opts.fileStart ?? 0, files.length));
      const batch = opts.fileCount && opts.fileCount > 0 ? files.slice(start, start + opts.fileCount) : files.slice(start);
      const fr: SectionFileResult = { total: files.length, write: 0, skip: 0, unchanged: 0, conflicts: [] };
      /** 备份来自别的站点时 params.toml 里的后端地址是源站的，写过去等于把新站打死 */
      const keptApi: string[] = [];
      /** 正文/数据里残留的 127.0.0.1 这类地址，改写不了正文，只能逐条点名 */
      const localAddr: string[] = [];
      for (const f of batch) {
        let content = f.content;
        let current: { content: string } | null = null;
        try {
          current = await readFileFrom(target, f.path);
        } catch (e) {
          fr.conflicts.push(`${f.path}（读取失败：${briefError(e)}）`);
          continue;
        }
        if (/(^|\/)params\.toml$/.test(f.path) && current) {
          const mine = siteApiBase(current.content);
          const theirs = siteApiBase(content);
          if (mine && theirs && mine !== theirs) {
            content = content.replace(API_LINE_RE, `apiBaseURL = "${mine}"`);
            keptApi.push(`${f.path}：保留本站的 ${mine}（备份里那份是 ${theirs}）`);
          }
        }
        const local = LOCAL_ADDR_RE.exec(content)?.[0];
        if (local) localAddr.push(`${f.path} → ${local}`);
        if (current) {
          if (current.content === content) {
            fr.unchanged++;
            continue;
          }
          fr.conflicts.push(f.path);
          if (!overwrite) {
            fr.skip++;
            continue;
          }
        }
        fr.write++;
        if (!dryRun) {
          try {
            const res = await writeViaTarget(target, f.path, content, `zero-backup: 恢复${labelOf(section.id)}`, {
              actor: opts.actor,
              ip: opts.ip,
              action: 'backup',
            });
            if (!res.success) fr.conflicts.push(`${f.path}：${res.error ?? '提交失败'}`);
            else wroteFiles = true;
          } catch (e) {
            fr.conflicts.push(`${f.path}：${briefError(e)}`);
          }
        }
      }
      if (!dryRun) {
        fr.conflicts = fr.conflicts.filter((c) => c.includes('：'));
      } else if (!overwrite && fr.skip) {
        result.notes.push(`${fr.skip} 个文件本站已有同名且内容不同，没勾「覆盖同名」时保持不动`);
      }
      for (const k of keptApi.slice(0, 3)) result.notes.push(k);
      if (localAddr.length) {
        result.notes.push(
          `${localAddr.length} 个文件里还有源站的本机地址，访客打不开这类链接，请到后台逐个改：${localAddr.slice(0, 3).join('、')}${localAddr.length > 3 ? ' …' : ''}`,
        );
      }
      /** 这一区还剩文件没写：把续跑坐标交回后台，由它接着发下一批（一次请求写二十几个文件会中途断） */
      if (start + batch.length < files.length) outcome.resume = { section: section.id, from: start + batch.length, total: files.length };
      result.files = fr;
    }

    outcome.sections.push(result);
  }

  /* 分批时只在某个区真正写完的那一次触发重建，别每批都点一次构建 */
  if (!dryRun && wroteFiles && !outcome.resume) {
    const build = await triggerPagesBuild(env);
    outcome.build = build;
  }
  return outcome;
}

/** 表类分区：主键已存在就跳过，绝不覆盖本站已有记录 */
async function mergeTable(db: ReturnType<typeof createDb>, table: any, name: string, rows: Record<string, unknown>[], dryRun: boolean): Promise<SectionTableResult> {
  const columns = new Set(Object.keys(getTableColumns(table)));
  const prepared = rows.map((r) => pickKnown(r, columns)).filter((r) => Object.keys(r).length);
  if (!prepared.length) {
    return { name, rows: rows.length, inserted: 0, skipped: rows.length, note: rows.length ? '字段与当前表结构不匹配' : null };
  }
  if (dryRun) {
    const pk = singlePk(table);
    if (!pk) return { name, rows: prepared.length, inserted: prepared.length, skipped: 0, note: '演习无法核对主键，实际以确认导入为准' };
    const values = [...new Set(prepared.map((r) => r[pk.prop]).filter((v) => v !== undefined && v !== null))] as unknown[];
    let existing = 0;
    for (let i = 0; i < values.length; i += 100) {
      try {
        const res = await db.select({ id: pk.column }).from(table).where(inArray(pk.column, values.slice(i, i + 100) as never[]));
        existing += res.length;
      } catch {
        existing = 0;
        break;
      }
    }
    const skip = Math.min(existing, prepared.length);
    return { name, rows: prepared.length, inserted: prepared.length - skip, skipped: skip, note: skip ? `${skip} 行主键已存在，会被跳过` : null };
  }

  let inserted = 0;
  let skipped = 0;
  const errors: string[] = [];
  /* D1 的限制在「一条语句绑定多少个参数」（上限 100），不是行数：
     comments 十几个字段时按 100 行一批发，第一批就撞上限。 */
  const perBatch = Math.max(1, Math.floor(90 / Math.max(1, columns.size)));
  for (let i = 0; i < prepared.length; i += perBatch) {
    const batch = prepared.slice(i, i + perBatch);
    try {
      const res = await db.insert(table).values(batch).onConflictDoNothing();
      const changes = Number((res as unknown as { meta?: { changes?: number } }).meta?.changes ?? batch.length);
      inserted += changes;
      skipped += batch.length - changes;
    } catch (e) {
      errors.push(briefError(e));
    }
  }
  return { name, rows: prepared.length, inserted, skipped, note: errors.length ? `写入出错：${errors[0]}` : null };
}

function labelOf(id: SectionId): string {
  return SECTION_LABEL.get(id) ?? id;
}

function normalizePayload(raw: unknown): BackupPayload {
  if (!raw || typeof raw !== 'object') throw new Error('备份文件不是合法的 JSON');
  const p = raw as Partial<BackupPayload> & { tables?: unknown };
  // v1 的备份只有 D1 表，没有分区概念：直接告诉用户这份文件太老，让他用新后台重新导
  if (!p.sections && p.tables) throw new Error('这是旧版（v1）备份文件，只有数据表、没有文章与主题样式。请到新站后台用旧版导出的评论分区单独导入，其余内容重新导一份 v2');
  if (!Array.isArray(p.sections)) throw new Error('备份文件缺少 sections 字段，不是全站备份');
  if (p.version && p.version > BACKUP_VERSION) throw new Error(`备份版本 ${p.version} 高于当前支持的 ${BACKUP_VERSION}`);
  const sections = (p.sections as BackupSection[]).filter((s) => s && typeof s.id === 'string');
  const origin = p.origin ?? { owner: '', repo: '', branch: 'main', siteUrl: '', dataDir: 'data', postsDir: 'content/zh/posts', momentsDir: 'content/zh/moments', linksFile: 'data/links.yaml', authorsFile: 'data/authors.yaml' };
  return {
    version: p.version ?? 0,
    createdAt: p.createdAt ?? 0,
    siteName: p.siteName ?? '',
    note: p.note ?? '',
    origin,
    omitted: Array.isArray(p.omitted) ? p.omitted : [],
    sections,
  };
}

/** 导入失败时 D1 会把整条 SQL 连同绑定参数（邮箱、昵称、IP…）一起回显，
    这些内容会进后台提示与 audit_logs，所以只留「params:」之前的原因部分。 */
function briefError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split(/\s+params:/i)[0].slice(0, 200);
}

function pickKnown(row: Record<string, unknown>, columns: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (columns.has(k) && v !== undefined) out[k] = v;
  return out;
}

/** 本仓库的表都是单列主键；复合主键返回 null，演习就退回粗估 */
function singlePk(table: any): { prop: string; column: any } | null {
  if (!table) return null;
  const pks = Object.entries(getTableColumns(table)).filter(([, c]) => (c as { primary?: boolean }).primary === true);
  return pks.length === 1 ? { prop: pks[0][0], column: pks[0][1] } : null;
}

export function backupKey(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  return `backups/zero-${stamp}.json`;
}

/** 只保留最近 N 份，避免每次点备份都在 R2 里堆文件 */
export async function pruneBackups(env: Env, keep = 10): Promise<number> {
  const listed = await env.R2.list({ prefix: 'backups/', limit: 1000 });
  const objects = listed.objects.sort((a, b) => (b.uploaded?.getTime() ?? 0) - (a.uploaded?.getTime() ?? 0));
  let removed = 0;
  for (const o of objects.slice(Math.max(0, keep))) {
    await env.R2.delete(o.key);
    removed++;
  }
  return removed;
}

/** 给后台显示用的分区目录（不含内容） */
export function sectionCatalog() {
  return SECTION_CATALOG;
}
