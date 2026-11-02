import test from 'node:test';
import assert from 'node:assert/strict';
import { isHttpUrl, optionalHttpUrlField } from '../src/lib/httpUrl';

test('网址判据：正常的公网地址通过', () => {
  assert.equal(isHttpUrl('https://example.com'), true);
  assert.equal(isHttpUrl('http://example.com/path?q=1'), true);
});

test('网址判据：localhost 与单段主机名也通过（本地联调）', () => {
  assert.equal(isHttpUrl('http://localhost:8787'), true);
  assert.equal(isHttpUrl('http://127.0.0.1:1315/'), true);
  assert.equal(isHttpUrl('http://intranet/'), true);
});

test('网址判据：非 http(s)、带空格、空主机仍拒绝', () => {
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('https://exa mple.com'), false);
  assert.equal(isHttpUrl('http://'), false);
});

test('可选网址：留空放行，填了仍走同一判据', () => {
  const field = optionalHttpUrlField();
  assert.equal(field.safeParse('').success, true);
  assert.equal(field.safeParse(undefined).success, true);
  assert.equal(field.safeParse('http://localhost:1315').success, true);
  assert.equal(field.safeParse('javascript:alert(1)').success, false);
});
