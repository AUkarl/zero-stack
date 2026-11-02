/**
 * totp.ts — 身份验证器（RFC 6238 TOTP）
 *
 * 从 hy 分支的 lib/security.ts 移植核心算法，按本站的写法重新组织：
 *   1. generateSecret()：20 字节随机密钥 → Base32，给验证器扫码用
 *   2. verifyTotp(secret, code, { window, kv, key })：前后各 window 个时间步长容错，
 *      命中后用 KV 记一次「这个时间步长已经用过」，同一个码不能重放两次
 *   3. otpauthUri()：otpauth:// URI，前端直接拿去生成二维码
 *   4. protectSecret / openSecret：密钥不能明文进库，用 SESSION_SECRET 派生 AES-GCM 密文
 *
 * 参数固定 SHA-1 / 6 位 / 30 秒，与 Google Authenticator、Microsoft Authenticator、
 * 1Password、Bitwarden 的默认值一致，避免用户扫了码却对不上。
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const CODE_DIGITS = 6;

const enc = new TextEncoder();

function bytesFromBase64(value: string): Uint8Array {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64FromBytes(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/* ------------------------------------------------------------------ 密钥 */

function base32Encode(bytes: Uint8Array): string {
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32_ALPHABET[Number.parseInt(bits.slice(i, i + 5), 2)];
  const rest = bits.length % 5;
  if (rest) out += B32_ALPHABET[Number.parseInt(bits.slice(bits.length - rest).padEnd(5, '0'), 2)];
  return out;
}

/** 生成 base32 密钥（RFC 4648 无填充），默认 20 字节 = 32 个字符 */
export function generateSecret(bytes = 20): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base32Decode(value: string): Uint8Array {
  const clean = String(value ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const out = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

/* ------------------------------------------------------------------ 验证码 */

/** 按 RFC 6238 算某个时间步长的 6 位码 */
export async function totpAt(secret: string, counter: number): Promise<string> {
  const keyBytes = base32Decode(secret);
  if (!keyBytes.length) return '';

  const msg = new Uint8Array(8);
  const view = new DataView(msg.buffer);
  view.setUint32(0, Math.floor(counter / 4294967296));
  view.setUint32(4, counter % 4294967296);

  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | ((mac[offset + 1]! & 0xff) << 16) | ((mac[offset + 2]! & 0xff) << 8) | (mac[offset + 3]! & 0xff);
  return String(binary % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
}

export interface TotpVerifyOptions {
  /** 前后容错的时间步长数，默认 1（即 ±30 秒） */
  window?: number;
  /** 传 KV 就启用防重放：用过的时间步长记进去，同一个码只能用一次 */
  kv?: KVNamespace | null;
  /** 防重放的归属标识，一般传用户 id */
  key?: string;
}

/**
 * 校验用户输入的动态码。
 * 手机与服务器的时钟常有几十秒偏差，所以默认接受前后一个步长；
 * 带 kv 时命中即登记，下一个请求再交同一个码会被判为重放。
 */
export async function verifyTotp(secret: string, code: string, opts: TotpVerifyOptions = {}): Promise<boolean> {
  const plain = String(code ?? '').replace(/[\s-]/g, '');
  if (!secret || !/^\d{6}$/.test(plain)) return false;

  const window = Math.max(0, Math.min(3, opts.window ?? 1));
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);

  for (let drift = -window; drift <= window; drift++) {
    const step = counter + drift;
    if ((await totpAt(secret, step)) !== plain) continue;
    if (!opts.kv || !opts.key) return true;
    const kv = opts.kv;
    const usedKey = `totp:used:${opts.key}:${step}`;
    try {
      if (await kv.get(usedKey)) continue;
      await kv.put(usedKey, '1', { expirationTtl: STEP_SECONDS * (window * 2 + 1) + 60 });
    } catch (err) {
      // KV 读写失败不该把人锁在门外：当作校验通过，只是失去这一次防重放
      console.warn('[totp] 防重放记录失败', err);
    }
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ otpauth URI */

export function otpauthUri(input: { secret: string; issuer: string; account: string }): string {
  const issuer = input.issuer || 'Zero';
  const label = encodeURIComponent(`${issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(CODE_DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------------------ 密钥落库加密 */

async function aesKey(master: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`zero-totp|${master}`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 密钥密文格式：gcm$<ivB64>$<cipherB64>，master 换掉后旧密文自然解不开 */
export async function protectSecret(plain: string, master: string): Promise<string> {
  if (!plain) return '';
  if (!master) return plain;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(master), enc.encode(plain));
  return `gcm$${base64FromBytes(iv)}$${base64FromBytes(new Uint8Array(data))}`;
}

/** 解不开（换过 SESSION_SECRET、或历史明文）时原样返回，让调用方仍能校验老数据 */
export async function openSecret(stored: string, master: string): Promise<string> {
  if (!stored) return '';
  if (!stored.startsWith('gcm$')) return stored;
  const [, iv, body] = stored.split('$');
  if (!iv || !body || !master) return '';
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytesFromBase64(iv) }, await aesKey(master), bytesFromBase64(body));
    return new TextDecoder().decode(plain);
  } catch {
    return '';
  }
}

