/**
 * emoji-packs.ts — 评论表情库（多 tab 弹层的数据源 + 正文 token 的渲染白名单）
 *
 * 两类库：
 *   · 文本库（emoji / 自定义 / 颜文字）：items 是要插进正文的字符本身；
 *   · 图片库（微博 / B站 / QQ / 贴吧）：清单构建期由 scripts/build-emoji-packs.mjs 从
 *     Waline 官方表情包烘焙进 emoji-data.gen.ts，插进正文的是 [库:名字] 这种 token，
 *     图片按需要从 jsDelivr 加载，运行期不再请求 info.json。
 * 图片 token 只有在 EMOJI_IMAGES 里查得到才渲染成 <img>，用户自己拼的 [任意:任意]
 * 一律保持字面文本 —— 渲染点见 lib/markdown.ts 的 emoji 段。
 */

import { EMOJI_CDN_BASE, EMOJI_IMAGE_SETS } from './emoji-data.gen';

export interface EmojiImage {
  /** 正文里的 token，如 [weibo:smile] */
  token: string;
  /** 库内短名，如 smile */
  name: string;
  /** CDN 上的图片地址 */
  src: string;
}

export interface EmojiPack {
  id: string;
  /** tab 上的文案 */
  label: string;
  /** 文本表情：直接插进正文 */
  items: string[];
  /** 图片表情：插进正文的是 token */
  images?: EmojiImage[];
}

/** 原来三档 Unicode 表情（抖音/微博/B站）几乎全是重复的，去重合并成一档 */
const UNICODE: string[] = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '🥰', '😘', '😜', '😝', '🤪', '🤗',
  '🤔', '🫣', '🙄', '😏', '😌', '😴', '🥱', '😎', '🤩', '🥳', '😳', '🤤',
  '😱', '😭', '😅', '🤯', '😡', '🤬', '🥺', '😞', '💀', '👻', '🤡', '🫤',
  '🙌', '👏', '👍', '👎', '🤝', '💪', '☝️', '✌️', '🤞', '👀', '🫶', '❤️',
  '💔', '✨', '🔥', '🎉', '💯', '🌹', '☕', '🍺', '🍗', '🐶', '😄', '😆',
  '🙂', '😉', '😒', '😔', '😤', '🥵', '🥶', '😇', '👽', '🤖', '🎈', '🌟',
  '⭐', '🌙', '☀️', '⛅', '🌈', '☁️', '❄️', '⚡', '🌊', '🍉', '🍚', '🍜',
  '🍕', '🍻', '🎂', '📷', '🎬', '📚', '✏️', '🎵', '💬', '📢', '💡', '💧',
  '🍃', '🌸', '💐', '🐱', '🐼', '🐷', '🦄', '🙃', '🤢', '🛸', '🌚', '🌝',
  '🙈', '🙉', '🙊', '🐧', '🦊', '🍬', '🍡', '🍰', '🍿', '🎤', '🎮', '📺',
  '💖', '💰',
];

/**
 * 颜文字：字符串里带反斜杠和引号，写的时候用单引号包住并把反斜杠转义。
 * 长度不一，面板按宽度自动排，长的那几个会自己占一行。
 */
const KAOMOJI: string[] = [
  '(╯°□°)╯︵ ┻━┻', '┬─┬ノ( º _ ºノ)', '(¬‿¬)', '(￣▽￣)"', 'Orz',
  '_(:з」∠)_', '¯\\_(ツ)_/¯', '(ノಠ益ಠ)ノ', '(╥_╥)', '(´・ω・｀)',
  '(っ˘ω˘ς)', '(✿◕‿◕)', '(◕‿◕)', 'm(_ _)m', '(¬_¬")',
  '╮(╯_╰)╭', '( ￣▽￣)', '←_←', '→_→', '(⊙_⊙)',
  '(°ロ°)!', '(￣3￣)', 'ᕕ( ᐛ )ᕗ', '(ノ´▽`)ノ♪', '凸(▀̿Ĺ̯▀̿ ̿)',
  '(☞ﾟヮﾟ)☞', '(＾▽＾)', '(￣^￣)ゞ', '(・_・;)', '(ノД`)・゜・。',
  '(＾ω＾)', '✧(≖ ◡ ≖✿)', '(ಡωಡ)', 'Ծ‸Ծ', '(๑•̀ㅂ•́)و✧',
  '(￣Д￣)ﾉ', '(￢_￢)', '(｡•ˇ‸ˇ•｡)', '(￣ω￣)', '(・ω・)ノ',
  '(￣o~￣)', '(っ´Ι`)っ', 'Σ(°△°|||)', '(●ω●)', '(๑ᵒ̴̶̷͈᷄ᗨᵒ̴̶̷͈᷅)',
  '(*/ω＼*)', '(˘︹˘)', '( ˘ω˘ )',
];

/** 图片库的 tab 文案（dir 是 CDN 目录名，前台只认 token 那一份） */
const IMAGE_TABS: Record<string, string> = {
  weibo: '微博',
  bb: 'B站',
  qq: 'QQ',
  tieba: '贴吧',
};

export const IMAGE_PACKS: EmojiPack[] = EMOJI_IMAGE_SETS.map((s) => ({
  id: s.token,
  label: IMAGE_TABS[s.token] ?? s.token,
  items: [],
  images: s.items.map((name) => ({
    token: `[${s.token}:${name}]`,
    name,
    src: `${EMOJI_CDN_BASE}/${s.dir}/${s.prefix}${name}.${s.type}`,
  })),
}));


export const BUILTIN_EMOJI_PACKS: EmojiPack[] = [
  ...IMAGE_PACKS,
  { id: 'emoji', label: 'Emoji', items: UNICODE },
  { id: 'kaomoji', label: '颜文字', items: KAOMOJI },
];

/**
 * 后台 commentEmojiPacks 里那些自定义 Unicode 追加成「自定义」tab，紧跟在 emoji 档后面；
 * 没配就不出这个 tab（不覆盖内置库）。
 */
export function emojiPacks(custom: string[], withCustom = true): EmojiPack[] {
  const packs = [...BUILTIN_EMOJI_PACKS];
  const list = [...new Set((custom ?? []).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 200);
  if (withCustom && list.length) {
    const at = packs.findIndex((p) => p.id === 'emoji');
    packs.splice(at < 0 ? packs.length : at + 1, 0, { id: 'custom', label: '自定义', items: list });
  }
  return packs;
}

/* ------------------------------------------------------------------
 * 正文 token → 图片：唯一一份白名单，markdown 渲染器只认这张表
 * ----------------------------------------------------------------*/

/** 'weibo:smile' → 图片数据；查不到就是 undefined（正文保持 [weibo:smile] 字面文本） */
const EMOJI_IMAGES = new Map<string, EmojiImage>();
for (const pack of IMAGE_PACKS) {
  for (const img of pack.images ?? []) EMOJI_IMAGES.set(img.token.slice(1, -1), img);
}

export function emojiImageOf(key: string): EmojiImage | undefined {
  return EMOJI_IMAGES.get(key);
}

/** 只匹配 [小写库名:名字]，库名与名字都得是白名单字符 */
export const EMOJI_TOKEN_RE = /\[([a-z]+):([A-Za-z0-9_-]+)\]/g;
