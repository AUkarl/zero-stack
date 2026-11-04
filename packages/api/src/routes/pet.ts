/**
 * AI PET 设置：后台「互动 → AI PET」页读写站点内容仓库的 data/pet.json。
 *
 * 这里只负责持久化和构建体检；前台怎么解释这些字段在 zero-site 的
 * static/whale-pet/site-pet.js 里。字段全部是标量，避免 Hugo 构建期读 data 时被
 * 非标量覆盖打挂（同一个坑见 frontend.ts 的写盘注释）。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { buildHealthReceipt, readRepoFile, repoBackend, runLocalBuildCheck, writeRepoFile } from '../services/repo';
import { getConfig } from '../services/config';
import { requireAdmin } from '../middleware/auth';
import { buildReceipt, triggerPagesBuild } from '../services/git';
import { clientIp } from '../lib/http';
import { fail, ok } from '../lib/errors';
import { zodZh } from '../lib/zmsg';
import type { AppEnv } from '../lib/app';

const DEFAULTS = {
  enabled: true,
  size: 'm' as const,
  corner: 'left' as const,
  mobileMode: 'full' as const,
  autoActions: true,
  idleMin: 6,
  idleMax: 14,
  aiEnabled: true,
  greetingEnabled: true,
  clickReaction: true,
  feedEnabled: true,
  sleepEnabled: true,
  dragEnabled: true,
  dockEnabled: true,
  scrollReaction: true,
  likeReaction: true,
  commentReaction: true,
  backTopReaction: true,
  creditEnabled: true,
};

const baseSchema = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  size: z.enum(['s', 'm', 'l']).default(DEFAULTS.size),
  corner: z.enum(['left', 'right']).default(DEFAULTS.corner),
  mobileMode: z.enum(['mini', 'full', 'hidden']).default(DEFAULTS.mobileMode),
  autoActions: z.boolean().default(DEFAULTS.autoActions),
  idleMin: z.coerce.number().int().min(3).max(120).default(DEFAULTS.idleMin),
  idleMax: z.coerce.number().int().min(3).max(180).default(DEFAULTS.idleMax),
  aiEnabled: z.boolean().default(DEFAULTS.aiEnabled),
  greetingEnabled: z.boolean().default(DEFAULTS.greetingEnabled),
  clickReaction: z.boolean().default(DEFAULTS.clickReaction),
  feedEnabled: z.boolean().default(DEFAULTS.feedEnabled),
  sleepEnabled: z.boolean().default(DEFAULTS.sleepEnabled),
  dragEnabled: z.boolean().default(DEFAULTS.dragEnabled),
  dockEnabled: z.boolean().default(DEFAULTS.dockEnabled),
  scrollReaction: z.boolean().default(DEFAULTS.scrollReaction),
  likeReaction: z.boolean().default(DEFAULTS.likeReaction),
  commentReaction: z.boolean().default(DEFAULTS.commentReaction),
  backTopReaction: z.boolean().default(DEFAULTS.backTopReaction),
  creditEnabled: z.boolean().default(DEFAULTS.creditEnabled),
});

const schema = baseSchema.refine((v) => v.idleMax >= v.idleMin, '自动动作的最大间隔不能小于最小间隔');

type PetConfig = z.infer<typeof baseSchema>;

const app = new Hono<AppEnv>();

async function dataDir(env: Env): Promise<string> {
  const dir = (await getConfig(env, 'githubDataDir')) || 'data';
  return dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

app.get('/', async (c) => {
  requireAdmin(c);
  const dir = await dataDir(c.env);
  const path = `${dir}/pet.json`;
  let saved: Partial<PetConfig> = {};
  let fileFound = false;
  try {
    const file = await readRepoFile(c.env, path);
    if (file?.content) {
      fileFound = true;
      const parsed = baseSchema.partial().safeParse(JSON.parse(file.content));
      if (parsed.success) saved = parsed.data;
    }
  } catch {
    /* 仓库没配也能先看默认值，真正保存时再报错 */
  }
  return ok({
    data: { ...DEFAULTS, ...saved },
    defaults: DEFAULTS,
    path,
    fileFound,
    backend: await repoBackend(c.env),
  });
});

app.post('/', async (c) => {
  const admin = requireAdmin(c);
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, `AI PET 设置不合法：${zodZh(parsed.error, '字段不合法')}`);
  const dir = await dataDir(c.env);
  const path = `${dir}/pet.json`;
  const content = JSON.stringify(parsed.data, null, 2) + '\n';
  const result = await writeRepoFile(c.env, path, content, 'zero-cms: 更新 AI PET 设置', {
    actor: admin,
    ip: clientIp(c),
    action: 'params',
  });
  if (!result.success) fail(502, `AI PET 设置写入失败：${result.error ?? '未知错误'}`);
  const build = await triggerPagesBuild(c.env);
  const health = await runLocalBuildCheck(c.env);
  return ok({
    data: parsed.data,
    path,
    written: [path],
    build,
    buildHealth: health,
    message: buildReceipt(build, 'AI PET 设置已保存') + buildHealthReceipt(health),
  });
});

export default app;
