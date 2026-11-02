import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDateCst } from '../src/lib/datetime';

/* 投稿审核拼出来的 date 必须和后台编辑器同一种写法（+08:00），时刻本身不许变 */
test('isoDateCst：输出 +08:00 写法，且与同一时刻等值', () => {
  const ts = 1790000000; // 2026-09-21T14:13:20Z
  const out = isoDateCst(ts);
  assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/);
  assert.equal(new Date(out).getTime(), ts * 1000);
  assert.equal(out.slice(0, 19), new Date((ts + 8 * 3600) * 1000).toISOString().slice(0, 19));
});

test('isoDateCst：同一时刻换成东八区写法（UTC 15:07 → 当日 23:07；UTC 18:28 → 次日 02:28）', () => {
  assert.equal(isoDateCst(Date.UTC(2026, 9, 2, 15, 7, 0) / 1000), '2026-10-02T23:07:00+08:00');
  assert.equal(isoDateCst(Date.UTC(2026, 8, 11, 18, 28, 0) / 1000), '2026-09-12T02:28:00+08:00');
});
