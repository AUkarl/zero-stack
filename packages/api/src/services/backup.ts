/**
 * 全站备份：把 D1 里的动态数据导出成一个 JSON，可以再灌回来。
 *
 * 只备份后台产生的数据，不碰三类东西：
 *   文章正文   在 Git 仓库里，备份它等于和 Hugo 抢职责
 *   sessions   导出来就是一份可用的登录凭证，绝不能进备份文件
 *   密钥配置   默认剔除，确有需要时显式带 includeSecrets
 */

import { count, desc, eq, getTableColumns, inArray } from 'drizzle-orm';
import { createDb } from '../db/client';
import {
  auditLogs,
  commenters,
  comments,
  emailLogs,
  friendApplications,
  friendPosts,
  friends,
  inviteCodes,
  reactions,
  siteConfig,
  subscribers,
  users,
  visits,
} from '../db/schema';
import { SECRET_KEYS } from './config';

export const BACKUP_VERSION = 1;

/** 核心表：整表导出 */
const CORE = {
  users,
  commenters,
  comments,
  subscribers,
  friends,
  friendPosts,
  inviteCodes,
  friendApplications,
  siteConfig,
};

/** 高频写入表：只取最近若干条，够用且不会把一个请求撑爆 */
const RECENT = {
  reactions: 5000,
  visits: 5000,
  emailLogs: 1000,
  auditLogs: 1000,
};

const RECENT_TABLES = { reactions, visits, emailLogs, auditLogs };

type BackupTable = keyof typeof CORE | keyof typeof RECENT_TABLES;

const ALL_TABLES = { ...CORE, ...RECENT_TABLES } as unknown as Record<BackupTable, any>;

export type BackupScope = 'core' | 'full';

export interface BackupPayload {
  version: number;
  scope: BackupScope;
  createdAt: number;
  siteName: string;
  note: string;
  counts: Record<string, number>;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function exportBackup(
  env: Env,
  opts: { scope?: BackupScope; includeSecrets?: boolean; note?: string } = {},
): Promise<{ payload: BackupPayload; warnings: string[] }> {
  const scope: BackupScope = opts.scope === 'full' ? 'full' : 'core';
  const db = createDb(env);
  const warnings: string[] = [];
  const tables: BackupPayload['tables'] = {};
  const counts: Record<string, number> = {};

  const names: BackupTable[] = scope === 'full' ? [...(Object.keys(CORE) as BackupTable[]), ...(Object.keys(RECENT_TABLES) as BackupTable[])] : (Object.keys(CORE) as BackupTable[]);

  for (const name of names) {
    const table: any = ALL_TABLES[name];
    // 高频表按 RECENT 里的条数截断；写成 RECENT_TABLES[name] 会拿到表对象本身
    const limit = name in RECENT ? RECENT[name as keyof typeof RECENT] : undefined;
    const base: any = db.select().from(table);
    const rows: Record<string, unknown>[] = await (limit
      ? base.orderBy(desc(table.createdAt)).limit(limit)
      : base);
    counts[name] = rows.length;
    tables[name] = rows;
  }

  if (tables.siteConfig) {
    const secretSet = new Set<string>(SECRET_KEYS);
    const before = tables.siteConfig.length;
    tables.siteConfig = opts.includeSecrets ? tables.siteConfig : tables.siteConfig.filter((r) => !secretSet.has(String(r.key)));
    counts.siteConfig = tables.siteConfig.length;
    if (opts.includeSecrets) warnings.push('本份备份包含明文密钥，请勿外传');
    else if (before !== counts.siteConfig) warnings.push(`已剔除 ${before - counts.siteConfig} 项密钥配置`);
  }

  const siteNameRow = await db.select({ value: siteConfig.value }).from(siteConfig).where(eq(siteConfig.key, 'siteName')).limit(1);

  return {
    payload: {
      version: BACKUP_VERSION,
      scope,
      createdAt: Math.floor(Date.now() / 1000),
      siteName: siteNameRow[0]?.value ?? '',
      note: (opts.note ?? '').slice(0, 200),
      counts,
      tables,
    },
    warnings,
  };
}

export interface ImportOutcome {
  dryRun: boolean;
  source: { createdAt: number; scope: BackupScope; siteName: string; version: number };
  tables: { name: string; rows: number; inserted: number; skipped: number; note: string | null }[];
  errors: string[];
}

/**
 * 导入采用「主键已存在就跳过」而不是覆盖：备份文件多半来自另一套环境，
 * 覆盖式写入会静默改掉本站已有的记录。配置表更保守——只列出不自动写。
 */
export async function importBackup(env: Env, raw: unknown, opts: { dryRun?: boolean } = {}): Promise<ImportOutcome> {
  const payload = normalizePayload(raw);
  const db = createDb(env);
  const dryRun = opts.dryRun !== false;
  const outcome: ImportOutcome = {
    dryRun,
    source: { createdAt: payload.createdAt, scope: payload.scope, siteName: payload.siteName, version: payload.version },
    tables: [],
    errors: [],
  };

  for (const [name, rows] of Object.entries(payload.tables)) {
    const table: any = ALL_TABLES[name as BackupTable];
    if (!table) {
      outcome.tables.push({ name, rows: rows.length, inserted: 0, skipped: rows.length, note: '当前版本不认识这张表' });
      continue;
    }
    if (name === 'siteConfig') {
      outcome.tables.push({ name, rows: rows.length, inserted: 0, skipped: rows.length, note: '配置不自动导入，请到后台逐项确认' });
      continue;
    }
    if (!rows.length) {
      outcome.tables.push({ name, rows: 0, inserted: 0, skipped: 0, note: null });
      continue;
    }

    const columns = new Set(Object.keys(getTableColumns(table)));
    const prepared = rows.map((r) => pickKnown(r, columns)).filter((r) => Object.keys(r).length);
    if (!prepared.length) {
      outcome.tables.push({ name, rows: rows.length, inserted: 0, skipped: rows.length, note: '字段与当前表结构不匹配' });
      continue;
    }
    if (dryRun) {
      const pk = singlePk(table);
      if (!pk) {
        outcome.tables.push({ name, rows: prepared.length, inserted: prepared.length, skipped: 0, note: '演习无法核对主键，实际以确认导入为准' });
        continue;
      }
      const values = [...new Set(prepared.map((r) => r[pk.prop]).filter((v) => v !== undefined && v !== null))];
      let existing = 0;
      for (let i = 0; i < values.length; i += 100) {
        try {
          const res = await db.select({ n: count() }).from(table).where(inArray(pk.column, values.slice(i, i + 100)));
          existing += Number(res[0]?.n ?? 0);
        } catch {
          existing = 0;
          break;
        }
      }
      const skip = Math.min(existing, prepared.length);
      outcome.tables.push({
        name,
        rows: prepared.length,
        inserted: prepared.length - skip,
        skipped: skip,
        note: skip ? `${skip} 行主键已存在，会被跳过` : null,
      });
      continue;
    }

    let inserted = 0;
    let skipped = 0;
    /* D1 的限制在「一条语句绑定多少个参数」（上限 100），不是行数：
       原先按 100 行一批发，commenters 七个字段就是 700 个参数，整批直接失败。 */
    const perBatch = Math.max(1, Math.floor(90 / Math.max(1, columns.size)));
    for (let i = 0; i < prepared.length; i += perBatch) {
      const batch = prepared.slice(i, i + perBatch);
      try {
        const res = await db.insert(table).values(batch).onConflictDoNothing();
        const changes = Number((res as unknown as { meta?: { changes?: number } }).meta?.changes ?? batch.length);
        inserted += changes;
        skipped += batch.length - changes;
      } catch (e) {
        // 单批失败不影响其它表，错误攒起来一起回报
        outcome.errors.push(`${name}: ${briefError(e)}`);
      }
    }
    outcome.tables.push({ name, rows: prepared.length, inserted, skipped, note: null });
  }

  return outcome;
}

function normalizePayload(raw: unknown): BackupPayload {
  if (!raw || typeof raw !== 'object') throw new Error('备份文件不是合法的 JSON');
  const p = raw as Partial<BackupPayload>;
  if (!p.tables || typeof p.tables !== 'object') throw new Error('备份文件缺少 tables 字段');
  if (p.version && p.version > BACKUP_VERSION) throw new Error(`备份版本 ${p.version} 高于当前支持的 ${BACKUP_VERSION}`);
  return {
    version: p.version ?? 0,
    scope: p.scope === 'full' ? 'full' : 'core',
    createdAt: p.createdAt ?? 0,
    siteName: p.siteName ?? '',
    note: p.note ?? '',
    counts: p.counts ?? {},
    tables: p.tables as BackupPayload['tables'],
  };
}

/** 导入失败时 D1 会把整条 SQL 连同绑定参数（邮箱、昵称、IP…）一起回显，
    这些内容会进后台提示与 audit_logs，所以只留「params:」之前的原因部分。 */
function briefError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split(/\s+params:/i)[0].slice(0, 200);
}

function pickKnown(row: Record<string, unknown>, columns: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (columns.has(k) && v !== undefined) out[k] = v;
  return out;
}

/** 本仓库的表都是单列主键；复合主键返回 null，演习就退回粗估 */
function singlePk(table: any): { prop: string; column: any } | null {
  if (!table) return null;
  const pks = Object.entries(getTableColumns(table)).filter(([, c]) => (c as { primary?: boolean }).primary === true);
  return pks.length === 1 ? { prop: pks[0][0], column: pks[0][1] } : null;
}

export function backupKey(date = new Date()): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  return `backups/zero-${stamp}.json`;
}

/** 只保留最近 N 份，避免每次点备份都在 R2 里堆文件 */
export async function pruneBackups(env: Env, keep = 10): Promise<number> {
  const listed = await env.R2.list({ prefix: 'backups/', limit: 1000 });
  const objects = listed.objects.sort((a, b) => (b.uploaded?.getTime() ?? 0) - (a.uploaded?.getTime() ?? 0));
  let removed = 0;
  for (const o of objects.slice(Math.max(0, keep))) {
    await env.R2.delete(o.key);
    removed++;
  }
  return removed;
}
