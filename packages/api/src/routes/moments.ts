import { Hono } from 'hono';
import { getConfigBool } from '../services/config';
import { ok } from '../lib/errors';
import type { AppEnv } from '../lib/app';

/**
 * 时刻（说说）：正文就是仓库 content/zh/moments 下的 Markdown，由 Hugo 构建成页面，
 * 写入统一走后台的内容接口。这里只留一个开关状态，供前端判断导航入口与页面显隐。
 */
const app = new Hono<AppEnv>();

app.get('/', async (c) => {
  if (!(await getConfigBool(c.env, 'momentsEnabled', true))) return ok({ moments: [], notice: '时刻功能已关闭' });
  return ok({
    moments: [],
    notice: '时刻内容已改为仓库 content/zh/moments 下的 Markdown，由 Hugo 构建输出',
  });
});

export default app;
