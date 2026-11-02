import test from 'node:test';
import assert from 'node:assert/strict';
import { commitIdentity } from '../src/adapters/github';

test('内容仓库提交身份使用 owner 的 GitHub noreply，不落私人邮箱', () => {
  const id = commitIdentity('AUkarl');
  assert.deepEqual(id, { name: 'AUkarl', email: 'AUkarl@users.noreply.github.com' });
  assert.ok(!/@(qq|163|gmail|outlook)\.com$/i.test(id.email));
});

test('owner 为空时用中性的 zero-cms 身份，仍不落私人邮箱', () => {
  assert.deepEqual(commitIdentity(''), { name: 'zero-cms', email: 'zero-cms@users.noreply.github.com' });
});
