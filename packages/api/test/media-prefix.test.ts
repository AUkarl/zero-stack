import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketPrefix, fullKey, type MediaBucket } from '../src/services/media';

const bucket = (prefix?: string): MediaBucket => ({
  id: 'r2-public',
  label: '公开 R2',
  kind: 'r2',
  binding: 'R2_PUBLIC',
  prefix,
});

test('媒体前缀：桶 prefix 与请求前缀相同不会拼成两层', () => {
  const b = bucket('uploads/');
  assert.equal(bucketPrefix(b), 'uploads/');
  assert.equal(fullKey(b, 'uploads/'), 'uploads/');
  assert.equal(fullKey(b, 'uploads/2026-11-01/a.webp'), 'uploads/2026-11-01/a.webp');
});

test('媒体前缀：请求前缀是相对词时补一次桶前缀', () => {
  const b = bucket('media');
  assert.equal(fullKey(b, 'uploads/'), 'media/uploads/');
  assert.equal(fullKey(b, '/uploads/a.webp'), 'media/uploads/a.webp');
});

test('媒体前缀：桶没有 prefix 时请求前缀原样使用', () => {
  assert.equal(fullKey(bucket(), 'uploads/'), 'uploads/');
  assert.equal(fullKey(bucket(), '/uploads/a.webp'), 'uploads/a.webp');
});
