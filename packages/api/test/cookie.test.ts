import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionCookie } from '../src/middleware/auth';

test('同站/HTTP 会话 Cookie 保持 Lax', () => {
  assert.match(sessionCookie('t', 60, true), /SameSite=Lax/);
  assert.match(sessionCookie('t', 60, false, true), /SameSite=Lax/);
});

test('跨站 HTTPS 会话 Cookie 改成 None + Secure', () => {
  const c = sessionCookie('t', 60, true, true);
  assert.match(c, /SameSite=None/);
  assert.match(c, /Secure/);
});
