import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { InMemoryHistory } from '../src/agent/conversation/history.ts';
import { InMemoryStore } from '../src/agent/memory/store.ts';
import { ProviderRegistry } from '../src/agent/provider/provider.ts';
import { ContextBuilder } from '../src/agent/runtime/context.ts';
import { AgentRuntime } from '../src/agent/runtime/runtime.ts';
import { AgentRunError, type RuntimeEvent } from '../src/agent/runtime/event.ts';
import { ToolRegistry } from '../src/agent/tool/registry.ts';
import type { ChatResponse, Provider } from '../src/agent/provider/provider.ts';

test('runtime retains ordered tool history and isolates session memory', async () => {
  const requests: unknown[] = [];
  const answers: ChatResponse[] = [
    { content: '', toolCalls: [{ id: 'call_1', name: 'remember', arguments: '{"content":"cash reserve"}' }], reasoning: [], usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'tool_calls' },
    { content: 'Recorded.', toolCalls: [], reasoning: [], usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 }, finishReason: 'stop' },
  ];
  const provider: Provider = { async chat(request) { requests.push(request); return answers.shift()!; } };
  const providers = new ProviderRegistry();
  providers.register('test', provider);
  const memory = new InMemoryStore();
  const tools = new ToolRegistry();
  tools.register({ name: 'remember', description: 'Remember a preference', usage: 'Use when asked to remember.', effect: 'session_write', schema: z.object({ content: z.string() }), async execute(input, context) { return { item: await memory.add(context.sessionId, input.content, context.signal) }; } });
  const history = new InMemoryHistory();
  const runtime = new AgentRuntime({ provider: 'test', model: 'mock' }, providers, { prompt: { intro: 'Agent' }, tools }, history);
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.run('session-a', 'Remember cash reserve')) events.push(event);
  assert.equal(events.at(-1)?.type, 'run.completed');
  assert.equal((requests[1] as { messages: { role: string; toolCallId?: string }[] }).messages.at(-1)?.toolCallId, 'call_1');
  const saved = await history.list('session-a');
  assert.equal(saved[1]?.trace?.steps[1]?.kind, 'tool');
  assert.deepEqual((await memory.search('session-b', 'cash')).length, 0);
  const context = await runtime.buildContext('session-a', 'What did I save?');
  assert.ok(context.some(message => message.role === 'tool' && message.toolCallId === 'call_1'));
});

test('compaction keeps complete recent turns and does not advance on failure', async () => {
  const history = new InMemoryHistory();
  for (const [role, content] of [['user', 'one'], ['assistant', 'answer one'], ['user', 'two'], ['assistant', 'answer two']] as const) {
    await history.append('s', { role, content });
  }
  const builder = new ContextBuilder(history, { intro: 'Agent' }, new ToolRegistry(), 4, 1, {
    async compact() { return 'summary one'; },
  });
  const messages = await builder.build('s', 'three');
  assert.equal(messages[1]?.role, 'context');
  assert.deepEqual(messages.slice(2).map(message => message.content), ['two', 'answer two', 'three']);
  assert.equal((await history.snapshot('s')).summary.throughSequence, 2);

  for (const [role, content] of [['user', 'three'], ['assistant', 'answer three']] as const) await history.append('s', { role, content });
  const failed = new ContextBuilder(history, { intro: 'Agent' }, new ToolRegistry(), 1, 1, { async compact() { throw Error('unavailable'); } });
  await assert.rejects(failed.compact('s'));
  assert.equal((await history.snapshot('s')).summary.throughSequence, 2);
});

test('runtime stops on AbortSignal without storing an unfinished assistant response', async () => {
  const controller = new AbortController();
  const providers = new ProviderRegistry();
  providers.register('test', { async chat() { controller.abort(); throw new Error('aborted'); } });
  const history = new InMemoryHistory();
  const runtime = new AgentRuntime({ provider: 'test', model: 'mock' }, providers, { prompt: { intro: 'Agent' }, tools: new ToolRegistry() }, history);
  const events: RuntimeEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of runtime.run('s', 'Answer this', controller.signal)) events.push(event);
  }, error => error instanceof AgentRunError && error.code === 'aborted');
  assert.equal(events.at(-1)?.type, 'run.error');
  assert.equal((events.at(-1) as Extract<RuntimeEvent, { type: 'run.error' }>).code, 'aborted');
  assert.deepEqual((await history.list('s')).map(message => message.role), ['user']);
});
