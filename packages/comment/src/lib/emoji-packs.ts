/**
 * emoji-packs.ts — 评论表情库（多 tab 弹层的数据源 + 正文 token 的渲染白名单）
 *
 * 两类库：
 *   · 文本库（emoji / 自定义 / 颜文字）：items 是要插进正文的字符本身；
 *   · 图片库（微博 / B站 / QQ / 贴吧）：清单构建期由 scripts/build-emoji-packs.mjs 从
 *     Waline 官方表情包烘焙进 emoji-data.gen.ts，插进正文的是 [库:名字] 这种 token，
 *     图片按需要从公共 CDN 加载，运行期不再请求 info.json。
 * 图片 token 只有在 EMOJI_IMAGES 里查得到才渲染成 <img>，用户自己拼的 [任意:任意]
 * 一律保持字面文本 —— 渲染点见 lib/markdown.ts 的 emoji 段。
 */

import { EMOJI_CDN_BASES, EMOJI_IMAGE_SETS } from './emoji-data.gen';

export interface EmojiImage {
  /** 正文里的 token，如 [weibo:smile] */
  token: string;
  /** 库内短名，如 smile */
  name: string;
  /** 同一张图在几家 CDN 上的地址，按优先级排；前面取不到就依次换后面 */
  srcs: string[];
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
    srcs: EMOJI_CDN_BASES.map((base) => `${base}/${s.dir}/${s.prefix}${name}.${s.type}`),
  })),
}));


export const BUILTIN_EMOJI_PACKS: EmojiPack[] = [
  ...IMAGE_PACKS,
  { id: 'emoji', label: 'Emoji', items: UNICODE },
  { id: 'kaomoji', label: '颜文字', items: KAOMOJI },
];

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

/**
 * 老站（Waline）导入的评论把表情存成了一枚 img：
 *   <img class="wl-emoji" src="https://cdn.jsdelivr.net/npm/@waline/emojis@1.4.0/weibo/weibo_grin.png">
 * 渲染器会把正文里的 HTML 整体转义，于是这些表情全变成一串源码。
 *
 * 这里只认「@waline/emojis 的 jsdelivr/unpkg 路径」这一种形状，把同一条路径换成我们惯用的
 * 四家镜像（fastly → gcore → cdn → unpkg），其余一律返回 null（正文继续按文本显示）。
 * 表情库本身只烘焙了 1.3.0 的一小部分，导入的 1.4.0 图名多半不在白名单里，所以这里不查白名单，
 * 只校验地址形状 —— 地址之外的任何东西仍然进不来。
 */
const LEGACY_WALINE_URL =
  /^https?:\/\/(?:cdn|fastly|gcore)\.jsdelivr\.net\/npm\/@waline\/emojis@([^/]+)\/([a-z0-9_-]+)\/([a-z0-9_.-]+)\.(png|gif|webp)$/i;

export function emojiImageFromLegacyUrl(src: string): EmojiImage | null {
  const m = String(src || '').trim().match(LEGACY_WALINE_URL);
  if (!m) return null;
  const [, version, dirRaw, stemRaw, ext] = m;
  const dir = dirRaw.toLowerCase();
  const stem = stemRaw.toLowerCase();
  const name = stem.startsWith(`${dir}_`) ? stem.slice(dir.length + 1) : stem;
  if (!/^[a-z0-9_-]+$/.test(name)) return null;
  const npmPath = `@waline/emojis@${version}/${dir}/${stem}.${ext}`;
  return {
    token: `[${dir}:${name}]`,
    name,
    srcs: [
      `https://fastly.jsdelivr.net/npm/${npmPath}`,
      `https://gcore.jsdelivr.net/npm/${npmPath}`,
      `https://cdn.jsdelivr.net/npm/${npmPath}`,
      `https://unpkg.com/${npmPath}`,
    ],
  };
}

/*
 * 表情图的那一枚 <img> —— 正文渲染、表情面板、后台与账号页都用这一份，保证四处行为一致。
 *
 * 首张进 src，其余进 data-chain（空格分隔；地址全是构建期从白名单拼出来的，不会带空格），
 * onerror 里换下一张，全试完就把这张图换成 token 原文（[weibo:smile]）—— 宁可看见代码，
 * 也不留一个破碎图标。
 *
 * onerror 写成内联的：这段 HTML 要出现在评论区（组件内）、后台评论管理（另一个域名、
 * 另一套 JS）、个人中心（主题里的普通脚本）和邮件正文里，只有内联属性在哪一处都能退图。
 * 地址与 token 都被白名单限死在 [A-Za-z0-9_:-] 之内，拼进属性不会有引号。
 */
const GIVE_UP = "var s=document.createElement('span');s.className='zc-emoji-tok';s.textContent=this.dataset.emoji;this.replaceWith(s)";
/**
 * 表情图的那串 onerror 本体。净化层（lib/sanitize.ts）会让 DOMPurify 先把所有 on* 剥掉，
 * 再按这个常量把表情图那一枚贴回去 —— 值不来自正文，所以「保留内联事件」这件事被限定在一处。
 */
export const EMOJI_ONERROR = "var l=(this.dataset.chain||'').split(' ');if(l[0]){this.dataset.chain=l.slice(1).join(' ');this.src=l[0]}else{" + GIVE_UP + '}';

export function emojiImgHtml(img: EmojiImage): string {
  const token = img.token;
  const chain = img.srcs.slice(1).join(' ');
  return (
    `<img class="zc-emoji-img" src="${img.srcs[0]}" alt="${token}" title="${token}" data-emoji="${token}"` +
    ` data-chain="${chain}" loading="lazy" decoding="async" onerror="${EMOJI_ONERROR}">`
  );
}

/** 只匹配 [小写库名:名字]，库名与名字都得是白名单字符 */
export const EMOJI_TOKEN_RE = /\[([a-z]+):([A-Za-z0-9_-]+)\]/g;
