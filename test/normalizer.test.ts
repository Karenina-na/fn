import assert from 'node:assert/strict';
import test from 'node:test';
import { normalize } from '../src/agent/conversation/compact/normalizer.ts';
import type { Message } from '../src/agent/conversation/message.ts';

test('compaction drops unreferenced failures and keeps the latest successful tool result', () => {
  const messages: Message[] = [{ id: 'm1', role: 'assistant', content: 'Done.', sequence: 1, createdAt: new Date(), trace: {
    finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, steps: [
      { id: 'bad', kind: 'tool', status: 'error', name: 'lookup', input: { id: 1 }, output: { error: 'temporary outage' } },
      { id: 'good1', kind: 'tool', status: 'complete', name: 'lookup', input: { id: 1 }, output: { value: 10 } },
      { id: 'good2', kind: 'tool', status: 'complete', name: 'lookup', input: { id: 1 }, output: { value: 10 } },
      { id: 'bad2', kind: 'tool', status: 'error', name: 'other', input: {}, output: { error: '' } },
    ],
  } }];
  assert.deepEqual(normalize(messages)[0]?.tools?.map(tool => tool.id), ['good2']);
});

test('compaction deduplicates large identical tool outputs before bounding them', () => {
  const output = { body: 'x'.repeat(3000) };
  const messages: Message[] = [{ id: 'm2', role: 'assistant', content: 'Read.', sequence: 2, createdAt: new Date(), trace: {
    finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, steps: [
      { id: 'first', kind: 'tool', status: 'complete', name: 'read', input: {}, output },
      { id: 'second', kind: 'tool', status: 'complete', name: 'read', input: {}, output },
    ],
  } }];
  assert.deepEqual(normalize(messages)[0]?.tools?.map(tool => tool.id), ['second']);
});

test('compaction treats object key order as equivalent for repeated attempts', () => {
  const messages: Message[] = [{ id: 'm3', role: 'assistant', content: 'Read.', sequence: 3, createdAt: new Date(), trace: {
    finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, steps: [
      { id: 'first', kind: 'tool', status: 'complete', name: 'read', input: { a: 1, b: 2 }, output: { x: 1, y: 2 } },
      { id: 'second', kind: 'tool', status: 'complete', name: 'read', input: { b: 2, a: 1 }, output: { y: 2, x: 1 } },
    ],
  } }];
  assert.deepEqual(normalize(messages)[0]?.tools?.map(tool => tool.id), ['second']);
});
