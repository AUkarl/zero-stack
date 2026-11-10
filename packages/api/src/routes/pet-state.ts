/**
 * 全场共用的桌宠状态。
 *
 * 站长口径：不按访客区分，整站一份、存在服务端；打开或切换页面只读不改写，
 * 数值接着上次，隔夜按离开时长衰减，睡觉状态保留。
 *
 * 读接口里所有「衰减/睡着」都是根据 last_interaction 现算的，**不落库**：
 * 每个访客开一页就写一次的话，一来会把「上次互动时间」刷成现在（睡着的宠物被叫醒），
 * 二来白白消耗 D1 写入额度。只有真实互动（摸/喂/睡/醒）才写。
 */
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDb } from '../db/client';
import { petState } from '../db/schema';
import { fail, ok } from '../lib/errors';
import { rateLimitLocal } from '../lib/rate-limit';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

const ROW_ID = 'global';
const IDLE_SLEEP_SEC = 300;

type Row = typeof petState.$inferSelect;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 按离开时长做衰减；返回的是「假如现在就结算」的值，调用方决定要不要写库 */
function settle(row: Row, nowSec: number) {
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

/** 给前端的形状：时间和客户端一致用毫秒，省得两边换单位 */
function toClient(row: Row, s: ReturnType<typeof settle>) {
  return {
    mood: s.mood,
    energy: s.energy,
    satiety: s.satiety,
    boredom: s.boredom,
    interactions: row.interactions,
    pets: row.pets,
    asleep: !!s.asleep,
    awayHours: s.awayHours,
    lastInteraction: (row.lastInteraction || 0) * 1000,
    lastSeen: (row.updatedAt || row.lastInteraction || 0) * 1000,
  };
}

async function loadRow(env: Env) {
  const db = createDb(env);
  await db.insert(petState).values({ id: ROW_ID }).onConflictDoNothing();
  const rows = await db.select().from(petState).where(eq(petState.id, ROW_ID)).limit(1);
  return rows[0];
}

/** 公开只读：不写库，不改变任何状态 */
app.get('/state', async (c) => {
  rateLimitLocal(c, 'pet-state-read', 240, 60);
  const row = await loadRow(c.env);
  const nowSec = Math.floor(Date.now() / 1000);
  const s = settle(row, nowSec);
  c.header('Cache-Control', 'no-store');
  return ok({ state: toClient(row, s) });
});

/**
 * 真实互动才走这里。action：
 *   poke 摸一下 / feed 喂饭 / sleep 睡觉 / wake 起床
 */
app.post('/state', async (c) => {
  rateLimitLocal(c, 'pet-state-write', 120, 60);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action || '');
  if (!['poke', 'feed', 'sleep', 'wake'].includes(action)) return fail(400, '不认识的桌宠动作');

  const row = await loadRow(c.env);
  const nowSec = Math.floor(Date.now() / 1000);
  const s = settle(row, nowSec);
  let { mood, energy, satiety, boredom } = s;
  let interactions = row.interactions;
  let pets = row.pets;
  let asleep = s.asleep;
  let asleepSince = s.asleepSince;

  if (action === 'poke') {
    interactions += 1;
    pets += 1;
    boredom = clamp(boredom - 7, 0, 100);
    energy = clamp(energy - 0.5, 0, 100);
    satiety = clamp(satiety - 0.2, 0, 100);
    mood = '开心';
    asleep = 0;
    asleepSince = 0;
  } else if (action === 'feed') {
    interactions += 1;
    satiety = clamp(satiety + 32, 0, 100);
    energy = clamp(energy + 4, 0, 100);
    boredom = clamp(boredom - 12, 0, 100);
    mood = '开心';
    asleep = 0;
    asleepSince = 0;
  } else if (action === 'sleep') {
    asleep = 1;
    asleepSince = asleepSince || nowSec;
  } else if (action === 'wake') {
    asleep = 0;
    asleepSince = 0;
  }

  const next = {
    mood,
    energy: round1(energy),
    satiety: round1(satiety),
    boredom: round1(boredom),
    interactions,
    pets,
    asleep,
    asleepSince,
    lastInteraction: nowSec,
    updatedAt: nowSec,
  };
  const db = createDb(c.env);
  await db.update(petState).set(next).where(eq(petState.id, ROW_ID));
  const saved: Row = { ...row, ...next, id: ROW_ID };
  c.header('Cache-Control', 'no-store');
  return ok({ state: toClient(saved, settle(saved, nowSec)) });
});

export default app;
