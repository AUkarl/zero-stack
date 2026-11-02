import test from 'node:test';
import assert from 'node:assert/strict';
import { isFinalAiReply, parseAiReplyScope, shouldAiReply, type AiReplyGate } from '../src/services/ai';

const gate = (over: Partial<AiReplyGate> = {}): AiReplyGate => ({
  scope: 'all',
  topLevel: true,
  trusted: false,
  parentIsAi: false,
  question: false,
  ...over,
});

test('AI 回复范围：四档的顶层与楼中楼边界', () => {
  /* all：只回顶层，楼中楼一律不碰 */
  assert.equal(shouldAiReply(gate()), true);
  assert.equal(shouldAiReply(gate({ trusted: true })), false);
  assert.equal(shouldAiReply(gate({ topLevel: false, parentIsAi: true })), false);

  /* questions：只回顶层提问 */
  assert.equal(shouldAiReply(gate({ scope: 'questions', question: true })), true);
  assert.equal(shouldAiReply(gate({ scope: 'questions', question: false })), false);
  assert.equal(shouldAiReply(gate({ scope: 'questions', topLevel: false, parentIsAi: true, question: true })), false);

  /* conversation：顶层全回；楼中楼只续接直接回复 AI 的那条 */
  assert.equal(shouldAiReply(gate({ scope: 'conversation', topLevel: false, parentIsAi: true })), true);
  assert.equal(shouldAiReply(gate({ scope: 'conversation', topLevel: false, parentIsAi: false })), false);
  assert.equal(shouldAiReply(gate({ scope: 'conversation', topLevel: false, parentIsAi: true, trusted: true })), true);
  assert.equal(shouldAiReply(gate({ scope: 'conversation', topLevel: true, trusted: true })), false);

  /* every：顶层 + 所有层级；管理员只在直接回复 AI 时触发 */
  assert.equal(shouldAiReply(gate({ scope: 'every', topLevel: false, parentIsAi: false })), true);
  assert.equal(shouldAiReply(gate({ scope: 'every', topLevel: false, parentIsAi: false, trusted: true })), false);
  assert.equal(shouldAiReply(gate({ scope: 'every', topLevel: false, parentIsAi: true, trusted: true })), true);
  assert.equal(shouldAiReply(gate({ scope: 'every', topLevel: true, trusted: true })), false);
});

test('AI 回复最后一层：只有正好到上限才算收尾', () => {
  assert.equal(isFinalAiReply(2, 6), false);
  assert.equal(isFinalAiReply(5, 6), false);
  assert.equal(isFinalAiReply(6, 6), true);
  assert.equal(isFinalAiReply(7, 6), true);
  assert.equal(isFinalAiReply(6, 0), false);
});

test('AI 回复范围：未知值落回 all', () => {
  assert.equal(parseAiReplyScope('all'), 'all');
  assert.equal(parseAiReplyScope('questions'), 'questions');
  assert.equal(parseAiReplyScope('conversation'), 'conversation');
  assert.equal(parseAiReplyScope('every'), 'every');
  assert.equal(parseAiReplyScope(''), 'all');
  assert.equal(parseAiReplyScope(null), 'all');
  assert.equal(parseAiReplyScope(undefined), 'all');
  assert.equal(parseAiReplyScope('bogus'), 'all');
});
