/**
 * 机器辅助翻译（写作工具）：把一段任意语言的原文译成**选定的目标语言**，
 * 结果一律作为草稿返回给后台，由人工确认后才会进仓库。
 * 目标语言由调用方传 target（默认 zh = 简体中文），支持中/英/俄/法/德/西/阿/日/韩。
 *
 * provider 分五类（config 里 translateProvider 写的就是这个 kind 字符串，
 * 必须与 cms 的「设置 - 机器翻译」下拉、翻译页预设表完全对齐）：
 *   none         未启用（默认）
 *   workers-ai   Cloudflare Workers AI，需要在 wrangler 里绑定 AI
 *   chat         OpenAI 兼容大模型：openai / deepseek / qianwen / moonshot / doubao / grok / zhipu
 *                一个 endpoint + model + key 就能用，端点缺省用 PRESET 里的公共地址
 *   public       免 key 的公共翻译：mymemory，配额低，只适合兜底
 *   keyed        免费额度接口：baidu（appid + 密钥）、youdao（应用 ID + 应用密钥）
 *
 * 键：translateProvider / translateEndpoint / translateModel / translateKey
 *     / translateBaiduAppId / translateBaiduKey / translateYoudaoAppKey / translateYoudaoAppSecret。
 * 端点覆盖只对大模型与 Workers AI 生效：免费额度接口固定走官方地址，别把上一家的端点带过去。
 * 提示词要求：按 target 指定的目标语言翻译；保留 Markdown 结构、{{< 短代码 >}}、URL 原样不动；
 * front matter 字段名不译（front matter 正文由调用方处理，不送进来）。
 */

import { getConfig } from './config';
import { md5Hex } from '../lib/md5';
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
  | 'baidu'
  | 'youdao';

type Family = 'none' | 'workers' | 'chat' | 'public' | 'keyed';

interface Preset {
  kind: TranslateProvider;
  family: Family;
  label: string;
  /** chat：完整 /chat/completions 地址；public / keyed：接口地址 */
  endpoint: string;
  model: string;
  needsKey: boolean;
}

/*
 * 免费一档只剩「确实能打通」的：
 *   mymemory  公共接口，无需密钥，配额低（实测本机 200）；
 *   baidu     百度翻译开放平台通用版，免费额度，需要 appid + 密钥；
 *   youdao    有道智云，免费体验额度，需要应用 ID + 应用密钥。
 * 原来的 libretranslate 公共实例（被 Cloudflare 直接 403）与
 * translate.googleapis.com（未公开接口，本机超时）实测不可用，已删。
 */
const PRESETS: Preset[] = [
  { kind: 'none', family: 'none', label: '不使用', endpoint: '', model: '', needsKey: false },
  /* 免密钥 / 免费额度这三家排在最前：没有云端账号也能先把翻译跑通 */
  { kind: 'mymemory', family: 'public', label: 'MyMemory', endpoint: 'https://api.mymemory.translated.net/get', model: '', needsKey: false },
  { kind: 'baidu', family: 'keyed', label: '百度翻译', endpoint: 'https://fanyi-api.baidu.com/api/trans/vip/translate', model: '', needsKey: true },
  { kind: 'youdao', family: 'keyed', label: '有道翻译', endpoint: 'https://openapi.youdao.com/api', model: '', needsKey: true },
  { kind: 'workers-ai', family: 'workers', label: 'Cloudflare Workers AI', endpoint: '', model: '@cf/meta/m2m100-1.2b', needsKey: false },
  { kind: 'openai', family: 'chat', label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', needsKey: true },
  { kind: 'deepseek', family: 'chat', label: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', needsKey: true },
  { kind: 'qianwen', family: 'chat', label: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', needsKey: true },
  { kind: 'moonshot', family: 'chat', label: 'Moonshot Kimi', endpoint: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k', needsKey: true },
  { kind: 'doubao', family: 'chat', label: '豆包', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', model: 'doubao-pro-32k', needsKey: true },
  { kind: 'grok', family: 'chat', label: 'Grok (xAI)', endpoint: 'https://api.x.ai/v1/chat/completions', model: 'grok-2-latest', needsKey: true },
  { kind: 'zhipu', family: 'chat', label: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4-flash', needsKey: true },
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
/** 可选目标语言：code 是接口参数与目录名，locale 给 provider 用 */
export type TranslateTarget = 'zh' | 'en' | 'ru' | 'fr' | 'de' | 'es' | 'ar' | 'ja' | 'ko';

export const TRANSLATE_TARGETS: { code: TranslateTarget; label: string; locale: string }[] = [
  { code: 'zh', label: '简体中文', locale: 'zh-CN' },
  { code: 'en', label: '英语', locale: 'en-US' },
  { code: 'ru', label: '俄语', locale: 'ru-RU' },
  { code: 'fr', label: '法语', locale: 'fr-FR' },
  { code: 'de', label: '德语', locale: 'de-DE' },
  { code: 'es', label: '西班牙语', locale: 'es-ES' },
  { code: 'ar', label: '阿拉伯语', locale: 'ar-SA' },
  { code: 'ja', label: '日语', locale: 'ja-JP' },
  { code: 'ko', label: '韩语', locale: 'ko-KR' },
];

export function isTranslateTarget(v: unknown): v is TranslateTarget {
  return TRANSLATE_TARGETS.some((t) => t.code === v);
}

export function targetLocale(target?: string): string {
  return (TRANSLATE_TARGETS.find((t) => t.code === target) ?? TRANSLATE_TARGETS[0]).locale;
}

export function targetLabel(target?: string): string {
  return (TRANSLATE_TARGETS.find((t) => t.code === target) ?? TRANSLATE_TARGETS[0]).label;
}

/** 给大模型的系统提示：目标语言随参数变，其他规则不变 */
function systemPrompt(target?: string): string {
  const name = targetLabel(target);
  return (
    `你是网站内容翻译助手。把原文翻译为${name}，只输出译文本身，不要解释、不要加引号或代码块围栏。原文可能是任意语言，也可能已经是${name}（已经是的保持通顺即可，不要硬译）。` +
    '务必保留：Markdown 结构（标题 #、列表、表格、加粗、行内代码、引用块）不变；' +
    'Hugo 短代码 {{< ... >}} 与 {{% ... %}} 原样保留、内部参数不翻译；' +
    '所有 URL、图片地址、锚点、邮箱原样不动；' +
    'front matter 字段名（title、date 等）即使出现在文本里也不翻译；front matter 不在输入里，不要凭空生成。' +
    '译文要自然通顺，术语一致。'
  );
}

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
      hint: '未配置翻译服务：到「设置 → 机器翻译」选一个。免费无密钥只有 MyMemory（配额低）；百度 / 有道有免费额度，要填 appid 与密钥；大模型（deepseek / qianwen / moonshot / doubao / grok / zhipu / openai）需填密钥。',
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

  if (preset.family === 'keyed') {
    const ok =
      preset.kind === 'baidu'
        ? Boolean((await getConfig(env, 'translateBaiduAppId')) && (await getConfig(env, 'translateBaiduKey')))
        : Boolean((await getConfig(env, 'translateYoudaoAppKey')) && (await getConfig(env, 'translateYoudaoAppSecret')));
    return { ...base, model: '', ready: ok, hint: ok ? '' : `还没填${preset.kind === 'baidu' ? ' appid / 密钥' : '应用 ID / 应用密钥'}（设置 → 机器翻译）` };
  }

  // public：无需密钥，默认配额低
  return { ...base, model: cfgModel || '', ready: true, hint: '' };
}

/** 单段翻译（目标语言由调用方给，默认简体中文）；失败不抛异常，把原因带回去给后台显示；网络类错误自动重试一次 */
export async function translateText(env: Env, input: { text: string; source?: string; target?: string }): Promise<TranslateOutcome> {
  const text = input.text.replace(/\r\n/g, '\n').trim();
  const status = await translateStatus(env);
  const { provider, model } = status;
  if (!text) return { ok: false, text: '', provider, model, error: '没有要翻译的内容' };
  if (!status.ready) return { ok: false, text: '', provider, model, error: status.hint || '未配置翻译服务' };

  const source = input.source;
  const target = isTranslateTarget(input.target) ? input.target : 'zh';

  const parts = text.length <= CHUNK_LIMIT ? [text] : chunk(text);
  const out: string[] = [];
  let retries = 0;
  let usage = '';

  for (const part of parts) {
    let res = await runOnce(env, provider, model, part, source, target);
    if (!res.ok && isTransient(res.error)) {
      retries++;
      res = await runOnce(env, provider, model, part, source, target);
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
  target?: string,
): Promise<TranslateOutcome> {
  const preset = PRESET_MAP.get(provider);
  const family = preset?.family ?? 'none';

  if (family === 'workers') return workersAiRun(env, model, text, source, target);
  if (family === 'chat') return chatCompletions(env, preset!, model, text, source, target);
  if (family === 'public') return mymemoryTranslate(env, preset!, text, source, target);
  if (family === 'keyed') return preset!.kind === 'baidu' ? baiduTranslate(env, preset!, text, source, target) : youdaoTranslate(env, preset!, text, source, target);

  return { ok: false, text: '', provider, model, error: '未配置翻译服务' };
}

/* ------------------------------------------------------------------ Workers AI */

async function workersAiRun(env: Env, model: string, text: string, source?: string, target?: string): Promise<TranslateOutcome> {
  const provider: TranslateProvider = 'workers-ai';
  try {
    const res = (await env.AI!.run(model || '@cf/meta/m2m100-1.2b', {
      text,
      source_lang: source ? langCode(source) : langCode(detectSourceLocale(text)),
      target_lang: langCode(targetLocale(target)),
    })) as { translated_text?: string };
    const translated = String(res.translated_text ?? '');
    if (!translated) return { ok: false, text: '', provider, model, error: '翻译服务返回空' };
    return { ok: true, text: translated, provider, model, usage: `chars=${text.length}` };
  } catch (e) {
    return { ok: false, text: '', provider, model, error: describeFetchError(e) };
  }
}

/* ------------------------------------------------------------------ OpenAI 兼容大模型 */

async function chatCompletions(
  env: Env,
  preset: Preset,
  model: string,
  text: string,
  source?: string,
  target?: string,
): Promise<TranslateOutcome> {
  const provider = preset.kind;
  const cfgEndpoint = ((await getConfig(env, 'translateEndpoint')) ?? '').trim();
  const url = chatUrl(cfgEndpoint || preset.endpoint);
  const key = (await getConfig(env, 'translateKey')) ?? env.TRANSLATE_API_KEY ?? '';

  const langHint = `源语言：${source ? langCode(source) : '自动判断（可为任意语言）'}；目标语言：${langCode(targetLocale(target))}（${targetLabel(target)}）。`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: `${systemPrompt(target)}${langHint}` },
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

/* ------------------------------------------------------------------ 免费 / 免费额度接口 */

/** 免费接口用的语言码：各家的叫法不一样，统一在这里翻译一次 */
function freeLang(kind: TranslateProvider, locale: string): string {
  const s = String(locale ?? '').trim();
  const base = /^zh/i.test(s) ? (kind === 'youdao' ? 'zh-CHS' : 'zh') : langCode(s);
  if (kind === 'baidu') {
    const map: Record<string, string> = { zh: 'zh', en: 'en', ru: 'ru', fr: 'fra', de: 'de', es: 'spa', ar: 'ara', ja: 'jp', ko: 'kor' };
    return map[base] ?? base;
  }
  if (kind === 'youdao') {
    const map: Record<string, string> = { zh: 'zh-CHS', en: 'en', ru: 'ru', fr: 'fr', de: 'de', es: 'es', ar: 'ar', ja: 'ja', ko: 'ko' };
    return map[base] ?? base;
  }
  /* mymemory：中文区分 zh-CN / zh-TW */
  if (/^zh/i.test(s)) return /tw|hk|mo/i.test(s) ? 'zh-TW' : 'zh-CN';
  return base;
}

function detectSourceLocale(text: string): string {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text) ? 'zh-CN' : 'en';
}

/** MyMemory：公共接口，无需密钥；只认显式语种对，源语言靠启发式猜 */
async function mymemoryTranslate(env: Env, preset: Preset, text: string, source?: string, target?: string): Promise<TranslateOutcome> {
  const provider = preset.kind;
  const model = '';
  /* 免密钥 / 免费额度这几家一律用官方地址：translateEndpoint 是给大模型与 Workers AI 用的，
     留着上一次的服务地址（比如 Mock 的 /v1/chat/completions）会把免费接口也带错门。 */
  const endpoint = preset.endpoint;
  const tgt = freeLang(provider, targetLocale(target));
  const src = freeLang(provider, source || detectSourceLocale(text));
  if (src === tgt) {
    return { ok: true, text, provider, model, usage: `chars=${text.length}; 原文已是${targetLabel(target)}，原样保留（免费接口不做同语种对译）` };
  }
  const url = `${endpoint}?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(`${src}|${tgt}`)}&rf=2`;
  const res = await fetchWithTimeout(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return { ok: false, text: '', provider, model, error: await describeHttpError(res, provider) };
  const body = (await res.json()) as { responseData?: { translatedText?: string }; responseStatus?: number | string };
  const translated = String(body.responseData?.translatedText ?? '').trim();
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID|NO LENGTH/i.test(translated)) {
    return { ok: false, text: '', provider, model, error: `MyMemory 免费配额已用尽或段落过长：${translated.slice(0, 120)}` };
  }
  if (!translated) return { ok: false, text: '', provider, model, error: 'MyMemory 返回空译文，可能触发每日配额限制' };
  return { ok: true, text: translated, provider, model, usage: `chars=${text.length}; status=${body.responseStatus ?? 'ok'}` };
}

/** 百度翻译开放平台：md5(appid + q + salt + 密钥) 签名；错误码翻成人话 */
async function baiduTranslate(env: Env, preset: Preset, text: string, source?: string, target?: string): Promise<TranslateOutcome> {
  const provider = preset.kind;
  const model = '';
  /* 百度固定走官方接口；translateEndpoint 属于大模型那一档，不能串到免费额度接口上 */
  const endpoint = preset.endpoint;
  const appid = ((await getConfig(env, 'translateBaiduAppId')) ?? '').trim();
  const key = ((await getConfig(env, 'translateBaiduKey')) ?? '').trim();
  if (!appid || !key) return { ok: false, text: '', provider, model, error: '百度翻译还没填 appid / 密钥（设置 → 机器翻译）' };
  const from = source ? freeLang(provider, source) : 'auto';
  const to = freeLang(provider, targetLocale(target));
  const salt = String(Date.now());
  const sign = md5Hex(`${appid}${text}${salt}${key}`);
  const url = `${endpoint}?q=${encodeURIComponent(text)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&appid=${encodeURIComponent(appid)}&salt=${salt}&sign=${sign}`;
  const res = await fetchWithTimeout(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return { ok: false, text: '', provider, model, error: await describeHttpError(res, provider) };
  const body = (await res.json()) as { trans_result?: { dst?: string }[]; error_code?: string | number; error_msg?: string };
  const code = String(body.error_code ?? '0');
  if (code !== '0') {
    const why: Record<string, string> = {
      '52001': '请求超时',
      '52002': '系统错误',
      '52003': '未授权用户：appid 不对或没开通通用翻译',
      '54000': '必填参数为空',
      '54001': '签名错误：appid 与密钥不匹配',
      '54003': '访问频率受限',
      '54004': '账户余额不足（免费额度用完）',
      '54005': '长文本请求频繁',
      '58000': '客户端 IP 非法（百度后台没放行当前出口 IP）',
      '58001': '译文语言方向不支持',
      '58002': '服务当前已关闭（百度后台）',
      '90107': '认证未通过或未生效',
    };
    return { ok: false, text: '', provider, model, error: `百度翻译 ${code}：${why[code] ?? body.error_msg ?? '未知错误'}` };
  }
  const translated = (body.trans_result ?? []).map((r) => String(r.dst ?? '')).join('').trim();
  if (!translated) return { ok: false, text: '', provider, model, error: '百度翻译返回空译文' };
  return { ok: true, text: translated, provider, model, usage: `chars=${text.length}` };
}

/** 有道智云：v3 签名 sha256(appKey + input + salt + curtime + appSecret) */
async function youdaoTranslate(env: Env, preset: Preset, text: string, source?: string, target?: string): Promise<TranslateOutcome> {
  const provider = preset.kind;
  const model = '';
  /* 有道固定走官方接口；translateEndpoint 属于大模型那一档，不能串到免费额度接口上 */
  const endpoint = preset.endpoint;
  const appKey = ((await getConfig(env, 'translateYoudaoAppKey')) ?? '').trim();
  const appSecret = ((await getConfig(env, 'translateYoudaoAppSecret')) ?? '').trim();
  if (!appKey || !appSecret) return { ok: false, text: '', provider, model, error: '有道翻译还没填应用 ID / 应用密钥（设置 → 机器翻译）' };
  const from = source ? freeLang(provider, source) : 'auto';
  const to = freeLang(provider, targetLocale(target));
  const salt = crypto.randomUUID();
  const curtime = String(Math.floor(Date.now() / 1000));
  /* 有道规定：输入超过 20 字时按「前10 + 长度 + 后10」参与签名 */
  const input = text.length <= 20 ? text : `${text.slice(0, 10)}${text.length}${text.slice(-10)}`;
  const sign = await sha256Hex(`${appKey}${input}${salt}${curtime}${appSecret}`);
  const form = new URLSearchParams({ q: text, from, to, appKey, salt, sign, signType: 'v3', curtime });
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { ok: false, text: '', provider, model, error: await describeHttpError(res, provider) };
  const body = (await res.json()) as { errorCode?: string | number; translation?: string[] };
  const code = String(body.errorCode ?? '0');
  if (code !== '0') {
    const why: Record<string, string> = {
      '101': '缺少必填参数',
      '102': '不支持的语言',
      '103': '翻译文本过长',
      '108': '应用 ID 无效',
      '110': '无相关服务的有效实例（有道后台没开通）',
      '111': '开发者账号无效',
      '112': '请求服务无效',
      '113': 'q 不能为空',
      '202': '签名检验失败',
      '203': '访问 IP 不在可访问的 IP 列表中',
      '206': '时间戳无效（检查系统时间）',
      '301': '辞典翻译不可用',
      '302': '翻译查询失败',
      '303': '服务出错',
      '411': '访问频率受限',
    };
    return { ok: false, text: '', provider, model, error: `有道翻译 ${code}：${why[code] ?? '未知错误'}` };
  }
  const translated = (body.translation ?? []).join('').trim();
  if (!translated) return { ok: false, text: '', provider, model, error: '有道翻译返回空译文' };
  return { ok: true, text: translated, provider, model, usage: `chars=${text.length}` };
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
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

