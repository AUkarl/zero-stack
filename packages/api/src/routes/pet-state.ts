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
import { loadPetRow, logPetEvent, PET_ROW_ID, settlePetState, type PetEventKind, type PetRow } from '../services/pet';
import type { AppEnv } from '../lib/app';

const app = new Hono<AppEnv>();

/** 给前端的形状：时间和客户端一致用毫秒，省得两边换单位 */
function toClient(row: PetRow, s: ReturnType<typeof settlePetState>) {
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

/** 公开只读：不写库，不改变任何状态 */
app.get('/state', async (c) => {
  rateLimitLocal(c, 'pet-state-read', 240, 60);
  const row = await loadPetRow(c.env);
  const nowSec = Math.floor(Date.now() / 1000);
  const s = settlePetState(row, nowSec);
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

  const row = await loadPetRow(c.env);
  const nowSec = Math.floor(Date.now() / 1000);
  const s = settlePetState(row, nowSec);
  let { mood, energy, satiety, boredom } = s;
  let interactions = row.interactions;
  let pets = row.pets;
  let asleep = s.asleep;
  let asleepSince = s.asleepSince;

  if (action === 'poke') {
    interactions += 1;
    pets += 1;
    boredom = Math.max(0, boredom - 7);
    energy = Math.max(0, energy - 0.5);
    satiety = Math.max(0, satiety - 0.2);
    mood = '开心';
    asleep = 0;
    asleepSince = 0;
  } else if (action === 'feed') {
    interactions += 1;
    satiety = Math.min(100, satiety + 32);
    energy = Math.min(100, energy + 4);
    boredom = Math.max(0, boredom - 12);
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
    energy: Math.round(energy * 10) / 10,
    satiety: Math.round(satiety * 10) / 10,
    boredom: Math.round(boredom * 10) / 10,
    interactions,
    pets,
    asleep,
    asleepSince,
    lastInteraction: nowSec,
    updatedAt: nowSec,
  };
  const db = createDb(c.env);
  await db.update(petState).set(next).where(eq(petState.id, PET_ROW_ID));
  const saved: PetRow = { ...row, ...next, id: PET_ROW_ID };

  // 互动记录在后台 AI PET 里看；写入失败不影响互动本身
  const logged = logPetEvent(c.env, {
    kind: action as PetEventKind,
    mood,
    trigger: action,
  });
  try {
    c.executionCtx.waitUntil(logged);
  } catch {
    void logged;
  }

  c.header('Cache-Control', 'no-store');
  return ok({ state: toClient(saved, settlePetState(saved, nowSec)) });
});

export default app;
