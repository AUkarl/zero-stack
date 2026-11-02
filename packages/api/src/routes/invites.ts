import { Hono } from 'hono';
import { z } from 'zod';
import { activeInviteCount, createInvite, inviteUsage, listInvites, revokeInvite } from '../services/invites';
import { writeAudit } from '../services/audit';
import { requireAdmin } from '../middleware/auth';
import { clientIp } from '../lib/http';
import { fail, ok } from '../lib/errors';
import type { AppEnv } from '../lib/app';

/**
 * 邀请码管理（挂在 /api/admin/invites，已由 index.ts 的 requireAdmin 兜住）。
 * 生成、列表、作废、查看某码招了谁。
 */
const app = new Hono<AppEnv>();

app.get('/', (c) => listInvites(c.env).then((rows) => ok(rows)));

app.get('/summary', (c) => activeInviteCount(c.env).then((n) => ok({ active: n })));

app.post('/', async (c) => {
  const admin = requireAdmin(c);
  const parsed = z
    .object({
      note: z.string().max(200).optional(),
      uses: z.number().int().min(0).max(100000).optional(),
      days: z.number().int().min(0).max(3650).optional(),
      /** 批量生成，默认 1；一次最多 50 个，免得后台手滑 */
      count: z.number().int().min(1).max(50).default(1),
      code: z.string().max(64).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) fail(400, '参数有误：次数取 0-100000，天数取 0-3650');
  const { note, uses, days, count, code } = parsed.data;
  if (count > 1 && code) fail(400, '批量生成时不能指定自定义码');

  const created = [];
  for (let i = 0; i < count; i++) {
    const row = await createInvite(c.env, { note, uses, days, code });
    await writeAudit(c.env, {
      actor: admin,
      action: 'invite',
      target: row.id,
      detail: { code: row.code, maxUses: row.maxUses, expiresAt: row.expiresAt, note: note ?? null },
      ip: clientIp(c),
    });
    created.push(row);
  }
  return ok(created.length === 1 ? created[0] : created);
});

app.post('/:id/revoke', async (c) => {
  const admin = requireAdmin(c);
  await revokeInvite(c.env, c.req.param('id'));
  await writeAudit(c.env, {
    actor: admin,
    action: 'invite',
    target: c.req.param('id'),
    detail: { revoked: true },
    ip: clientIp(c),
  });
  return ok({ revoked: true });
});

app.get('/:id/usage', (c) => inviteUsage(c.env, c.req.param('id')).then((rows) => ok(rows)));

export default app;
