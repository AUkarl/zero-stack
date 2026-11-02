/**
 * avatar.ts — 评论头像与昵称派生（从 hy 版移植，零依赖纯函数）
 *
 * Gravatar / Cravatar 都按「邮箱小写后的 MD5」取图，而 WebCrypto 在部分运行时里
 * 不保证给出 MD5，所以这里带一份纯 JS 的 MD5（输入只是邮箱，用于拼 URL，不涉及敏感存储）。
 *
 * 退化链：gravatar.com → cravatar.cn →（QQ 号）q1.qlogo.cn → 前端首字母色块占位。
 */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K: number[] = [];
for (let i = 0; i < 64; i++) MD5_K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));

/** 字符串的 MD5 十六进制小写（UTF-8 输入） */
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const withPad = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + MD5_K[i]! + m[g]!) >>> 0;
      const s = MD5_S[i]!;
      b = (b + (((x << s) | (x >>> (32 - s))) >>> 0)) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const hex = (n: number) =>
    [0, 8, 16, 24].map((s) => ((n >>> s) & 0xff).toString(16).padStart(2, '0')).join('');
  return hex(a0)! + hex(b0)! + hex(c0)! + hex(d0)!;
}

/** Cravatar 的 MD5，前端退化到 gravatar.cn 时用的是同一个值 */
export function emailMd5(email: string): string {
  return md5(String(email || '').trim().toLowerCase());
}

/**
 * 按邮箱给出头像候选，从高到低：
 *   1. Gravatar（www.gravatar.com，国际通用，同一套 MD5）
 *   2. Cravatar（国内镜像，同一套 MD5，多数号在两边是同一张图）
 *   3. QQ / Foxmail 且 @ 前是纯数字 → q1.qlogo.cn 的 QQ 头像
 * 三级都 `d=404`：没有头像就回 404，前端 onerror 才能退到下一级，
 * 最后落到首字母色块（用 d=mp 会拿到一张通用的灰影人，链条当场断在这里）。
 * 返回空数组 = 连邮箱都没有。
 */
export function avatarChainForEmail(email: string): string[] {
  const mail = String(email || '').trim().toLowerCase();
  const at = mail.indexOf('@');
  if (at < 1) return [];
  const local = mail.slice(0, at);
  const domain = mail.slice(at + 1);
  const hash = md5(mail);
  const chain = [`https://www.gravatar.com/avatar/${hash}?d=404&s=128`, `https://cravatar.cn/avatar/${hash}?d=404&s=128`];
  if ((domain === 'qq.com' || domain === 'foxmail.com') && /^\d{5,12}$/.test(local)) {
    chain.push(`https://q1.qlogo.cn/g?b=qq&nk=${local}&s=100`);
  }
  return chain;
}

/**
 * 邮箱派生头像的第一选：后台「头像与媒体」里填了 avatarTemplate 就按模板拼
 * （{hash} / {email} 两个占位符），否则用候选链的第一级（Gravatar）。
 * 后台模板是整条链的总开关：换了它等于换图床，所以它优先于链上任何一级。
 */
export function avatarForEmail(email: string, template = ''): string {
  const t = String(template || '').trim();
  if (t) {
    const mail = String(email || '').trim().toLowerCase();
    if (!mail.includes('@')) return '';
    return t.replaceAll('{hash}', md5(mail)).replaceAll('{email}', encodeURIComponent(mail));
  }
  return avatarChainForEmail(email)[0] ?? '';
}

/** 昵称留空时按邮箱派生：zhangsan@qq.com → z***@qq.com */
export function nicknameFromEmail(email: string): string {
  const mail = String(email || '').trim().toLowerCase();
  const at = mail.indexOf('@');
  if (at < 1) return '匿名';
  return `${mail[0]}***@${mail.slice(at + 1)}`;
}

/** 邮箱格式（够用就行，真正的校验靠发信） */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}
