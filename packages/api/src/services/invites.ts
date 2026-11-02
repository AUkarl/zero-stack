import { eq } from 'drizzle-orm';
import { createDb } from '../db/client';
import { inviteCodes, users } from '../db/schema';
import { newId } from '../lib/crypto';
import { fail } from '../lib/errors';
import { getConfig, getConfigInt } from './config';

/**
 * 邀请码：注册时消费一次计数。
 * 字符集刻意去掉易混的 I/O/0/1，比对时统一大写并剔除空白与连字符。
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s_-]/g, '');
}

/** 用 CSPRNG 取模会引入轻微偏置，长度 8~32 的邀请码无所谓，先保证不越界 */
function randomCode(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface InviteRow {
  id: string;
  code: string;
  note: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: number | null;
  status: string;
  createdAt: number;
}

/** 后台生成邀请码；uses 传 0 表示不限次数 */
export async function createInvite(
  env: Env,
  input: { note?: string; uses?: number; days?: number; code?: string },
): Promise<InviteRow> {
  const db = createDb(env);
  const length = Math.min(32, Math.max(4, await getConfigInt(env, 'inviteCodeLength', 8)));
  const defaultUses = await getConfigInt(env, 'inviteCodeUses', 1);
  const code = input.code ? normalizeCode(input.code) : randomCode(length);
  if (!/^[A-Z2-9]{4,32}$/.test(code)) fail(400, '自定义邀请码只能用大写字母与 2-9（不含 0 和 1），长度 4-32');
  const maxUses = input.uses === undefined ? defaultUses : Math.max(0, Math.floor(input.uses));
  const expiresAt = input.days && input.days > 0 ? nowSec() + input.days * 86400 : null;
  const id = newId();
  try {
    await db.insert(inviteCodes).values({
      id,
      code,
      note: input.note ?? null,
      createdBy: null,
      maxUses,
      usedCount: 0,
      expiresAt,
      status: 'active',
      createdAt: nowSec(),
    });
  } catch {
    fail(409, '该邀请码已存在');
  }
  return { id, code, note: input.note ?? null, maxUses, usedCount: 0, expiresAt, status: 'active', createdAt: nowSec() };
}

export async function listInvites(env: Env): Promise<InviteRow[]> {
  const db = createDb(env);
  const rows = await db
    .select({
      id: inviteCodes.id,
      code: inviteCodes.code,
      note: inviteCodes.note,
      maxUses: inviteCodes.maxUses,
      usedCount: inviteCodes.usedCount,
      expiresAt: inviteCodes.expiresAt,
      status: inviteCodes.status,
      createdAt: inviteCodes.createdAt,
    })
    .from(inviteCodes);
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function revokeInvite(env: Env, id: string): Promise<void> {
  const db = createDb(env);
  await db.update(inviteCodes).set({ status: 'revoked' }).where(eq(inviteCodes.id, id));
}

/**
 * 消费一次邀请码。用带条件的 UPDATE 判定并发，避免「先查后写」把同一个
 * 单次码同时发给两个注册请求。成功返回码 id，失败直接 4xx。
 */
export async function consumeInvite(env: Env, raw: string): Promise<string> {
  const code = normalizeCode(raw);
  if (!code) fail(400, '请填写邀请码');
  const db = createDb(env);
  const rows = await db.select().from(inviteCodes).where(eq(inviteCodes.code, code)).limit(1);
  const row = rows[0];
  if (!row) fail(404, '邀请码不存在');
  if (row.status !== 'active') fail(400, '邀请码已作废');
  if (row.expiresAt && row.expiresAt < nowSec()) fail(400, '邀请码已过期');
  if (row.maxUses > 0 && row.usedCount >= row.maxUses) fail(400, '邀请码次数已用完');

  const meta = await env.DB.prepare(
    'update invite_codes set used_count = used_count + 1 where id = ? and status = ? and (max_uses = 0 or used_count < max_uses) and (expires_at is null or expires_at > ?)',
  )
    .bind(row.id, 'active', nowSec())
    .run();
  if (!meta.meta?.changes) fail(400, '邀请码已被用完或失效');
  return row.id;
}

/** 当前仍有余额且未过期的邀请码数量，后台概览用 */
export async function activeInviteCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    "select count(*) as n from invite_codes where status = 'active' and (expires_at is null or expires_at > (strftime('%s', 'now'))) and (max_uses = 0 or used_count < max_uses)",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/** 注册开关与邀请码要求的合并读取，注册入口和 API 共用同一份判定 */
export async function registerPolicy(env: Env): Promise<{ allowRegister: boolean; requireInviteCode: boolean }> {
  const [allow, require] = await Promise.all([
    (await getConfig(env, 'allowRegister')) === 'true',
    (await getConfig(env, 'requireInviteCode')) === 'true',
  ]);
  return { allowRegister: allow, requireInviteCode: require };
}

/** 邀请码关联的注册用户，后台查看某个码都招了谁 */
export async function inviteUsage(env: Env, id: string) {
  const db = createDb(env);
  return db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.invitedBy, id));
}
