/**
 * 机器辅助翻译（写作工具）：站点是纯中文站，这里只负责「把一段任意语言的原文译成简体中文」，
 * 结果一律作为草稿返回给后台，由人工确认后才会进仓库。
 * 没有「目标语言」概念：所有 provider 内部固定目标为简体中文。
 *
 * provider 分四类（config 里 translateProvider 写的就是这个 kind 字符串，
 * 必须与 cms 的「设置 - 机器翻译」下拉、翻译页预设表完全对齐）：
 *   none         未启用（默认）
 *   workers-ai   Cloudflare Workers AI，需要在 wrangler 里绑定 AI
 *   chat         OpenAI 兼容大模型：openai / deepseek / qianwen / moonshot / doubao / grok / zhipu
 *                一个 endpoint + model + key 就能用，端点缺省用 PRESET 里的公共地址
 *   free         免 key 的公共翻译：mymemory / libretranslate / google，配额低，只适合兜底
 *
 * 键：translateProvider / translateEndpoint / translateModel / translateKey。
 * 提示词要求：把原文翻译为简体中文；保留 Markdown 结构、{{< 短代码 >}}、URL 原样不动；
 * front matter 字段名不译（front matter 正文由调用方处理，不送进来）。
 */

import { getConfig } from './config';
import { fetchWithTimeout } from '../lib/fetch';

/** 后端认识的全部 provider kind（与 cms 下拉字符串一一对应） */
export type TranslateProvider =
  | 'none'
  | 'workers-ai'
  | 'openai'
  | 'deepseek'
  | 'qianwen'
  | 'moonshot'
  | 'doubao'
  | 'grok'
  | 'zhipu'
  | 'mymemory'
  | 'libretranslate'
  | 'google';

type Family = 'none' | 'workers' | 'chat' | 'free';

interface Preset {
  kind: TranslateProvider;
  family: Family;
  label: string;
  /** chat：完整 /chat/completions 地址；free：接口地址 */
  endpoint: string;
  model: string;
  needsKey: boolean;
}

const PRESETS: Preset[] = [
  { kind: 'none', family: 'none', label: '不使用', endpoint: '', model: '', needsKey: false },
  { kind: 'workers-ai', family: 'workers', label: 'Cloudflare Workers AI', endpoint: '', model: '@cf/meta/m2m100-1.2b', needsKey: false },
  { kind: 'openai', family: 'chat', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', needsKey: true },
  { kind: 'deepseek', family: 'chat', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', needsKey: true },
  { kind: 'qianwen', family: 'chat', label: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', needsKey: true },
  { kind: 'moonshot', family: 'chat', label: 'Moonshot Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', needsKey: true },
  { kind: 'doubao', family: 'chat', label: '豆包', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'doubao-pro-32k', needsKey: true },
  { kind: 'grok', family: 'chat', label: 'Grok (xAI)', endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-2-latest', needsKey: true },
  { kind: 'zhipu', family: 'chat', label: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', needsKey: true },
  { kind: 'mymemory', family: 'free', label: 'MyMemory（免费）', endpoint: 'https://api.mymemory.translated.net/get', model: '', needsKey: false },
  { kind: 'libretranslate', family: 'free', label: 'LibreTranslate（免费）', endpoint: 'https://translate.libretranslate.com/translate', model: '', needsKey: false },
  { kind: 'google', family: 'free', label: 'Google 翻译（免费）', endpoint: 'https://translate.googleapis.com/translate_a/single', model: '', needsKey: false },
];

const PRESET_MAP = new Map<string, Preset>(PRESETS.map((p) => [p.kind, p]));

/** 给状态接口/前端用的可选清单：kind + 是否需要 key + 类别 */
export interface ProviderInfo {
  kind: TranslateProvider;
  label: string;
  needsKey: boolean;
  family: Family;
}

export function providerCatalog(): ProviderInfo[] {
  return PRESETS.map((p) => ({ kind: p.kind, label: p.label, needsKey: p.needsKey, family: p.family }));
}

export interface TranslateOutcome {
  ok: boolean;
  text: string;
  provider: TranslateProvider;
  model: string;
  error?: string;
  /** 实际用量，便于排查免费配额（chat: tokens=… / free: chars=…） */
  usage?: string;
  /** 本次内部切成的分片数 */
  segments?: number;
  /** 本次因网络/超时/限流重试的次数 */
  retries?: number;
}

/** m2m100 只吃短句，OpenAI 兼容接口也按段落分批更稳 */
const CHUNK_LIMIT = 1200;

/** 站点是纯中文站：唯一译文目标，内部固定，不再作为参数暴露 */
const ZH_TARGET = 'zh-CN';

const LANG_CODES: Record<string, string> = {
  'zh-CN': 'zh',
  'zh-TW': 'zh',
  'en-US': 'en',
  'en-GB': 'en',
  ja: 'ja',
  'ja-JP': 'ja',
  fr: 'fr',
  es: 'es',
  de: 'de',
  ru: 'ru',
  ko: 'ko',
};

export function langCode(locale: string): string {
  return LANG_CODES[locale] ?? locale.split(/[-_]/)[0]!.toLowerCase();
}

export interface TranslateStatus {
  provider: TranslateProvider;
  model: string;
  ready: boolean;
  hint: string;
  family: Family;
  needsKey: boolean;
}

export async function translateStatus(env: Env): Promise<TranslateStatus> {
  const raw = ((await getConfig(env, 'translateProvider')) ?? 'none').trim();
  const cfgModel = ((await getConfig(env, 'translateModel')) ?? '').trim();
  const preset = PRESET_MAP.get(raw);

  if (!preset) {
    return { provider: 'none', model: cfgModel, ready: false, hint: `未知的翻译服务 ${raw}`, family: 'none', needsKey: false };
  }

  const base = { provider: preset.kind, family: preset.family, needsKey: preset.needsKey };

  if (preset.family === 'none') {
    return {
      ...base,
      model: '',
      ready: false,
      hint: '未配置翻译服务：请到「设置 - 机器翻译」或翻译页选择 provider（所有译文固定为简体中文）。免费无密钥可选 mymemory / libretranslate / google（配额低）；大模型（deepseek / qianwen / moonshot / doubao / grok / zhipu / openai）需填密钥。',
    };
  }

  if (preset.family === 'workers') {
    return env.AI
      ? { ...base, model: cfgModel || preset.model, ready: true, hint: '' }
      : { ...base, model: cfgModel || preset.model, ready: false, hint: 'Worker 未绑定 AI（wrangler.jsonc 里加 "ai": { "binding": "AI" }）' };
  }

  if (preset.family === 'chat') {
    const key = (await getConfig(env, 'translateKey')) ?? env.TRANSLATE_API_KEY;
    const model = cfgModel || preset.model;
    if (!key) return { ...base, model, ready: false, hint: `未填写翻译密钥（${preset.label} 需要 API Key）` };
    if (!model) return { ...base, model, ready: false, hint: '未填写模型名' };
    return { ...base, model, ready: true, hint: '' };
  }

  // free：无需密钥，默认配额低
  return { ...base, model: cfgModel || '', ready: true, hint: '' };
}

/** 单段翻译（固定译为简体中文）；失败不抛异常，把原因带回去给后台显示；网络类错误自动重试一次 */
export async function translateText(env: Env, input: { text: string; source?: string }): Promise<TranslateOutcome> {
  const text = input.text.replace(/\r\n/g, '\n').trim();
  const status = await translateStatus(env);
  const { provider, model } = status;
  if (!text) return { ok: false, text: '', provider, model, error: '没有要翻译的内容' };
  if (!status.ready) return { ok: false, text: '', provider, model, error: status.hint || '未配置翻译服务' };

  const source = input.source;

  const parts = text.length <= CHUNK_LIMIT ? [text] : chunk(text);
  const out: string[] = [];
  let retries = 0;
  let usage = '';

  for (const part of parts) {
    let res = await runOnce(env, provider, model, part, source);
    if (!res.ok && isTransient(res.error)) {
      retries++;
      res = await runOnce(env, provider, model, part, source);
    }
    if (!res.ok) return { ...res, retries, segments: parts.length };
    out.push(res.text);
    if (res.usage) usage = res.usage;
  }

  return { ok: true, text: out.join('\n\n'), provider, model, usage, segments: parts.length, retries };
}

function isTransient(err?: string): boolean {
  if (!err) return false;
  return /超时|timeout|abort|network|fetch failed|ECONN|ETIMEDOUT|502|503|504|Too Many|429/i.test(err);
}

async function runOnce(
  env: Env,
  provider: TranslateProvider,
  model: string,
  text: string,
  source?: string,
): Promise<TranslateOutcome> {
  const preset = PRESET_MAP.get(provider);
  const family = preset?.family ?? 'none';

  if (family === 'workers') return workersAiRun(env, model, text, source);
  if (family === 'chat') return chatCompletions(env, preset!, model, text, source);
  if (family === 'free') return freeTranslate(env, preset!, text, source);

  return { ok: false, text: '', provider, model, error: '未配置翻译服务' };
}

/* ------------------------------------------------------------------ Workers AI */

async function workersAiRun(env: Env, model: string, text: string, source?: string): Promise<TranslateOutcome> {
  const provider: TranslateProvider = 'workers-ai';
  try {
    const res = (await env.AI!.run(model || '@cf/meta/m2m100-1.2b', {
      text,
      source_lang: source ? langCode(source) : langCode(detectSourceLocale(text)),
      target_lang: langCode(ZH_TARGET),
    })) as { translated_text?: string };
    const translated = String(res.translated_text ?? '');
    if (!translated) return { ok: false, text: '', provider, model, error: '翻译服务返回空' };
    return { ok: true, text: translated, provider, model, usage: `chars=${text.length}` };
  } catch (e) {
    return { ok: false, text: '', provider, model, error: describeFetchError(e) };
  }
}

/* ------------------------------------------------------------------ OpenAI 兼容大模型 */

const SYSTEM_PROMPT =
  '你是网站内容翻译助手。把原文翻译为简体中文，只输出译文本身，不要解释、不要加引号或代码块围栏。原文可能是任意语言，也可能已经是中文（中文部分保持通顺即可，不要硬译）。' +
  '务必保留：Markdown 结构（标题 #、列表、表格、加粗、行内代码、引用块）不变；' +
  'Hugo 短代码 {{< ... >}} 与 {{% ... %}} 原样保留、内部参数不翻译；' +
  '所有 URL、图片地址、锚点、邮箱原样不动；' +
  'front matter 字段名（title、date 等）即使出现在文本里也不翻译；front matter 不在输入里，不要凭空生成。' +
  '译文要自然通顺，术语一致。';

async function chatCompletions(
  env: Env,
  preset: Preset,
  model: string,
  text: string,
  source?: string,
): Promise<TranslateOutcome> {
  const provider = preset.kind;
  const cfgEndpoint = ((await getConfig(env, 'translateEndpoint')) ?? '').trim();
  const url = chatUrl(cfgEndpoint || preset.endpoint);
  const key = (await getConfig(env, 'translateKey')) ?? env.TRANSLATE_API_KEY ?? '';

  const langHint = `源语言：${source ? langCode(source) : '自动判断（可为任意语言）'}；目标语言：zh-CN（简体中文），固定不变。`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: `${SYSTEM_PROMPT}${langHint}` },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, text: '', provider, model, error: await describeHttpError(res, provider) };
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const translated = (body.choices?.[0]?.message?.content ?? '').trim();
    if (!translated) return { ok: false, text: '', provider, model, error: '翻译服务返回空' };
    const tokens = body.usage?.total_tokens;
    return { ok: true, text: translated, provider, model, usage: tokens ? `tokens=${tokens}` : `chars=${text.length}` };
  } catch (e) {
    return { ok: false, text: '', provider, model, error: describeFetchError(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 端点既能填基础地址（…/v1）也能填完整地址（…/chat/completions） */
function chatUrl(endpoint: string): string {
  const base = (endpoint || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

/* ------------------------------------------------------------------ 免费公共接口 */

async function freeTranslate(env: Env, preset: Preset, text: string, source?: string): Promise<TranslateOutcome> {
  const provider = preset.kind;
  const model = '';
  const cfgEndpoint = ((await getConfig(env, 'translateEndpoint')) ?? '').trim();
  const endpoint = cfgEndpoint || preset.endpoint;
  // 站点纯中文：目标语言永远是简体中文
  const tgt = freeCode(provider, ZH_TARGET);
  // 原文可为任意语言：google / libretranslate 支持服务端自动识别就用 auto；mymemory 只认显式语种，靠启发式猜源语言
  const src = source
    ? freeCode(provider, source)
    : provider === 'mymemory'
      ? freeCode(provider, detectSourceLocale(text))
      : 'auto';

  // 纯中文站的边角情形：源语言已明确判定为简体中文（如 mymemory 启发式 zh-CN→zh-CN），
  // 免费接口拒绝同语种对（MyMemory 直接回 PLEASE SELECT TWO DISTINCT LANGUAGES）。
  // 此时「译成中文」的诚实结果就是原文本身，显式说明后原样返回，不冒充翻译失败。
  if (src !== 'auto' && src === tgt) {
    return { ok: true, text, provider, model, usage: `chars=${text.length}; 原文已是简体中文，原样保留（免费接口不做同语种对译）` };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    if (provider === 'mymemory') {
      const url = `${endpoint}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(`${src}|${tgt}`)}&rf=2`;
      const res = await fetchWithTimeout(url, { signal: controller.signal });
      if (!res.ok) return { ok: false, text: '', provider, model, error: await describeHttpError(res, provider) };
      const body = (await res.json()) as {
        responseData?: { translatedText?: string };
        responseStatus?: number | string;
        responseDetails?: string;
      };
      const translated = String(body.responseData?.translatedText ?? '').trim();
      if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID|NO LENGTH/i.test(translated)) {
        return { ok: false, text: '', provider, model, error: `MyMemory 免费配额已用尽或段落过长：${translated.slice(0, 120)}` };
      }
      if (!translated) return { ok: false, text: '', provider, model, error: 'MyMemory 返回空译文，可能触发每日配额限制' };
      return { ok: true, text: translated, provider, model, usage: `chars=${text.length}; status=${body.responseStatus ?? 'ok'}` };
    }

    if (provider === 'libretranslate') {
      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, src, tgt, format: 'text' }),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, text: '', provider, model, error: await describeHttpError(res, provider) };
      const body = (await res.json()) as { translatedText?: string; error?: string };
      if (body.error) return { ok: false, text: '', provider, model, error: `LibreTranslate 报错：${String(body.error).slice(0, 160)}` };
      const translated = String(body.translatedText ?? '').trim();
      if (!translated) return { ok: false, text: '', provider, model, error: 'LibreTranslate 返回空译文（公共实例常限流）' };
      return { ok: true, text: translated, provider, model, usage: `chars=${text.length}` };
    }

    // google
    const url = `${endpoint}?client=gtx&sl=${encodeURIComponent(src)}&st=1&dt=t&tl=${encodeURIComponent(tgt)}&q=${encodeURIComponent(text)}`;
    const res = await fetchWithTimeout(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, text: '', provider, model, error: await describeHttpError(res, provider) };
    const data = (await res.json()) as unknown;
    const translated = flattenGoogle(data);
    if (!translated) return { ok: false, text: '', provider, model, error: 'Google 翻译返回空，接口不稳定或被限流' };
    return { ok: true, text: translated, provider, model, usage: `chars=${text.length}` };
  } catch (e) {
    return { ok: false, text: '', provider, model, error: describeFetchError(e) };
  } finally {
    clearTimeout(timer);
  }
}

function flattenGoogle(data: unknown): string {
  if (!Array.isArray(data)) return '';
  const segs = data[0];
  if (!Array.isArray(segs)) return '';
  return segs
    .map((s) => (Array.isArray(s) ? String(s[0] ?? '') : ''))
    .join('')
    .trim();
}

/** 免费接口用带地区的语言码：中文区分 zh-CN / zh-TW，其它走短码 */
function freeCode(kind: TranslateProvider, locale: string): string {
  const s = String(locale ?? '').trim();
  if (!s) return 'en';
  if (kind === 'libretranslate') return /^zh/i.test(s) ? 'zh' : langCode(s);
  if (/^zh/i.test(s)) return /tw|hk|mo/i.test(s) ? 'zh-TW' : 'zh-CN';
  return langCode(s);
}

function detectSourceLocale(text: string): string {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text) ? 'zh-CN' : 'en';
}

/* ------------------------------------------------------------------ 错误文案（明确中文，绝不静默返回原文） */

async function describeHttpError(res: Response, provider: TranslateProvider): Promise<string> {
  const label = PRESET_MAP.get(provider)?.label ?? provider;
  const snippet = (await res.text().catch(() => '')).slice(0, 180);
  if (res.status === 401 || res.status === 403) return `${label}：密钥无效或没有权限（HTTP ${res.status}），请检查「翻译密钥」配置`;
  if (res.status === 429) return `${label}：触发频率/配额限制（HTTP 429），稍后再试或换 provider`;
  if (/quota|exceeded|insufficient|credit|balance/i.test(snippet)) return `${label}：额度或配额不足（HTTP ${res.status}）：${snippet}`;
  return `${label}：HTTP ${res.status}：${snippet || '无返回内容'}`;
}

function describeFetchError(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : String(e);
  if (name === 'AbortError') return '翻译服务响应超时（20~30 秒），请稍后重试';
  if (/fetch failed|ECONN|network|ENOTFOUND|EAI_AGAIN/i.test(msg)) return `无法连接翻译服务（可能是本机无外网或被拦截）：${msg}`;
  return msg;
}

/* ------------------------------------------------------------------ 分片（沿用原逻辑） */

/** 按空行切段，单段超长再按句切，保证不切断 Markdown 结构 */
function chunk(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const out: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).length > CHUNK_LIMIT && buf) {
      out.push(buf);
      buf = '';
    }
    buf = buf ? `${buf}\n\n${p}` : p;
    while (buf.length > CHUNK_LIMIT * 2) {
      const cut = sliceSentence(buf, CHUNK_LIMIT);
      out.push(buf.slice(0, cut));
      buf = buf.slice(cut);
    }
  }
  if (buf) out.push(buf);
  return out;
}

function sliceSentence(s: string, limit: number): number {
  const window = s.slice(0, limit * 1.5);
  const at = Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('\n'), window.lastIndexOf('. '));
  return at > limit * 0.5 ? at + 1 : limit;
}

