/**
 * zmsg.ts — 把 zod 的英文回执翻成「照着能改的中文」，并且点名是**哪一个字段**。
 *
 * 台架 2026-10-29 实测：中文界面里直接冒 zod 原话 ——
 *   `{site:{keywords:'不是数组'}}` → 「基本信息保存失败：Expected array, received string」
 *   `{nav:{items:[{text:'…',url:'/about/'}]}}` → 「导航栏保存失败：Required」
 * 两句都没说「哪一项、缺什么」，用户只能把表单再填一遍。同一族里做得好的对照是
 * `siteUrl` 那句（「这里要写成带 http:// 或 https:// 的完整站点地址…」），
 * 差别只在有没有把 `issues[].path` 带出来。所以这里收成一个口：**所有**校验失败都过它。
 */
import type { ZodIssue } from 'zod';

/** 界面上确实有对应控件、又容易被英文键名绕住的几项 */
const FIELD_ZH: Record<string, string> = {
  title: '标题',
  name: '名称',
  penName: '笔名',
  bio: '简介',
  description: '说明',
  summary: '摘要',
  keywords: '关键词',
  items: '条目',
  text: '显示文字',
  label: '显示文字',
  url: '网址',
  link: '链接地址',
  friendLink: '友链地址',
  rssUrl: 'RSS 地址',
  avatar: '头像地址',
  image: '封面图',
  email: '邮箱',
  reason: '申请说明',
  content: '正文',
  social: '社交平台',
  platform: '平台',
  donateImages: '赞赏图',
  handle: '作者标识',
  category: '分类',
  tags: '标签',
  color: '颜色',
  sortOrder: '排序',
  recipients: '收件人',
  subject: '主题',
  body: '正文',
  path: '文件路径',
  front: 'front matter',
  slug: '标识',
};

/** 路径 → 「基本信息 的第 2 条导航项的 显示文字」这种能说清位置的写法 */
function pathZh(path: (string | number)[]): string {
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    if (typeof seg === 'number') {
      const prev = typeof path[i - 1] === 'string' ? (path[i - 1] as string) : '';
      parts.push(`${FIELD_ZH[prev] ?? prev}第 ${seg + 1} 项`);
      continue;
    }
    parts.push(FIELD_ZH[seg] ?? seg);
  }
  return parts.filter(Boolean).join(' 的 ');
}

const TYPE_ZH: Record<string, string> = {
  string: '一段文字',
  number: '数字',
  array: '一个列表（数组）',
  object: '一组字段',
  boolean: '是 / 否',
  date: '时间',
};

function describe(issue: ZodIssue): string {
  const where = issue.path.length ? `「${pathZh(issue.path)}」` : '这一份表单';
  switch (issue.code) {
    case 'invalid_type':
      return `${where}要的是${TYPE_ZH[String(issue.expected)] ?? String(issue.expected)}，现在送的是${TYPE_ZH[String((issue as { received?: unknown }).received)] ?? String((issue as { received?: unknown }).received)}`;
    case 'invalid_union':
      return `${where}几种写法都对不上，请照着界面提示的那一种填`;
    case 'invalid_literal':
      return `${where}只能是 ${JSON.stringify((issue as { expected?: unknown }).expected)}`;
    case 'unrecognized_keys': {
      const keys = (issue as { keys?: string[] }).keys ?? [];
      return `${where}里有界面不认识的项目：${keys.join('、')}（键名拼错时会整份被拒，改对再存）`;
    }
    case 'too_small': {
      const min = (issue as { minimum?: number }).minimum;
      const unit = issue.type === 'array' ? '条' : '个字符';
      return `${where}至少要有 ${min} ${unit}（现在是空的或太短）`;
    }
    case 'too_big': {
      const max = (issue as { maximum?: number }).maximum;
      const unit = issue.type === 'array' ? '条' : '个字符';
      return `${where}最多 ${max} ${unit}，现在超了`;
    }
    case 'invalid_string':
      return `${where}格式不对${(issue as { validation?: string }).validation ? `（要满足 ${(issue as { validation?: string }).validation}）` : ''}`;
    case 'not_multiple_of':
      return `${where}要写成 ${(issue as { multipleOf?: number }).multipleOf} 的整数倍`;
    default:
      /* custom / 别的 code：schema 里的 refine 本来就写了中文句子，原样带出去 */
      return issue.message ? `${where}：${issue.message}` : `${where}填得不对`;
  }
}

/**
 * 一句人话：点名到第一个（最多再带两个）出问题的字段。
 * `fallback` 给「这一整块叫什么」，回执读起来就是「导航栏：第 2 条导航项的 显示文字 至少要有 1 个字符」。
 */
export function zodZh(error: { issues: ZodIssue[] }, fallback = '填写有误'): string {
  const issues = error.issues ?? [];
  if (!issues.length) return fallback;
  const head = describe(issues[0]!);
  const more = issues.slice(1, 3).map((i) => describe(i));
  const tail = issues.length > 3 ? `（另有 ${issues.length - 3} 处同类问题）` : '';
  return more.length ? `${head}；${more.join('；')}${tail}` : `${head}${tail}`;
}
