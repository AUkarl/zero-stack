import { and, gte, or, sql, type SQL } from 'drizzle-orm';
import { createDb } from '../db/client';
import { comments } from '../db/schema';
import { getConfig, getConfigBool, getConfigInt, getConfigJson } from '../services/config';
import { readRepoFileQuiet } from './frontmatter';

/**
 * 评论垃圾（广告、违法、色情、赌博、诈骗等）判定：本地规则打分为主，外部服务可选叠加。
 *
 * 设计取向：
 * - 打分累加、阈值判定，宁可进待审也不误杀（spamHoldPending 默认开）；
 * - 先做「归一化」再匹配，避免全角、零宽字符、大小写混排绕过关键词；
 * - 外部 provider 只做加法：它说垃圾才算垃圾，说正常不抵消本地高分；
 *   超时或异常一律 fail-open，不能让第三方接口把评论区整体关掉。
 *
 * 规则来源三层，都可后台维护：
 * 1. 内置话术 + spamKeywords（关键词或 /正则/flags）；
 * 2. spamCustomRegex（多行文本，每行一条 /re/flags 或裸正则）；
 * 3. 仓库文件 data/spam-patterns.txt —— 站主用 git 维护的共享黑名单，
 *    读不到就忽略（缓存 5 分钟，写入后立刻失效），绝不因为仓库抽风把评论关掉。
 * 第四层是服务商适配器（易盾 / 阿里绿网 / 腾讯天御 / generic / moderatejs），
 * 真实签名、真实发请求，score 与本地分取大值。
 */

/** 一条命中项的可溯源描述，后台「规则试跑」按来源分组展示 */
export interface RuleHit {
  /** text = 内置话术与关键词；builtin = 开箱默认规则集；regex = 正则类规则（含 /re/flags 与启发式）；file = 仓库规则文件；provider = 外部服务商 */
  source: 'text' | 'builtin' | 'regex' | 'file' | 'provider';
  /** 规则本身：关键词原文 / 正则原文 / 配置项名 / 服务商 kind */
  pattern: string;
  /** 给人看的说明，与 reason 里的片段一致 */
  label: string;
  /** 这条命中加了多少分 */
  weight: number;
}

/** 服务商这次调用的完整视图：失败也要回显，好让站主知道是签名错还是没命中 */
export interface ProviderView {
  kind: string;
  /** 调用本身成功（不代表判为垃圾） */
  ok: boolean;
  label: string;
  /** 服务商返回的原始 JSON，截断后回传 */
  raw: unknown;
  error: string | null;
}

export interface VerdictBreakdown {
  /** 内置话术命中的说明 */
  local: string[];
  /** 开箱默认规则集（DEFAULT_SPAM_PATTERN_TEXT）命中 */
  builtin: string[];
  /** spamCustomRegex 命中 */
  custom: string[];
  /** data/spam-patterns.txt 命中 */
  file: string[];
  /** 规则文件读取状态 */
  fileError: string | null;
  /** 服务商适配器的原始结果 */
  provider: { kind: string; score: number; label: string; error: string | null; raw?: unknown } | null;
}

export interface Verdict {
  /** 命中阈值 */
  spam: boolean;
  score: number;
  /** 命中的规则说明，后台直接展示 */
  reason: string;
  /** spam 时是转待审还是直接判杀 */
  hold: boolean;
  /** 逐项来源，后台「规则试跑」面板用 */
  breakdown?: VerdictBreakdown;
  /** 结构化命中项：来源 + 规则 + 权重，后台按来源分组展示 */
  rules?: RuleHit[];
  /** 参与判定的外部服务商；未启用为 null */
  provider?: ProviderView | null;
}

interface Candidate {
  content: string;
  authorName?: string | null;
  authorEmail?: string | null;
  authorLink?: string | null;
  /** 评论表里只有加盐哈希（明文 IP 从不入库），近期被拒次数按它查 */
  ipHash?: string | null;
  /** 登录用户：不再享受阈值上浮，与游客同一标准；只有站长/管理员整体跳过审核 */
  authenticated?: boolean;
  /** 账号注册时间戳，用于「新号首评带链接」规则 */
  createdAt?: number;
}

/** 内置话术（广告导流类），后台 spamKeywords 只能追加，不能替代 */
const BUILTIN_KEYWORDS = [
  '加微信', '加v信', '加vx', '加qq', '代开发票', '发票代开', '刷单', '兼职日结', '日入过千',
  '博彩', '彩票投注', '真人视讯', '六合彩', '澳门', '网贷', '贷款额度', '秒下款', '办证',
  '刻章', '私家侦探', '定位找人', 'pos机办理', '养卡套现', '免费领取', '点击链接领取',
  'whatsapp', 'telegram群', 'tg群', '招代理', '招商电话', '低息贷款', '征信修复',
];

/**
 * 开箱默认规则集（一行一条，`/正则/flags` 或裸关键词，# 开头是注释）。
 *
 * 为什么放在代码里而不是站点仓库的 data/spam-patterns.txt：那份文件是新站点没有的，
 * 后台一开就想要有一层兜底。这里作为默认基线，配合配置键：
 *   spamUseBuiltinPatterns  一个开关整份关掉（默认开）
 *   spamRuleWeight          明确规则的单条命中分，默认 70 —— 高于默认阈值 60，
 *                           也就是「站主写了这条，命中就一定进待审/拦截」
 * 后台「评论审核」页有「复制到输入框」按钮，复制出来就是这一份文本，可以逐条删改。
 *
 * 覆盖：广告导流 / 赌博彩票 / 色情 / 诈骗 / 违法物品与服务 / 违规医疗 / 高置信涉政 /
 * 英文垃圾。辱骂类只留成注释示例 —— 中文口语里太容易误杀，需要的人取消注释即可。
 */
export const DEFAULT_SPAM_PATTERN_TEXT = `# 广告导流与营销
/(加\\s*[vw]x|加\\s*微信|加\\s*qq|加\\s*好友|扫码.{0,4}(领取|进群|下载|添加)|私信.{0,4}(领取|联系|问我)|详询|有意私聊)/i
/(免费.{0,6}(领|送).{0,6}(红包|券|礼品|课程)|点击链接领取|点击.{0,4}(查看|领取)|立即.{0,4}(注册|开户|提现))/i
/(兼职|招聘).{0,6}(日结|在家|手机|躺赚|无门槛)|日入(过)?[三四五]?\\s*[千百]?万|一单一结|手工活外包
/(招商加盟|招商电话|总代|区域代理|招代理|发展下线|拉人头|返佣)/i
# 赌博彩票
/(博彩|彩票|时时彩|分分彩|快三|北京赛车|幸运飞艇|六合码|管家婆|开奖结果|投注入口|下注|上分|撤出|庄家|网投|网赌|真人视讯|真人娱乐|ag真人|欧宝|伟德|乐鱼)/i
/(澳门|拉斯维加斯).{0,6}(官方|在线|娱乐|注册|直营)/i
# 色情低俗
/(裸聊|黄聊|约炮|一夜情|包夜|楼凤|上门.{0,4}(特殊服务|按摩|服务)|伴游|情色|色情|黄片|av女优|春药|伟哥|催情|高潮|自慰|做爱|口交|性行为)/i
# 诈骗与资金类
/(杀猪盘|刷单.{0,6}(兼职|返佣|垫付)|垫付返款|返利平台|跑分|四方码|承兑|洗白|黑钱|洗钱|假币|高仿|套现|提额|征信修复|征信流水|银行卡.{0,4}(出租|出售|买卖)|个人.{0,3}(开户|四件套))/i
/(网贷|贷款|借款).{0,8}(额度|秒批|秒下款|无视征信|黑白户|包过|低息|无息)/i
/(区块链|虚拟币|资金盘|原始股|内幕消息|带你回本|稳赚不赔|包赚|躺赚分红)/i
# 违法物品与服务
/(枪支|气枪|仿真枪|钢珠枪|弹药|管制刀具|弓弩|炸药|雷管|毒品|冰毒|麻古|k粉|摇头丸|笑气|迷药|听话水|催情水|晕倒粉)/i
/(开房记录|社工库|(查|查寻|代查).{0,4}(定位|聊天记录|出行|通话|户籍)|黑客.{0,4}(服务|接单|渗透)|漏洞.{0,3}(出售|接单)|数据.{0,3}(出售|泄露|库))/i
/(代办.{0,6}(证|章|发票)|代开发票|发票代开|刻章|私家侦探|定位找人|找人服务)/i
# 违规医疗
/(无痛人流|男言之隐|早泄|阳痿|勃起障碍|补肾壮阳|特效药|祖传秘方|偏方|包治(百病)?|根治.{0,6}(糖尿病|高血压|癫痫|乙肝|脱发)|代孕|试管.{0,6}(选性别|龙凤胎|包生男)|亲子鉴定.{0,4}(私下|匿名|上门))/i
# 高置信涉政与暴恐（只留明显成词的，避免误杀正常讨论）
/(法轮功|全能神|血水圣灵|邪教|港独|疆独|藏独|台独|分裂国家|暴恐|恐怖袭击|(制作|教程).{0,4}(炸弹|燃烧瓶|枪支)|购买.{0,4}(军火|武器))/i
# 英文垃圾
/(viagra|cialis|oxycodone|codeine|soma\\b|casino\\b|slot\\b|porn\\b|xxx\\b|onlyfans|only\\s*fans|loan\\s+approval|payday\\s+loan|crypto\\s+giveaway|money\\s+transfer|western\\s+union|nigerian|click\\s+here\\s+to\\s+(claim|win)|seo\\s+services?|backlinks?|essay\\s+writing|weight\\s+loss|hair\\s+growth)/i
# 需要拦辱骂再把下面这行的 # 去掉（口语误杀率不低，默认不开）
#/(傻逼|智障|贱人|狗东西|婊子|去死吧|问候你(全家|家人))/i
`;

/**
 * 默认规则集懒编译：parsePatternLines 依赖文件后面的 REGEX_HINT（const，不提升），
 * 在模块初始化时直接调用会读到 undefined，所以留到第一次真正用到时再编译。
 */
let defaultRulesCache: PatternRule[] | null = null;
function defaultRules(): PatternRule[] {
  if (!defaultRulesCache) defaultRulesCache = parsePatternLines(DEFAULT_SPAM_PATTERN_TEXT).rules;
  return defaultRulesCache;
}

/** 引流联系方式特征 */
const CONTACT_PATTERNS: { re: RegExp; weight: number; label: string }[] = [
  { re: /qq[:：]?\s*\d{5,12}/i, weight: 25, label: '正文含 QQ 号' },
  { re: /微信[:：]?\s*[a-z0-9_-]{5,20}/i, weight: 25, label: '正文含微信号' },
  { re: /(?:tel|电话|手机)[:：]?\s*[\d\-+ ]{7,15}/i, weight: 20, label: '正文含电话号码' },
  { re: /(?:https?:\/\/)?(?:t\.me|wa\.me|qq\.com\/group)/i, weight: 25, label: '正文含即时通讯引流链接' },
];

const URL_RE = /https?:\/\/\S+/gi;
const ATOM_RE = /(^|\s|\()[a-z0-9][a-z0-9-]{1,60}(\.[a-z]{2,}){1,3}(\/\S*)?/gi;

/**
 * 归一化：零宽字符与软连字符是关键词绕过的主要手段；全角转半角；
 * 中文之间的空格压掉（「加 微 信」这类拆字写法）。
 */
export function normalizeText(raw: string): string {
  const stripped = raw.replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '');
  const half = stripped.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const despaced = half.replace(/([\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5])/g, '$1');
  return despaced.toLowerCase();
}

function urlCount(text: string): number {
  return (text.match(URL_RE) ?? []).length;
}

function linkChars(text: string): number {
  return (text.match(URL_RE) ?? []).join('').length;
}

function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** 同一字符连续重复 5 次以上，或整段由某个 2-6 字单元完整重复构成 */
function isPadding(text: string): boolean {
  if (/(.)\1{5,}/.test(text)) return true;
  const compact = text.replace(/\s+/g, '');
  if (compact.length < 12) return false;
  for (let len = 2; len <= 6; len++) {
    if (compact.length % len !== 0) continue;
    const unit = compact.slice(0, len);
    if (unit.repeat(compact.length / len) === compact) return true;
  }
  return false;
}

/** 疑似乱码/编码灌水：非中日韩且非 ASCII 可见字符占比过高 */
function isGarbled(text: string): boolean {
  const chars = [...text.replace(/\s+/g, '')];
  if (chars.length < 8) return false;
  const noise = chars.filter((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    const cjk = cp >= 0x4e00 && cp <= 0x9fff;
    const ascii = cp >= 0x20 && cp <= 0x7e;
    return !cjk && !ascii;
  }).length;
  return noise / chars.length > 0.5;
}

async function recentRejected(env: Env, input: Candidate): Promise<number> {
  const conds: SQL[] = [];
  if (input.ipHash) conds.push(sql`ip_hash = ${input.ipHash}`);
  if (input.authorEmail) conds.push(sql`author_email = ${input.authorEmail}`);
  if (!conds.length) return 0;
  const rows = await createDb(env)
    .select({ n: sql<number>`count(*)` })
    .from(comments)
    .where(
      and(
        gte(comments.createdAt, Math.floor(Date.now() / 1000) - 3600),
        or(...conds),
        sql`status <> 'approved'`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/* ------------------------------------------------------------------ 规则来源 */

/** 一条规则：/re/flags 形式的正则，或者普通关键词 */
export interface PatternRule {
  /** 原始行，回显给后台 */
  raw: string;
  type: 'regex' | 'keyword';
  re?: RegExp;
  kw?: string;
}

export interface ParsedPatterns {
  rules: PatternRule[];
  /** 写坏的行：正则为空 / 无法编译，后台直接看到第几行有问题 */
  invalid: { line: number; text: string; reason: string }[];
}

/** 含这些符号就当正则处理，否则当关键词 */
const REGEX_HINT = /[\\^$\[\](){}|+*?.]|\\\\d|\\\\w/;

/**
 * 逐行解析规则文本。允许：
 *   /博彩|彩票/i         正则
 *   六合彩               关键词
 *   # 注释               跳过
 *   - 前导短横（markdown 列表写法）自动忽略
 */
export function parsePatternLines(text: string): ParsedPatterns {
  const rules: PatternRule[] = [];
  const invalid: ParsedPatterns['invalid'] = [];
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');

  lines.forEach((line, index) => {
    const trimmed = line.trim().replace(/^[-*]\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) return;

    const literal = /^\/([\s\S]+)\/([a-z]*)$/i.exec(trimmed);
    if (literal) {
      const body = literal[1]!;
      const flags = (literal[2] ?? '').replace(/g/y, '');
      if (!body) {
        invalid.push({ line: index + 1, text: trimmed, reason: '正则为空' });
        return;
      }
      try {
        rules.push({ raw: trimmed, type: 'regex', re: new RegExp(body, flags) });
      } catch (e) {
        invalid.push({ line: index + 1, text: trimmed, reason: e instanceof Error ? e.message : '正则无法编译' });
      }
      return;
    }

    if (REGEX_HINT.test(trimmed)) {
      try {
        rules.push({ raw: trimmed, type: 'regex', re: new RegExp(trimmed, 'i') });
      } catch {
        // 裸正则写坏了就退回关键词，不能因为一行坏字符丢掉整份文件
        rules.push({ raw: trimmed, type: 'keyword', kw: normalizeText(trimmed) });
      }
      return;
    }

    const kw = normalizeText(trimmed);
    if (kw) rules.push({ raw: trimmed, type: 'keyword', kw });
  });

  return { rules, invalid };
}

/** 规则集的单条命中：pattern 是规则原文，label 是给人看的说明 */
interface RuleMatch {
  pattern: string;
  label: string;
}

/** 规则集打分：每条命中 +40，最多算 3 条，避免一份大文件把分刷爆 */
function matchRules(rules: PatternRule[], normalized: string, raw: string): RuleMatch[] {
  const hits: RuleMatch[] = [];
  for (const rule of rules) {
    if (rule.type === 'regex' && rule.re) {
      if (rule.re.test(raw) || rule.re.test(normalized)) hits.push({ pattern: rule.raw, label: `规则「${rule.raw}」` });
    } else if (rule.kw && normalized.includes(rule.kw)) {
      hits.push({ pattern: rule.raw, label: `规则关键词「${rule.raw}」` });
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

/** spamCustomRegex：后台「反垃圾」页那个多行文本框 */
export async function customRules(env: Env): Promise<PatternRule[]> {
  const raw = (await getConfig(env, 'spamCustomRegex')) ?? '';
  return parsePatternLines(raw).rules;
}

/* ------------------------------------------------------------ 仓库规则文件 */

export const SPAM_PATTERN_FILE = 'data/spam-patterns.txt';
const PATTERN_CACHE_KEY = 'zero:spam-patterns';
const PATTERN_CACHE_TTL = 300;

export interface PatternFileState {
  /** 生效路径（就是 SPAM_PATTERN_FILE，留成函数方便以后做配置项） */
  path: string;
  exists: boolean;
  content: string;
  error: string | null;
}

/** 读规则文件；仓库没配、文件不存在、GitHub 抽风都只回错误说明，不影响主流程 */
export async function readPatternFile(env: Env, opts: { refresh?: boolean } = {}): Promise<PatternFileState> {
  const path = SPAM_PATTERN_FILE;
  if (!opts.refresh) {
    const cached = await cacheGet(env, PATTERN_CACHE_KEY);
    if (cached !== null) return { path, exists: cached !== '', content: cached, error: null };
  }

  let content = '';
  let error: string | null = null;
  try {
    const file = await readRepoFileQuiet(env, path);
    if (!file) error = `仓库里没有 ${path}`;
    else content = file.content;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  try {
    await env.CACHE.put(PATTERN_CACHE_KEY, content, { expirationTtl: PATTERN_CACHE_TTL });
  } catch {
    /* 缓存失败下次再读 */
  }
  return { path, exists: !error && content !== '', content, error };
}

async function cacheGet(env: Env, key: string): Promise<string | null> {
  try {
    return await env.CACHE.get(key, { type: 'text' });
  } catch {
    return null;
  }
}

/** 后台改完规则文件要立刻生效 */
export async function invalidatePatternFile(env: Env): Promise<void> {
  try {
    await env.CACHE.delete(PATTERN_CACHE_KEY);
  } catch {
    /* 忽略 */
  }
}

let fileRuleCache: { stamp: number; rules: PatternRule[] } | null = null;

/** 评论路径上不能每次读仓库，规则文件在进程里也留 5 分钟 */
async function fileRules(env: Env): Promise<{ rules: PatternRule[]; error: string | null }> {
  const now = Date.now();
  if (fileRuleCache && now - fileRuleCache.stamp < PATTERN_CACHE_TTL * 1000) return { rules: fileRuleCache.rules, error: null };
  const state = await readPatternFile(env);
  const rules = state.error ? [] : parsePatternLines(state.content).rules;
  fileRuleCache = { stamp: now, rules };
  return { rules, error: state.error };
}

export function resetPatternCache(): void {
  fileRuleCache = null;
}

/* ------------------------------------------------------------------ 服务商 */

export type SpamProviderKind = 'none' | 'generic' | 'netease' | 'aliyun' | 'tencent' | 'moderatejs';

export const SPAM_PROVIDER_PRESETS: {
  kind: SpamProviderKind;
  label: string;
  needsKey: boolean;
  needsSecret: boolean;
  defaultEndpoint: string;
  hint: string;
}[] = [
  { kind: 'none', label: '不启用', needsKey: false, needsSecret: false, defaultEndpoint: '', hint: '只用本地规则' },
  {
    kind: 'generic',
    label: '自建 HTTP 审核',
    needsKey: true,
    needsSecret: false,
    defaultEndpoint: '',
    hint: 'POST {text} → {score?|label?|spam?}，带 Authorization: Bearer <密钥>',
  },
  {
    kind: 'netease',
    label: '网易易盾',
    needsKey: true,
    needsSecret: true,
    defaultEndpoint: 'https://as.dun.163.com/v21/text/check',
    hint: 'KeyId 填 secretId，Secret 填 secretKey；业务 id 写在 endpoint 的 ?businessId= 上',
  },
  {
    kind: 'aliyun',
    label: '阿里绿网（内容安全）',
    needsKey: true,
    needsSecret: true,
    defaultEndpoint: 'https://green-cip.cn-shanghai.aliyuncs.com/',
    hint: 'KeyId 填 AccessKeyId，Secret 填 AccessKeySecret，RPC 签名 HMAC-SHA1',
  },
  {
    kind: 'tencent',
    label: '腾讯云天御（内容安全）',
    needsKey: true,
    needsSecret: true,
    defaultEndpoint: 'https://cps.tencentcloudapi.com/',
    hint: 'KeyId 填 SecretId，Secret 填 SecretKey，TC3-HMAC-SHA256 签名',
  },
  {
    kind: 'moderatejs',
    label: 'moderate.js 自建服务',
    needsKey: true,
    needsSecret: false,
    defaultEndpoint: 'https://moderate.example.com/api/check',
    hint: 'POST {text} → {isBad|spam|block, reason}；密钥走 Bearer',
  },
];

export interface ProviderOutcome {
  kind: SpamProviderKind;
  score: number;
  label: string;
  error: string | null;
  /** 服务商返回的原始 JSON（没有则为 null），后台试跑面板回显用 */
  raw?: unknown;
}

/** 把响应体挂到判定结果上：raw 只用于展示，不参与打分 */
function withRaw(out: ProviderOutcome, body: { json: unknown; raw: string }): ProviderOutcome {
  return { ...out, raw: body.json ?? (clip(body.raw) || null) };
}

const LABEL_SCORES: Record<string, number> = {
  normal: 0,
  pass: 0,
  ok: 0,
  none: 0,
  无风险: 0,
  ad: 75,
  advertising: 75,
  广告: 75,
  spam: 70,
  垃圾: 70,
  politics: 90,
  political: 90,
  涉政: 90,
  porn: 90,
  pornography: 90,
  涉黄: 90,
  abusive: 80,
  abuse: 80,
  辱骂: 80,
  terrorism: 95,
  illegal: 85,
  违禁: 85,
  fraud: 85,
  欺诈: 85,
  qrcode: 70,
  引流: 75,
};

/** 标签字符串 → 分数：认不出的标签按「有风险」给 60，绝不当成 0 */
function labelToScore(label: string): number {
  const key = label.trim().toLowerCase();
  if (!key) return 0;
  if (LABEL_SCORES[key] !== undefined) return LABEL_SCORES[key]!;
  const hit = Object.keys(LABEL_SCORES).find((k) => key.includes(k));
  return hit ? LABEL_SCORES[hit]! : 60;
}

const PROVIDER_TIMEOUT_MS = 3000;

/** 一次外部调用的总闸门：超时、非 2xx、解析失败一律 fail-open */
async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, onFail: (error: string) => T): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } catch (e) {
    const msg = e instanceof Error ? (/AbortError|timeout/i.test(e.name + e.message) ? `${PROVIDER_TIMEOUT_MS}ms 超时` : e.message) : String(e);
    return onFail(msg);
  } finally {
    clearTimeout(timer);
  }
}

const textEnc = new TextEncoder();

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEnc.encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacRaw(secret: string | Uint8Array, data: string, hash: 'SHA-1' | 'SHA-256'): Promise<Uint8Array> {
  const raw = typeof secret === 'string' ? textEnc.encode(secret) : secret;
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, textEnc.encode(data)));
}

async function hmacBase64(secret: string, data: string): Promise<string> {
  const bytes = await hmacRaw(secret, data, 'SHA-1');
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64(s: string): string {
  const bytes = textEnc.encode(s);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** 阿里云 RPC 风格的 percentEncode：空格是 %20、星号是 %2A、波浪号不编码 */
function aliyunEncode(value: string): string {
  return encodeURIComponent(value).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

/**
 * 服务商判定入口：按 spamProviderKind 派发到对应适配器。
 * 返回 null 表示没参与（未启用）；error 只影响后台显示，评论路径永远 fail-open。
 */
export async function providerVerdict(
  env: Env,
  text: string,
  override?: { kind?: string; endpoint?: string; keyId?: string; secret?: string },
): Promise<ProviderOutcome | null> {
  const kind = String(override?.kind ?? (await getConfig(env, 'spamProviderKind')) ?? 'none') as SpamProviderKind;
  const preset = SPAM_PROVIDER_PRESETS.find((p) => p.kind === kind);
  if (kind === 'none' || !preset) return null;

  const endpoint = (override?.endpoint || (await getConfig(env, 'spamProviderEndpoint')) || preset.defaultEndpoint).trim();
  const keyId = (override?.keyId || (await getConfig(env, 'spamProviderKeyId')) || '').trim();
  const secret = (override?.secret || (await getConfig(env, 'spamProviderSecret')) || '').trim();
  const content = String(text ?? '').slice(0, 2000);
  if (!content) return null;
  if (!endpoint) return { kind, score: 0, label: '', error: `${preset.label} 缺少 endpoint` };
  if ((preset.needsKey && !keyId) || (preset.needsSecret && !secret)) {
    return { kind, score: 0, label: '', error: `${preset.label} 缺少${preset.needsKey ? ' KeyId' : ''}${preset.needsSecret ? ' / Secret' : ''}` };
  }

  switch (kind) {
    case 'netease':
      return neteaseVerdict(endpoint, keyId, secret, content);
    case 'aliyun':
      return aliyunVerdict(endpoint, keyId, secret, content);
    case 'tencent':
      return tencentVerdict(endpoint, keyId, secret, content);
    case 'moderatejs':
      return moderateJsVerdict(endpoint, keyId, content);
    case 'generic':
    default:
      return genericVerdict(endpoint, keyId, content);
  }
}

/** generic / moderatejs：POST JSON，尽力解析常见字段名 */
async function genericVerdict(endpoint: string, keyId: string, content: string): Promise<ProviderOutcome> {
  return withTimeout(
    async (signal) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyId}`, 'X-Api-Key': keyId },
        body: JSON.stringify({ text: content, content, provider: 'generic' }),
      });
      const body = await readJson(res);
      if (!res.ok) return { kind: 'generic' as SpamProviderKind, score: 0, label: '', error: `HTTP ${res.status}：${clip(body.raw)}`, raw: body.json ?? clip(body.raw) };
      return withRaw(normalizeGeneric(body.json, 'generic'), body);
    },
    (error) => ({ kind: 'generic' as SpamProviderKind, score: 0, label: '', error }),
  );
}

async function moderateJsVerdict(endpoint: string, keyId: string, content: string): Promise<ProviderOutcome> {
  const out = await withTimeout<ProviderOutcome>(
    async (signal) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyId}` },
        body: JSON.stringify({ text: content }),
      });
      const body = await readJson(res);
      if (!res.ok) return { kind: 'moderatejs', score: 0, label: '', error: `HTTP ${res.status}：${clip(body.raw)}`, raw: body.json ?? clip(body.raw) };
      const json = (body.json ?? {}) as Record<string, unknown>;
      const flagged = json.isBad ?? json.bad ?? json.spam ?? json.block ?? json.flagged;
      const score = Number(json.score ?? json.confidence ?? 0);
      const label = String(json.reason ?? json.label ?? (flagged ? '命中' : ''));
      const finalScore = Number.isFinite(score) && score > 0 ? clampScore(score > 1 ? score : score * 100) : flagged ? 70 : 0;
      return withRaw({ kind: 'moderatejs', score: finalScore, label, error: null }, body);
    },
    (error) => ({ kind: 'moderatejs', score: 0, label: '', error }),
  );
  return out;
}

/**
 * 网易易盾文本检测 v21：
 *   业务参数按 key 升序拼 k=v&，signature = SHA256(secretId + nonce + <升序串> + timestamp + secretKey)
 *   表单 POST，response.data[].label：0 正常 / 1 广告 / 2 涉政 / 3 辱骂 / 4 涉黄 / 99 其他
 */
async function neteaseVerdict(endpoint: string, secretId: string, secretKey: string, content: string): Promise<ProviderOutcome> {
  const url = new URL(endpoint);
  const businessId = url.searchParams.get('businessId') ?? '';
  const timestamp = Date.now();
  const nonce = randomDigits(20);

  const params: Record<string, string> = {
    secretId,
    timestamp: String(timestamp),
    nonce,
    contentType: '2',
    content,
    ip: '',
  };
  if (businessId) params.businessId = businessId;

  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k] ?? ''}`)
    .join('&');

  return withTimeout<ProviderOutcome>(
    async (signal) => {
      const signature = await sha256Hex(`${secretId}${nonce}${sorted}${timestamp}${secretKey}`);
      const form = new URLSearchParams({ ...params, signature });
      const res = await fetch(`${url.protocol}//${url.host}${url.pathname}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const body = await readJson(res);
      if (!res.ok) return { kind: 'netease', score: 0, label: '', error: `HTTP ${res.status}：${clip(body.raw)}`, raw: body.json ?? clip(body.raw) };
      const json = (body.json ?? {}) as { code?: number; msg?: string; message?: string; data?: unknown };
      if (json.code !== undefined && json.code !== 200) {
        return { kind: 'netease', score: 0, label: '', error: `易盾返回 code=${json.code} ${json.msg ?? json.message ?? ''}`, raw: body.json };
      }
      const labels = collectLabels(json.data);
      const score = labels.length ? Math.max(...labels.map((l) => labelToScore(l))) : 0;
      return withRaw({ kind: 'netease', score, label: labels.join('/') || '正常', error: null }, body);
    },
    (error) => ({ kind: 'netease', score: 0, label: '', error }),
  );
}

/**
 * 阿里云内容安全（green-cip，RPC 签名 Version=2022-03-02 / Action=TextModeration）：
 *   StringToSign = POST&%2F&percentEncode(升序参数串)，Signature = base64(HMAC-SHA1(secret + '&', StringToSign))
 */
async function aliyunVerdict(endpoint: string, accessKeyId: string, secret: string, content: string): Promise<ProviderOutcome> {
  const url = new URL(endpoint);
  const region = url.hostname.split('.')[1]?.startsWith('green-cip')
    ? url.hostname.split('.')[1]!.replace(/^green-cip\./, '')
    : 'cn-shanghai';

  const params: Record<string, string> = {
    Action: 'TextModeration',
    Version: '2022-03-02',
    Format: 'JSON',
    RegionId: region,
    AccessKeyId: accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Service: 'comment_detection',
    ServiceParameters: JSON.stringify({ content, dataId: crypto.randomUUID() }),
  };

  return withTimeout<ProviderOutcome>(
    async (signal) => {
      const canonical = Object.keys(params)
        .sort()
        .map((k) => `${aliyunEncode(k)}=${aliyunEncode(params[k] ?? '')}`)
        .join('&');
      const stringToSign = `POST&${aliyunEncode('/')}&${aliyunEncode(canonical)}`;
      const signature = await hmacBase64(`${secret}&`, stringToSign);
      const res = await fetch(`${url.protocol}//${url.host}/`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: `${canonical}&Signature=${aliyunEncode(signature)}`,
      });
      const body = await readJson(res);
      if (!res.ok) return { kind: 'aliyun', score: 0, label: '', error: `HTTP ${res.status}：${clip(body.raw)}`, raw: body.json ?? clip(body.raw) };
      const json = (body.json ?? {}) as { Code?: number | string; Message?: string; Data?: unknown };
      if (json.Code !== undefined && Number(json.Code) !== 200) {
        return { kind: 'aliyun', score: 0, label: '', error: `绿网返回 Code=${json.Code} ${json.Message ?? ''}`, raw: body.json };
      }
      const labels = collectLabels(json.Data);
      const score = labels.length ? Math.max(...labels.map((l) => labelToScore(l))) : 0;
      return withRaw({ kind: 'aliyun', score, label: labels.join('/') || 'normal', error: null }, body);
    },
    (error) => ({ kind: 'aliyun', score: 0, label: '', error }),
  );
}

/**
 * 腾讯云内容安全 TextModeration（2019-06-12），TC3-HMAC-SHA256 签名：
 *   Content 需要 Base64；Response.Label / Response.Result[].Label 是风险标签
 */
async function tencentVerdict(endpoint: string, secretId: string, secretKey: string, content: string): Promise<ProviderOutcome> {
  const url = new URL(endpoint);
  const service = url.hostname.split('.')[0] === 'cps' ? 'cps' : url.hostname.split('.')[0]!;
  const host = url.host;
  const payload = JSON.stringify({ Content: base64(content), DataType: 1 });
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

  return withTimeout<ProviderOutcome>(
    async (signal) => {
      const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:textmoderation\n`;
      const signedHeaders = 'content-type;host;x-tc-action';
      const hashedPayload = await sha256Hex(payload);
      const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
      const credentialScope = `${date}/${service}/tc3_request`;
      const hashedCanonical = await sha256Hex(canonicalRequest);
      const stringToSign = ['TC3-HMAC-SHA256', String(timestamp), credentialScope, hashedCanonical].join('\n');
      const secretDate = await hmacRaw(`TC3${secretKey}`, date, 'SHA-256');
      const secretService = await hmacRaw(secretDate, service, 'SHA-256');
      const secretSigning = await hmacRaw(secretService, 'tc3_request', 'SHA-256');
      const signature = [...(await hmacRaw(secretSigning, stringToSign, 'SHA-256'))].map((b) => b.toString(16).padStart(2, '0')).join('');

      const res = await fetch(`${url.protocol}//${host}/`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json',
          Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
          'X-TC-Action': 'TextModeration',
          'X-TC-Version': '2019-06-12',
          'X-TC-Timestamp': String(timestamp),
        },
        body: payload,
      });
      const body = await readJson(res);
      if (!res.ok) return { kind: 'tencent', score: 0, label: '', error: `HTTP ${res.status}：${clip(body.raw)}`, raw: body.json ?? clip(body.raw) };
      const json = (body.json ?? {}) as { Response?: { Error?: { Message?: string }; Label?: string; Results?: unknown } };
      const resp = json.Response ?? {};
      if (resp.Error) return { kind: 'tencent', score: 0, label: '', error: `天御返回 ${resp.Error.Message ?? '未知错误'}`, raw: json };
      const labels = collectLabels(resp.Results ?? resp.Label);
      const score = labels.length ? Math.max(...labels.map((l) => labelToScore(l))) : 0;
      return withRaw({ kind: 'tencent', score, label: labels.join('/') || String(resp.Label ?? 'Normal'), error: null }, body);
    },
    (error) => ({ kind: 'tencent', score: 0, label: '', error }),
  );
}

/** generic 响应归一化：score / spam / label 三选其一即可 */
function normalizeGeneric(json: unknown, kind: SpamProviderKind): ProviderOutcome {
  const o = (json ?? {}) as Record<string, unknown>;
  const raw = o.data ?? o.result ?? o;
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const merged = { ...obj, ...o } as Record<string, unknown>;
  const declared = Number(merged.score ?? merged.confidence ?? merged.probability ?? NaN);
  const flagged = merged.spam ?? merged.isSpam ?? merged.is_spam ?? merged.block ?? merged.flagged ?? merged.bad;
  const label = String(merged.label ?? merged.reason ?? merged.category ?? merged.msg ?? '').trim();
  let score = Number.isFinite(declared) ? clampScore(declared > 0 && declared <= 1 ? declared * 100 : declared) : 0;
  if (!score && flagged === true) score = label ? labelToScore(label) || 70 : 70;
  if (flagged === false && !Number.isFinite(declared)) score = 0;
  return { kind, score, label: label || (score ? '外部判定' : ''), error: null };
}

/** 从任意层级的响应里把所有可疑标签抠出来：label / labels / Results[].Label */
function collectLabels(node: unknown, depth = 0): string[] {
  if (depth > 4 || node == null) return [];
  if (typeof node === 'string') return node ? [node] : [];
  if (Array.isArray(node)) return node.flatMap((n) => collectLabels(n, depth + 1));
  if (typeof node !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (/^(labels?|tag|category|riskType|reason)$/i.test(k)) {
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) out.push(...v.map((x) => (typeof x === 'string' ? x : String((x as Record<string, unknown>)?.label ?? ''))));
      continue;
    }
    out.push(...collectLabels(v, depth + 1));
  }
  return out.filter((s) => s && s !== '[object Object]');
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function randomDigits(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => String(b % 10)).join('');
}

async function readJson(res: Response): Promise<{ json: unknown; raw: string }> {
  const raw = await res.text().catch(() => '');
  try {
    return { json: JSON.parse(raw) as unknown, raw };
  } catch {
    return { json: null, raw };
  }
}

function clip(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').slice(0, 160);
}

/* 旧版单端点 provider（spamExternalProvider），保留兼容，新配置走 providerVerdict */

async function externalVerdict(env: Env, text: string): Promise<{ score: number; reason: string } | null> {
  const provider = (await getConfig(env, 'spamExternalProvider')) ?? 'none';
  const endpoint = (await getConfig(env, 'spamExternalEndpoint')) ?? '';
  const key = (await getConfig(env, 'spamExternalKey')) ?? '';
  if (provider === 'none' || !endpoint) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}`, 'X-Api-Key': key } : {}),
      },
      body: JSON.stringify({ text, provider }),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { spam?: boolean; score?: number; label?: string } | null;
    if (!data) return null;
    const score = Number.isFinite(data.score) ? Math.max(0, Math.min(100, Number(data.score))) : data.spam ? 60 : 0;
    return { score, reason: data.label ? `外部服务：${data.label}` : '外部服务判定' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 后台「规则试跑」可以临时指定 provider 与密钥，不用先写进 site_config 再测 */
export interface InspectOptions {
  /** 临时覆盖 spamProviderKind */
  providerKind?: string;
  providerEndpoint?: string;
  providerKeyId?: string;
  providerSecret?: string;
  /** 强制重读仓库里的规则文件（后台刚编辑完想看效果） */
  refreshPatterns?: boolean;
}

export async function inspectComment(env: Env, input: Candidate, options: InspectOptions = {}): Promise<Verdict> {
  const enabled = await getConfigBool(env, 'spamEnabled', true);
  const threshold = await getConfigInt(env, 'spamThreshold', 60);
  const hold = await getConfigBool(env, 'spamHoldPending', false);
  /** 明确规则（关键词 / 默认规则集 / 自定义正则 / 仓库文件）的单条命中分，默认 70 > 阈值 60 */
  const ruleWeight = await getConfigInt(env, 'spamRuleWeight', 70);
  const useBuiltin = await getConfigBool(env, 'spamUseBuiltinPatterns', true);
  const emptyBreakdown: VerdictBreakdown = { local: [], builtin: [], custom: [], file: [], fileError: null, provider: null };
  if (!enabled) return { spam: false, score: 0, reason: '', hold, breakdown: emptyBreakdown, rules: [], provider: null };

  const maxUrls = await getConfigInt(env, 'spamMaxUrls', 3);
  const minWords = await getConfigInt(env, 'spamMinWords', 2);
  const linkRatioLimit = Number((await getConfig(env, 'spamLinkRatio')) ?? '0.5');
  const keywordsSetting = await getConfigJson<string[]>(env, 'spamKeywords', []);
  const extraKeywords = Array.isArray(keywordsSetting) ? keywordsSetting.map((k) => String(k).trim()).filter(Boolean) : [];

  const raw = input.content ?? '';
  const text = normalizeText(raw);
  const hits: string[] = [];
  /** 与 hits 同步累积的结构化命中：hits 保持原样，老调用方（评论入库）不受影响 */
  const ruleHits: RuleHit[] = [];
  const breakdown: VerdictBreakdown = { ...emptyBreakdown };
  let score = 0;

  /** 加一条命中：分数、文案、结构化来源三处一起记，避免以后再对不上 */
  const add = (weight: number, label: string, source: RuleHit['source'], pattern?: string) => {
    score += weight;
    hits.push(label);
    ruleHits.push({ source, pattern: pattern ?? label, label, weight });
  };

  const keywordPairs = [
    ...BUILTIN_KEYWORDS.map((k) => ({ raw: k, norm: normalizeText(k) })),
    ...extraKeywords.map((k) => ({ raw: k, norm: normalizeText(k) })),
  ];
  for (const { raw: kwRaw, norm: kw } of keywordPairs) {
    if (!kw) continue;
    if (kw.startsWith('/') && kw.lastIndexOf('/') > 0) {
      try {
        const last = kw.lastIndexOf('/');
        const re = new RegExp(kw.slice(1, last), kw.slice(last + 1).replace(/g/g, ''));
        if (re.test(text)) add(ruleWeight, `命中规则「${kwRaw}」`, 'regex', kwRaw);
        continue;
      } catch {
        // 写坏的正则按普通关键词处理，不能让一条错配把审核整体关掉
      }
    }
    if (text.includes(kw)) add(ruleWeight, `命中关键词「${kwRaw}」`, 'text', kwRaw);
  }

  /* 开箱默认规则集（spamUseBuiltinPatterns 一个开关整份关掉） */
  if (useBuiltin) {
    const builtinMatches = matchRules(defaultRules(), text, raw);
    for (const m of builtinMatches) {
      add(ruleWeight, m.label, 'builtin', m.pattern);
    }
    breakdown.builtin = builtinMatches.map((m) => m.label);
  }

  for (const p of CONTACT_PATTERNS) {
    if (p.re.test(raw)) add(p.weight, p.label, 'regex', p.re.source);
  }

  const urls = urlCount(text);
  if (urls > maxUrls) add(35, `链接数 ${urls} 超过上限 ${maxUrls}`, 'text', 'spamMaxUrls');
  const compact = text.replace(/\s+/g, '');
  const ratio = compact.length ? linkChars(text) / compact.length : 0;
  if (ratio > linkRatioLimit) add(30, `链接字符占比 ${Math.round(ratio * 100)}%`, 'text', 'spamLinkRatio');
  if (urls > 0 && compact.replace(URL_RE, '').length < minWords * 2) add(25, '正文几乎只有链接', 'text', 'spamMinWords');

  const linkHost = hostOf(input.authorLink);
  if (linkHost) {
    const contentHosts = (text.match(ATOM_RE) ?? []).map((s) => hostOf(s.trim())).filter(Boolean);
    if (contentHosts.some((h) => h === linkHost || h.endsWith(`.${linkHost}`) || linkHost.endsWith(`.${h}`))) {
      add(15, '签名链接与正文链接同域，疑似自我推广', 'text', 'authorLink');
    }
  }

  if (isPadding(text)) add(20, '重复字符灌水', 'text', 'padding');
  if (isGarbled(text)) add(25, '疑似乱码内容', 'text', 'garbled');

  if (input.createdAt && Math.floor(Date.now() / 1000) - input.createdAt < 600 && urls > 0) {
    add(20, '注册十分钟内首条评论含链接', 'text', 'newAccountLink');
  }

  const rejected = await recentRejected(env, input);
  if (rejected >= 5) add(25, `近一小时已有 ${rejected} 条未通过评论`, 'text', 'recentRejected');

  breakdown.local = [...hits];

  /* 自定义正则（spamCustomRegex） */
  const customMatches = matchRules(await customRules(env), text, raw);
  if (customMatches.length) {
    for (const m of customMatches) {
      add(ruleWeight, m.label, 'regex', m.pattern);
    }
    breakdown.custom = customMatches.map((m) => m.label);
  }

  /* 仓库规则文件 data/spam-patterns.txt */
  if (options.refreshPatterns) resetPatternCache();
  const file = await fileRules(env);
  breakdown.fileError = file.error;
  if (file.rules.length) {
    const fileMatches = matchRules(file.rules, text, raw);
    if (fileMatches.length) {
      for (const m of fileMatches) {
        add(ruleWeight, m.label, 'file', m.pattern);
      }
      breakdown.file = fileMatches.map((m) => m.label);
    }
  }

  /* 服务商适配器：只做加法，失败 fail-open */
  const provider = await providerVerdict(env, raw, {
    kind: options.providerKind,
    endpoint: options.providerEndpoint,
    keyId: options.providerKeyId,
    secret: options.providerSecret,
  });
  if (provider) {
    breakdown.provider = { kind: provider.kind, score: provider.score, label: provider.label, error: provider.error, raw: provider.raw ?? null };
    if (provider.score > 0) {
      const label = `服务商 ${provider.kind}：${provider.label || `score ${provider.score}`}`;
      score = Math.max(score, provider.score);
      hits.push(label);
      ruleHits.push({ source: 'provider', pattern: `provider:${provider.kind}`, label, weight: provider.score });
    }
  }

  /* 旧版单端点配置，留着不破坏已有站点 */
  const external = await externalVerdict(env, raw);
  if (external) {
    score = Math.max(score, external.score);
    if (external.score > 0) {
      hits.push(external.reason);
      ruleHits.push({ source: 'provider', pattern: 'spamExternalProvider', label: external.reason, weight: external.score });
    }
  }

  // 登录用户与游客同一阈值：垃圾话不会因为换了个账号就过得了
  const effective = threshold;
  const final = Math.min(100, Math.round(score));
  return {
    spam: final >= effective,
    score: final,
    reason: hits.join('；'),
    hold,
    breakdown,
    rules: ruleHits,
    provider: provider
      ? { kind: provider.kind, ok: !provider.error, label: provider.label, raw: provider.raw ?? null, error: provider.error }
      : null,
  };
}
