const enc = new TextEncoder();

export function newId(): string {
  return crypto.randomUUID();
}

export function toHex(a: Uint8Array): string {
  let s = '';
  for (const b of a) s += b.toString(16).padStart(2, '0');
  return s;
}

export function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * 管理员重置密码用的一次性随机密码：14 位、只含字母数字且去掉了容易看错的
 * 0/O/1/I/l，抄写与电话沟通都不会出错。大小写与数字各至少一个，长度也超过
 * 注册下限，重置完用户可以直接登录。
 */
export function randomPassword(length = 14): string {
  const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const LOWER = 'abcdefghijkmnpqrstuvwxyz';
  const DIGIT = '23456789';
  const ALL = UPPER + LOWER + DIGIT;
  const pick = (set: string) => set[crypto.getRandomValues(new Uint8Array(1))[0] % set.length]!;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT)];
  while (chars.length < Math.max(4, length)) chars.push(pick(ALL));
  // Fisher–Yates：保证的三类字符不固定在前几位
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint8Array(1))[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

function keyMaterial(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecodeToString(str: string): string {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await keyMaterial(secret), enc.encode(data));
  return toHex(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacVerify(secret: string, data: string, signature: string): Promise<boolean> {
  return timingSafeEqual(await hmacHex(secret, data), signature);
}

/** 紧凑签名 token：payload.signature。不引 JWT 库，Workers 上更可控 */
export async function signToken(secret: string, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmacHex(secret, body)}`;
}

export async function verifyToken<T>(secret: string, token: string): Promise<T | null> {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!(await hmacVerify(secret, body, sig))) return null;
  try {
    const payload = JSON.parse(b64urlDecodeToString(body)) as T & { exp?: number };
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ------------------------- 口令哈希 ------------------------- */

const PBKDF2_ITERATIONS = 150_000;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

/** 存储格式 pbkdf2$<iterations>$<saltHex>$<hashHex>，迭代次数随串走，日后可平滑加强 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${await derive(password, salt, PBKDF2_ITERATIONS)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  return timingSafeEqual(parts[3]!, await derive(password, bytesFromHex(parts[2]!), iterations));
}

/* ------------------------- 头像与匿名指纹 ------------------------- */

/**
 * Gravatar/Cravatar 要的是邮箱 md5。Workers 运行时提供 MD5 摘要；
 * 万一拿不到就退回 sha-256，由后台 avatarTemplate 决定怎么拼头像 URL。
 */
export async function emailHash(email: string): Promise<{ algo: string; hash: string }> {
  const normalized = email.trim().toLowerCase();
  for (const algo of ['MD5', 'SHA-256']) {
    try {
      const digest = await crypto.subtle.digest(algo as string, enc.encode(normalized));
      return { algo, hash: toHex(new Uint8Array(digest)) };
    } catch {
      continue;
    }
  }
  return { algo: 'none', hash: '' };
}

/** 匿名点赞去重指纹：IP + UA，加服务端盐，不落原始 IP */
export async function anonymousFingerprint(secret: string, ip: string, userAgent: string): Promise<string> {
  return hmacHex(secret, `${ip}|${userAgent}`);
}
