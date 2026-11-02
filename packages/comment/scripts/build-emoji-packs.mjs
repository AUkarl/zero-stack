// 把 Waline 官方表情包的清单烘焙进 src/lib/emoji-data.gen.ts，运行时不再去 fetch info.json。
// 用法：node scripts/build-emoji-packs.mjs [--no-verify]
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * 同一份文件在四家公共 CDN 上的根地址，按「国内移动网络可达 + 本机实测延迟」排的序：
 * fastly 与 gcore 是 jsDelivr 的两个备用域名，cdn.jsdelivr.net 排第三（它最出名但在国内是
 * 时好时坏的那一个，unpkg 最慢放最后）。一张图取不到就依次换下一家，全失败才退回 token 原文。
 * 取清单和抽样校验用第一个。
 */
const BASES = [
  'https://fastly.jsdelivr.net/npm/@waline/emojis@1.3.0',
  'https://gcore.jsdelivr.net/npm/@waline/emojis@1.3.0',
  'https://cdn.jsdelivr.net/npm/@waline/emojis@1.3.0',
  'https://unpkg.com/@waline/emojis@1.3.0',
];
const CDN = BASES[0];

/** dir 是 CDN 目录名，token 是评论正文里用的简称（[bb:doge] 而不是 [bilibili:doge]） */
const SETS = [
  { token: 'weibo', dir: 'weibo', expect: 89 },
  { token: 'bb', dir: 'bilibili', expect: 51 },
  { token: 'qq', dir: 'qq', expect: 199 },
  { token: 'tieba', dir: 'tieba', expect: 54 },
];

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/lib/emoji-data.gen.ts');

/** 只收字母数字与 _ -：这些名字会拼进 img 的 src 与 alt，必须能当白名单用（qq 库里有个 white-yum） */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function verifyImage(url) {
  const res = await fetch(url, { method: 'HEAD' });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) {
    throw new Error(`${url} → HTTP ${res.status} / ${type || '无 content-type'}`);
  }
  return type;
}

async function build() {
  const out = [];
  for (const set of SETS) {
    const info = await getJson(`${CDN}/${set.dir}/info.json`);
    const prefix = String(info.prefix || '');
    const type = String(info.type || '');
    const raw = Array.isArray(info.items) ? info.items : [];
    const items = [...new Set(raw.map((s) => String(s || '').trim()))].filter((s) => SAFE_NAME.test(s));
    if (!prefix || !/^[a-z0-9_-]+$/.test(prefix)) throw new Error(`${set.dir}: prefix ${JSON.stringify(prefix)} 不合白名单`);
    if (type !== 'png' && type !== 'gif') throw new Error(`${set.dir}: 不认识的 type ${type}`);
    if (items.length !== set.expect) {
      throw new Error(`${set.dir}: 清单 ${raw.length} 项 / 可用 ${items.length} 项，与预期 ${set.expect} 不符`);
    }
    if (items.length !== new Set(items.map((i) => `${set.token}:${i}`)).size) throw new Error(`${set.dir}: token 重名`);
    out.push({ token: set.token, dir: set.dir, prefix, type, items });
    console.log(`${set.token.padEnd(6)} ← ${set.dir}/info.json：${items.length} 项（${prefix}*.$${type}）`);
  }

  if (!process.argv.includes('--no-verify')) {
    for (const s of out) {
      for (const name of [s.items[0], s.items[s.items.length - 1]]) {
        const url = `${CDN}/${s.dir}/${s.prefix}${name}.${s.type}`;
        console.log(`  抽样 ${url} → ${await verifyImage(url)}`);
      }
    }
  }

  const body = `/**
 * emoji-data.gen.ts — 由 scripts/build-emoji-packs.mjs 从 @waline/emojis@1.3.0 的官方清单生成，请勿手改。
 * 清单在构建期烘焙进包：运行期只按需向 CDN 要图片本身，不再请求 info.json。
 */

/** 同一张表情图在几家公共 CDN 上的根地址，按顺序试（见构建脚本里的排序理由） */
export const EMOJI_CDN_BASES: string[] = [
${BASES.map((b) => `  '${b}',`).join('\n')}
];

export interface EmojiImageSet {
  /** 正文 token 里的库名，如 [weibo:smile] 的 weibo */
  token: string;
  /** CDN 上的目录名（与 token 不同：bb 对应 bilibili） */
  dir: string;
  prefix: string;
  type: 'png' | 'gif';
  items: string[];
}

export const EMOJI_IMAGE_SETS: EmojiImageSet[] = [
${out
    .map(
      (s) => `  {
    token: '${s.token}',
    dir: '${s.dir}',
    prefix: '${s.prefix}',
    type: '${s.type}',
    items: [
${chunk(s.items).map((line) => `      ${line}`).join('\n')}
    ],
  },`,
    )
    .join('\n')}
];
`;

  writeFileSync(OUT, body, 'utf8');
  console.log(`已写出 ${OUT}`);
}

/** 每行放固定数量的短名，避免生成一整行超长数组 */
function chunk(list) {
  const rows = [];
  for (let i = 0; i < list.length; i += 10) {
    rows.push(list.slice(i, i + 10).map((s) => `'${s}'`).join(', ') + ',');
  }
  return rows;
}

build().catch((e) => {
  console.error('生成失败：', e.message);
  process.exit(1);
});
