import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import { createDb } from '../db/client';
import { auditLogs } from '../db/schema';

/**
 * 后台动作留痕：谁在什么时候改了什么。
 * 写失败不影响主流程——审计是附加信息，不能因为它把业务请求带崩。
 */

export type AuditAction =
  | 'config'
  | 'params'
  | 'email'
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
  | 'stats'
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

/**
 * 翻审计流水：总数要和这一页一起回来，否则界面上「共多少条」只能显示本页条数，
 * 出了事根本看不出是被截断还是真的只有这几笔。limit 走 1..500，传 0 不再静默当 100。
 */
export async function listAudit(
  env: Env,
  opts: { action?: string; from?: number; to?: number; limit?: number; offset?: number },
): Promise<{ rows: (typeof auditLogs.$inferSelect)[]; total: number; limit: number; offset: number }> {
  const db = createDb(env);
  const conds = [];
  if (opts.action) conds.push(eq(auditLogs.action, opts.action));
  if (opts.from) conds.push(gte(auditLogs.createdAt, opts.from));
  if (opts.to) conds.push(lte(auditLogs.createdAt, opts.to));
  const where = conds.length ? and(...conds) : undefined;
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 100)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const [rows, counted] = await Promise.all([
    db.select().from(auditLogs).where(where).orderBy(desc(auditLogs.createdAt)).limit(limit).offset(offset),
    db.select({ n: count() }).from(auditLogs).where(where),
  ]);
  return { rows, total: counted[0]?.n ?? 0, limit, offset };
}
