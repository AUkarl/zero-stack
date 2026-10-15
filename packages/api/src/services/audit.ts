import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { createDb } from '../db/client';
import { auditLogs } from '../db/schema';

/**
 * 后台动作留痕：谁在什么时候改了什么。
 * 写失败不影响主流程——审计是附加信息，不能因为它把业务请求带崩。
 */

export type AuditAction =
  | 'config'
  | 'params'
  | 'comment'
  | 'friend'
  | 'friendApp'
  | 'user'
  | 'profile'
  | 'draft'
  | 'authorRequest'
  | 'invite'
  | 'content'
  | 'media'
  | 'moment'
  | 'broadcast'
  | 'backup'
  | 'translate';

interface Actor {
  id?: string | null;
  name?: string | null;
}

export async function writeAudit(
  env: Env,
  input: { actor?: Actor | null; action: AuditAction; target?: string | null; detail?: unknown; ip?: string },
): Promise<void> {
  try {
    const db = createDb(env);
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      actorId: input.actor?.id ?? null,
      actorName: input.actor?.name ?? null,
      action: input.action,
      target: input.target ?? null,
      detail: input.detail === undefined ? null : JSON.stringify(input.detail).slice(0, 8000),
      ip: input.ip ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    });
  } catch (err) {
    console.warn('[zero-api] 审计写入失败', err);
  }
}

export async function listAudit(
  env: Env,
  opts: { action?: string; from?: number; to?: number; limit?: number },
) {
  const db = createDb(env);
  const conds = [];
  if (opts.action) conds.push(eq(auditLogs.action, opts.action));
  if (opts.from) conds.push(gte(auditLogs.createdAt, opts.from));
  if (opts.to) conds.push(lte(auditLogs.createdAt, opts.to));
  const query = db.select().from(auditLogs);
  const rows = await (conds.length ? query.where(and(...conds)) : query)
    .orderBy(desc(auditLogs.createdAt))
    .limit(Math.min(500, opts.limit ?? 100));
  return rows;
}
