/**
 * 机器辅助翻译（写作工具）：把一段任意语言的原文译成**选定的目标语言**，
 * 结果一律作为草稿返回给后台，由人工确认后才会进仓库。
 *
 * 服务商只剩两类：
 *   mymemory  免密钥公共接口，配额低，只适合兜底；
 *   ai        复用「设置 → AI 模型配置」里的服务商/端点/模型/密钥，翻译与评论审核、AI 回复共用同一份配置。
 *
 * 键：translateProvider（none / mymemory / ai）。
 * 目标语言由调用方传 target（默认 zh = 简体中文），支持中/英/俄/法/德/西/阿/日/韩。
 * 提示词要求：按 target 指定的目标语言翻译；保留 Markdown 结构、{{< 短代码 >}}、URL 原样不动；
 * front matter 字段名不译（front matter 正文由调用方处理，不送进来）。
 */

import { getConfig } from './config';
import { fetchWithTimeout } from '../lib/fetch';
import { aiChat, aiConfig, aiStatus } from './ai';

/** 后端认识的全部 provider kind（与 cms 翻译页下拉一一对应） */
export type TranslateProvider = 'none' | 'mymemory' | 'ai';

type Family = 'none' | 'public' | 'ai';

interface Preset {
  kind: TranslateProvider;
  family: Family;
  label: string;
  endpoint: string;
  model: string;
  needsKey: boolean;
}

const PRESETS: Preset[] = [
  { kind: 'none', family: 'none', label: '不使用', endpoint: '', model: '', needsKey: false },
  { kind: 'mymemory', family: 'public', label: 'MyMemory（免费公共接口）', endpoint: 'https://api.mymemory.translated.net/get', model: '', needsKey: false },
  { kind: 'ai', family: 'ai', label: '使用 AI 模型配置', endpoint: '', model: '', needsKey: false },
];

const PRESET_MAP = new Map<string, Preset>(PRESETS.map((p) => [p.kind, p]));

/** 旧版单独的翻译服务（openai/deepseek/baidu/…）一律视为 ai：密钥统一到 AI 模型配置 */
function normalizeProvider(raw: string): TranslateProvider {
  if (raw === 'mymemory') return 'mymemory';
  if (raw === 'none' || !raw) return 'none';
  return 'ai';
}

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
  /** 实际用量，便于排查免费配额（ai: chars=… / free: chars=…） */
  usage?: string;
  /** 本次内部切成的分片数 */
  segments?: number;
  /** 本次因网络/超时/限流重试的次数 */
  retries?: number;
}

/** 长文按段落分批更稳，避免单次请求被截断或超时 */
const CHUNK_LIMIT = 1200;

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
  const kind = normalizeProvider(raw);
  const preset = PRESET_MAP.get(kind) ?? PRESET_MAP.get('none')!;
  const base = { provider: preset.kind, family: preset.family, needsKey: preset.needsKey };

  if (preset.family === 'none') {
    return {
      ...base,
      model: '',
      ready: false,
      hint: '未配置翻译服务：到「翻译」页选 MyMemory（免费公共接口，配额低），或选「使用 AI 模型配置」并先在「设置 → AI 模型配置」填好服务商与密钥。',
    };
  }

  if (preset.family === 'public') {
    return { ...base, model: '', ready: true, hint: '' };
  }

  const ai = await aiStatus(env);
  return {
    ...base,
    model: ai.model,
    ready: ai.ready,
    hint: ai.ready ? '' : `翻译使用 AI 模型：${ai.hint || '还没配置'}（设置 → AI 模型配置）`,
  };
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
  if (provider === 'mymemory') return mymemoryTranslate(text, source, target);
  if (provider === 'ai') return aiTranslate(env, model, text, source, target);
  return { ok: false, text: '', provider, model, error: '未配置翻译服务' };
}

/* ------------------------------------------------------------------ MyMemory（免密钥） */

function mymemoryLang(locale: string): string {
  if (/^zh/i.test(locale)) return /tw|hk|mo/i.test(locale) ? 'zh-TW' : 'zh-CN';
  return langCode(locale);
}

function detectSourceLocale(text: string): string {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text) ? 'zh-CN' : 'en';
}

async function mymemoryTranslate(text: string, source?: string, target?: string): Promise<TranslateOutcome> {
  const provider: TranslateProvider = 'mymemory';
  const tgt = mymemoryLang(targetLocale(target));
  const src = source ? mymemoryLang(source) : detectSourceLocale(text);
  if (src === tgt) {
    return { ok: true, text, provider, model: '', usage: `chars=${text.length}; 原文已是${targetLabel(target)}，原样保留` };
  }
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(`${src}|${tgt}`)}&rf=2`;
  try {
    const res = await fetchWithTimeout(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).slice(0, 180);
      return { ok: false, text: '', provider, model: '', error: `MyMemory：HTTP ${res.status}：${snippet || '无返回内容'}` };
    }
    const body = (await res.json()) as { responseData?: { translatedText?: string }; responseStatus?: number | string };
    const translated = String(body.responseData?.translatedText ?? '').trim();
    if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID|NO LENGTH/i.test(translated)) {
      return { ok: false, text: '', provider, model: '', error: `MyMemory 免费配额已用尽或段落过长：${translated.slice(0, 120)}` };
    }
    if (!translated) return { ok: false, text: '', provider, model: '', error: 'MyMemory 返回空译文，可能触发每日配额限制' };
    return { ok: true, text: translated, provider, model: '', usage: `chars=${text.length}; status=${body.responseStatus ?? 'ok'}` };
  } catch (e) {
    return { ok: false, text: '', provider, model: '', error: describeFetchError(e) };
  }
}

/* ------------------------------------------------------------------ AI 模型 */

async function aiTranslate(env: Env, model: string, text: string, source?: string, target?: string): Promise<TranslateOutcome> {
  const provider: TranslateProvider = 'ai';
  const cfg = await aiConfig(env);
  if (!cfg.ready) return { ok: false, text: '', provider, model: cfg.model, error: 'AI 模型未配置（设置 → AI 模型配置）' };
  const langHint = `源语言：${source ? langCode(source) : '自动判断（可为任意语言）'}；目标语言：${langCode(targetLocale(target))}（${targetLabel(target)}）。`;
  try {
    const translated = (
      await aiChat(
        env,
        [
          { role: 'system', content: `${systemPrompt(target)}${langHint}` },
          { role: 'user', content: text },
        ],
        { temperature: 0.2, maxTokens: 4096, timeoutMs: 30_000 },
      )
    ).trim();
    if (!translated) return { ok: false, text: '', provider, model: cfg.model, error: 'AI 返回空译文' };
    return { ok: true, text: translated, provider, model: cfg.model, usage: `chars=${text.length}` };
  } catch (e) {
    return { ok: false, text: '', provider, model: cfg.model, error: describeFetchError(e) };
  }
}

function describeFetchError(e: unknown): string {
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : String(e);
  if (name === 'AbortError' || /TimeoutError|超时/.test(msg)) return '翻译服务响应超时（20~30 秒），请稍后重试';
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
