/**
 * md5.ts — 百度翻译开放平台的签名要 MD5，而 Web Crypto 不提供 MD5。
 *
 * 只用来算 `md5(appid + q + salt + 密钥)` 这一种小输入，纯同步实现、无依赖；
 * 结果按小写十六进制返回（百度要求小写）。
 * 已知向量写在单测里（""、"abc"、一段中文），改实现先过那几条。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;

export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  /* 补位：0x80 + 若干 0 + 8 字节长度（小端） */
  const withPad = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 8, bitLen >>> 0, true);
  view.setUint32(withPad.length - 4, Math.floor(bitLen / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
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
      const sum = (a + f + K[i]! + m[g]!) >>> 0;
      b = (b + ((sum << S[i]!) | (sum >>> (32 - S[i]!)))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  let hex = '';
  for (const b of out) hex += b.toString(16).padStart(2, '0');
  return hex;
}
