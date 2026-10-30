import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md5Hex } from '../src/lib/md5';

/* 百度翻译的签名依赖 MD5：这几个已知向量必须对，否则每次请求都会被判签名错误 */
test('md5Hex：RFC 已知向量', () => {
  assert.equal(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5Hex('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
});

test('md5Hex：UTF-8 中文按字节算（不是按码点）', () => {
  assert.equal(md5Hex('中文'), 'a7bac2239fcdcb3a067903d8077c4a07');
});

test('md5Hex：长输入跨多个 64 字节块', () => {
  assert.equal(md5Hex('a'.repeat(1000)), 'cabe45dcc9ae5b66ba86600cca6b8ba8');
});
