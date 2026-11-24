/**
 * 鲸鱼娘：共享状态、站点时间与互动记录。
 *
 * 状态判断只在这里做一份，桌宠接口、评论区自动回复和 AI PET 台词共用；
 * 互动记录只存内容与页面，不存明文 IP / UA，后台仅管理员可见。
 */
import { desc, eq, lt, sql } from 'drizzle-orm';
import { createDb } from '../db/client';
import { petEvents, petState } from '../db/schema';
import { newId } from '../lib/crypto';
import { getConfigInt } from './config';

export const PET_ROW_ID = 'global';
const IDLE_SLEEP_SEC = 300;
const EVENT_RETENTION_SEC = 90 * 24 * 60 * 60;
const EVENT_PRUNE_RATE = 0.02;

export type PetRow = typeof petState.$inferSelect;

export const PET_EVENT_KINDS = ['chat', 'feed', 'poke', 'sleep', 'wake'] as const;
export type PetEventKind = (typeof PET_EVENT_KINDS)[number];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 按离开时长做衰减；返回「假如现在就结算」的值，调用方决定要不要写库 */
export function settlePetState(row: PetRow, nowSec: number) {
  const last = row.lastInteraction || 0;
  const awaySec = last ? Math.max(0, nowSec - last) : 0;
  const awayHours = round1(Math.min(240, awaySec / 3600));
  let energy = row.energy;
  let satiety = row.satiety;
  let boredom = row.boredom;
  let mood = row.mood;
  if (awayHours > 3) {
    energy = Math.max(18, energy - Math.min(46, awayHours * 1.8));
    satiety = Math.max(12, satiety - Math.min(50, awayHours * 2.2));
    boredom = Math.min(96, boredom + Math.min(60, awayHours * 1.6));
    mood = awayHours > 12 ? '有点想你' : boredom > 70 ? '无聊' : '平静';
  }
  const asleep = row.asleep
    ? 1
    : last && nowSec - last > IDLE_SLEEP_SEC
      ? 1
      : 0;
  return {
    mood,
    energy: round1(clamp(energy, 0, 100)),
    satiety: round1(clamp(satiety, 0, 100)),
    boredom: round1(clamp(boredom, 0, 100)),
    asleep,
    awayHours,
    asleepSince: asleep ? row.asleepSince || last || nowSec : 0,
  };
}

/** 读取全站共用那一行；没有就先建一行默认值 */
export async function loadPetRow(env: Env): Promise<PetRow> {
  const db = createDb(env);
  await db.insert(petState).values({ id: PET_ROW_ID }).onConflictDoNothing();
  const rows = await db.select().from(petState).where(eq(petState.id, PET_ROW_ID)).limit(1);
  return rows[0]!;
}

export interface PetContext {
  mood: string;
  energy: number;
  satiety: number;
  boredom: number;
  asleep: boolean;
  awayHours: number;
  interactions: number;
  pets: number;
}

/** 给 AI 提示词用的轻量状态：读失败就当没有，不影响主流程 */
export async function readPetContext(env: Env): Promise<PetContext | null> {
  try {
    const row = await loadPetRow(env);
    const s = settlePetState(row, Math.floor(Date.now() / 1000));
    return {
      mood: s.mood,
      energy: s.energy,
      satiety: s.satiety,
      boredom: s.boredom,
      asleep: Boolean(s.asleep),
      awayHours: s.awayHours,
      interactions: row.interactions,
      pets: row.pets,
    };
  } catch (e) {
    console.warn('[zero-api] 读取鲸鱼娘状态失败：', e instanceof Error ? e.message : String(e));
    return null;
  }
}

export interface SiteTimeContext {
  /** 2026-11-24 周一 14:05（下午） */
  label: string;
  hour: number;
  period: string;
  weekday: string;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** 按站点统计时区算「现在」；默认东八区，和后台「日界时区偏移」保持同一口径 */
export async function siteTimeContext(env: Env, now = new Date()): Promise<SiteTimeContext> {
  const offset = await getConfigInt(env, 'statsUtcOffsetHours', 8);
  const local = new Date(now.getTime() + offset * 3600_000);
  const hour = local.getUTCHours();
  const minute = local.getUTCMinutes();
  const period =
    hour < 5 ? '凌晨' : hour < 8 ? '清晨' : hour < 11 ? '上午' : hour < 13 ? '中午' : hour < 17 ? '下午' : hour < 19 ? '傍晚' : hour < 23 ? '晚上' : '深夜';
  const pad = (n: number) => String(n).padStart(2, '0');
  const weekday = `周${WEEKDAYS[local.getUTCDay()]}`;
  return {
    label: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${weekday} ${pad(hour)}:${pad(minute)}（${period}）`,
    hour,
    period,
    weekday,
  };
}

export interface PetEventInput {
  kind: PetEventKind;
  question?: string;
  reply?: string;
  page?: string;
  section?: string;
  mood?: string;
  trigger?: string;
}

function cut(value: string | undefined, max: number): string | null {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** 写入一条互动记录；记录失败不影响互动本身，只留一条日志 */
export async function logPetEvent(env: Env, input: PetEventInput): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const db = createDb(env);
    await db.insert(petEvents).values({
      id: newId(),
      kind: input.kind,
      question: cut(input.question, 500),
      reply: cut(input.reply, 500),
      page: cut(input.page, 120),
      section: cut(input.section, 24),
      mood: cut(input.mood, 20),
      trigger: cut(input.trigger, 20),
      createdAt: now,
    });
    // 记录量不大，但公开接口可以刷；低频顺手清掉过期记录，别让表无限长
    if (Math.random() < EVENT_PRUNE_RATE) {
      await db.delete(petEvents).where(lt(petEvents.createdAt, now - EVENT_RETENTION_SEC));
    }
  } catch (e) {
    console.warn('[zero-api] 写入鲸鱼娘互动记录失败：', e instanceof Error ? e.message : String(e));
  }
}

export interface PetEventListOptions {
  kind?: PetEventKind | 'all';
  limit?: number;
  offset?: number;
}

export async function listPetEvents(env: Env, opts: PetEventListOptions = {}) {
  const db = createDb(env);
  const limit = Math.max(1, Math.min(100, opts.limit ?? 30));
  const offset = Math.max(0, opts.offset ?? 0);
  const kind = opts.kind && opts.kind !== 'all' ? opts.kind : null;
  const where = kind ? eq(petEvents.kind, kind) : sql`1 = 1`;
  const [rows, totals, grouped] = await Promise.all([
    db
      .select()
      .from(petEvents)
      .where(where)
      .orderBy(desc(petEvents.createdAt), desc(petEvents.id))
      .limit(limit)
      .offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(petEvents).where(where),
    db.select({ kind: petEvents.kind, n: sql<number>`count(*)` }).from(petEvents).groupBy(petEvents.kind),
  ]);
  const counts: Record<PetEventKind, number> = { chat: 0, feed: 0, poke: 0, sleep: 0, wake: 0 };
  for (const row of grouped) {
    if ((PET_EVENT_KINDS as readonly string[]).includes(row.kind)) counts[row.kind as PetEventKind] = Number(row.n);
  }
  return { events: rows, total: Number(totals[0]?.n ?? 0), counts };
}
