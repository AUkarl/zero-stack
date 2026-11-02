/**
 * csp-connect.ts — 第三方评论系统的接口域自动进 CSP 的纯函数部分
 *
 * 要解决的问题：站点那份 CSP 的 connect-src 只放了「接口自己的域 + 同父域通配」
 * （见 scripts/site-template/functions/_middleware.ts 与 static/_headers）。
 * 后台把评论区切成 waline / artalk / twikoo 之后，脚本与样式能加载（那几家在
 * script-src / style-src 的 jsdelivr 白名单里），但**它们往自己服务器发的请求会被
 * connect-src 拦掉** —— 症状是评论区一直转圈、控制台一句
 * 「Refused to connect … violates the document's Content Security Policy」，
 * 而页面照常渲染，是最难查的那一类静默失败。
 * 以前这一步写在文档里让人手补（DEPLOYMENT.md 的排查表），这里把它变成保存时就做完。
 *
 * 两份文件都要改，而且必须一起改：
 *   · `static/_headers` 管走 Pages 静态层的那些响应（首页、文章页…）
 *   · `functions/_middleware.ts` 管被开关拦的那几个前缀（/links/、/moments/…）
 * 只改一份的表现就是「文章页评论正常、时刻页空白」这种半好半坏。
 *
 * 谁是账本：**中间件里那对 marker 之间的数组**。它是「我们管过哪些域」的唯一记录，
 * 于是换评论系统时能把上一家从 _headers 里精确摘掉，而**绝不动人手加上去的域**
 * （我们只删自己写进去的那几个 token）。老站那份文件里没有 marker 时，
 * 第一次同步会补上这一段，摘除也就从这一刻起有账可查。
 */

/** 中间件里那段自动维护数组的边界标记 */
export const CSP_MARKER_BEGIN = '// zero-cms:csp-connect:begin';
export const CSP_MARKER_END = '// zero-cms:csp-connect:end';

/** https://x → wss://x（http://x → ws://x）。waline 的实时推送走 WebSocket，
 *  只补 https 会「看着好了、socket 仍被拦」，所以两个协议必须一起进。 */
export function wsTwin(origin: string): string {
  if (origin.startsWith('https://')) return `wss://${origin.slice('https://'.length)}`;
  if (origin.startsWith('http://')) return `ws://${origin.slice('http://'.length)}`;
  return origin;
}

/** 从任意写法的服务地址取出协议+域（带路径、带端口、少写协议都认） */
function originOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** 一家服务商配置里可能被用来写接口地址的几个键。各家文档用词不统一
 *  （waline 是 serverURL、artalk 是 server、twikoo 自托管写 serviceUrl），
 *  所以一次全认，不要求站长改成某一个拼法。 */
const URL_KEYS = ['serverURL', 'serverUrl', 'server', 'serviceUrl', 'endpoint', 'apiUrl', 'apiURL'];

export interface CommentCspResult {
  /** 需要进 connect-src 的源（https://… 形式，wss 由 wsTwin 现推） */
  origins: string[];
  /** 界面上原样给人看的话：认出了什么、什么认不出、什么不需要 */
  notes: string[];
}

/**
 * 按「当前在用的那两家」（文章评论区 + 时刻评论区）算出需要放行的接口域。
 *
 * 只认写明的地址，不替第三方猜托管域名：twikoo 只给 envId/region 时，它的
 * 腾讯云 API 域有好几代写法，猜错就是「补了个没用的域、真正的请求照样被拦」，
 * 所以那种情况直接说清楚该补哪个键。giscus 走自己的 iframe，请求受它那份文档的
 * CSP 管，本站不需要放行任何东西。
 */
export function commentConnectOrigins(input: {
  provider: string;
  momentProvider: string;
  providersJson: string;
}): CommentCspResult {
  const notes: string[] = [];
  const origins: string[] = [];
  let conf: Record<string, Record<string, unknown>> = {};
  try {
    const parsed = JSON.parse(input.providersJson || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) conf = parsed as Record<string, Record<string, unknown>>;
  } catch {
    /* 解析不出来就什么也不补：这份 JSON 在保存时已被 jsonKeyBadValue 拦过一道，
       走到这里只可能是历史脏值，此时最不该做的是拿脏数据改 CSP。 */
    notes.push('「第三方评论参数」不是合法 JSON，这次没动 CSP。');
    return { origins, notes };
  }

  const using = [...new Set([input.provider, input.momentProvider].filter((p) => p && p !== 'zero'))];
  if (!using.length) {
    notes.push('两家评论区都是 Zero 自带，接口同域，不需要往 CSP 里补域。');
    return { origins, notes };
  }

  for (const p of using) {
    const one = conf[p];
    if (!one || typeof one !== 'object' || Array.isArray(one)) {
      notes.push(`「${p}」在参数里没有对应那一段，认不出接口域 —— 补 "${p}":{"serverURL":"https://你的服务域"} 再保存一次。`);
      continue;
    }
    const hit = URL_KEYS.map((k) => [k, originOf(one[k])] as const).find(([, o]) => o);
    if (hit) {
      const o = hit[1] as string;
      if (!origins.includes(o)) origins.push(o);
      notes.push(`「${p}」的接口域 ${o}（取自 ${hit[0]}）已进 CSP，wss://${o.split('//')[1]} 一并补上。`);
      continue;
    }
    if (p === 'giscus') {
      notes.push('giscus 在自己的 iframe 里发请求，受它那份文档的 CSP 管，本站不用补域。');
      continue;
    }
    notes.push(`「${p}」没写接口地址（认 serverURL / server / serviceUrl / endpoint / apiUrl 任一个）—— 这次没补它的域。`);
  }
  return { origins, notes };
}

/** 读出中间件里那份「我们管过的域」；没有 marker 返回 null */
export function readManagedOrigins(middlewareText: string): string[] | null {
  const i = middlewareText.indexOf(CSP_MARKER_BEGIN);
  if (i < 0) return null;
  const j = middlewareText.indexOf(CSP_MARKER_END, i);
  if (j < 0) return null;
  const block = middlewareText.slice(i + CSP_MARKER_BEGIN.length, j);
  const lit = block.match(/const COMMENT_CONNECT:\s*string\[\]\s*=\s*\[([\s\S]*?)\]/);
  if (!lit) return [];
  return [...lit[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]).filter(Boolean);
}

/**
 * 把中间件里那段数组换成新的域清单。
 * 没有 marker 的老站文件：先确认 connect-src 那一行能接上清单，再补 marker 与 wsTwin；
 * 认不出原形状就整个不动（宁可漏补，不可补出「一段没人引用的清单」那种半同步状态）。
 */
export function applyManagedOriginsToMiddleware(
  text: string,
  origins: string[],
): { text: string; changed: boolean; inserted: boolean; reason?: string } {
  const list = `const COMMENT_CONNECT: string[] = [${origins.map((o) => JSON.stringify(o)).join(', ')}];`;
  const begin = text.indexOf(CSP_MARKER_BEGIN);
  if (begin >= 0) {
    const end = text.indexOf(CSP_MARKER_END, begin);
    if (end < 0) return { text, changed: false, inserted: false, reason: '中间件里那对标记只有一半，没敢改这份文件' };
    const before = text.slice(begin, end + CSP_MARKER_END.length);
    const after = `${CSP_MARKER_BEGIN}\n${list}\n${CSP_MARKER_END}`;
    if (before === after) return { text, changed: false, inserted: false };
    return { text: text.replace(before, () => after), changed: true, inserted: false };
  }

  const anchor = text.indexOf('const CSP = [');
  if (anchor < 0) return { text, changed: false, inserted: false, reason: '这份 _middleware.ts 里找不到 CSP 那段，没敢改' };
  /* 顺序很重要：**先确认 connect-src 那一行接得上清单**，再插 marker。
     反过来会留下一段没人引用的 COMMENT_CONNECT，而调用方以为同步成功了 ——
     于是 _headers 有那个域、被开关管的那几页没有，正是这件功能要消灭的半同步。 */
  /* 用 new RegExp + String.raw 写：源码里直接放 /[\r\n]/ 这类字符类，
     经过工具链与 shell 的转义太容易被写成真的换行符（就栽过一次）。 */
  const LINE_RE = new RegExp(String.raw`^[ \t]*` + '\u0060connect-src ' + String.raw`'self'\$\{API_ORIGIN[^\r\n]*$`, 'm');
  const lm = text.match(LINE_RE);
  if (!lm || !lm[0].includes("' https:'}`,")) {
    return { text, changed: false, inserted: false, reason: '这份 _middleware.ts 的 connect-src 那一行被改过，没敢自动补 —— 请按文件里的注释手动加一个域' };
  }
  /* 接的位置很讲究：要插在原行**收尾那个反引号之前**。
     先写成 "`${…}`," 把反引号留在前面，结果是「一个模板字符串 + 紧挨着另一个模板字符串」，
     整份 _middleware.ts 直接语法错 —— 台架判据抓出来的（见 bv-r75-csp.mjs 第 1 组）。 */
  const WIRED_TAIL = "`${COMMENT_CONNECT.map((o) => ` ${o} ${wsTwin(o)}`).join('')}`,";
  const wired = text.replace(LINE_RE, (line) => line.replace(/`,$/, () => WIRED_TAIL.slice(1)));

  const block = [
    '/**',
    ' * 第三方评论系统的接口域 —— zero-cms 自动维护，别手改这一对标记之间的内容。',
    ' * 后台「站点设置 → 评论」存下 waline / artalk / twikoo 的服务地址时，会把域名写在这里，',
    ' * 并补进 static/_headers 的 connect-src（两份必须一致，漏一份的表现是评论只在某几类页面上得起来）。',
    ' * wss:// 跟着同一个域自动生效。',
    ' */',
    CSP_MARKER_BEGIN,
    'const COMMENT_CONNECT: string[] = [];',
    CSP_MARKER_END,
    '',
    '',
  ].join('\n');
  const helper = [
    '/** https://x → wss://x、http://x → ws://x（评论系统的实时推送走 WebSocket，只放 https 会看着好了、socket 仍被拦） */',
    'function wsTwin(origin: string): string {',
    "  if (origin.startsWith('https://')) return `wss://${origin.slice(8)}`;",
    "  if (origin.startsWith('http://')) return `ws://${origin.slice(7)}`;",
    '  return origin;',
    '}',
    '',
    '',
  ].join('\n');

  let next = `${wired.slice(0, anchor)}${block}${wired.slice(anchor)}`;
  if (!/function wsTwin/.test(next)) {
    const at = next.indexOf('const CSP = [');
    next = `${next.slice(0, at)}${helper}${next.slice(at)}`;
  }
  next = next.replace(
    `${CSP_MARKER_BEGIN}\nconst COMMENT_CONNECT: string[] = [];\n${CSP_MARKER_END}`,
    () => `${CSP_MARKER_BEGIN}\n${list}\n${CSP_MARKER_END}`,
  );
  return { text: next, changed: true, inserted: true };
}

/**
 * 改 `static/_headers` 里那一行 CSP 的 connect-src。
 * 只动我们自己写进去的那几个 token（remove = 上一版的域），人手补的域一个不碰。
 */
export function applyConnectOriginsToHeaders(
  text: string,
  add: string[],
  remove: string[],
): { text: string; changed: boolean; reason?: string } {
  const lineRe = /^([ \t]*Content-Security-Policy:)([^\r\n]*)$/m;
  const lm = text.match(lineRe);
  if (!lm) return { text, changed: false, reason: '这份 _headers 里没有 Content-Security-Policy 那一行' };
  const body = lm[2];
  const cm = body.match(/connect-src ([^;]*)/);
  if (!cm) return { text, changed: false, reason: 'CSP 里没有 connect-src 这一项' };
  const drop = new Set(remove.flatMap((o) => [o, wsTwin(o)]));
  const kept = cm[1].trim().split(/\s+/).filter(Boolean).filter((t) => !drop.has(t));
  for (const o of add) for (const t of [o, wsTwin(o)]) if (!kept.includes(t)) kept.push(t);
  const want = `connect-src ${kept.join(' ')}`;
  if (want === cm[0].trimEnd()) return { text, changed: false };
  const newBody = body.replace(/connect-src [^;]*/, () => want);
  const at = lm.index as number;
  return { text: `${text.slice(0, at)}${lm[1]}${newBody}${text.slice(at + lm[0].length)}`, changed: true };
}
