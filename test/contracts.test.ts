import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { CompactionStrategy } from '../src/agent/conversation/compact/strategy.ts';
import { LLMCompactor } from '../src/agent/conversation/compact/compactor.ts';
import { InMemoryHistory } from '../src/agent/conversation/history.ts';
import { InMemoryStore } from '../src/agent/memory/store.ts';
import { memoryTools } from '../src/agent/memory/tools.ts';
import { ProviderRegistry, type ChatRequest, type ChatResponse } from '../src/agent/provider/provider.ts';
import type { RuntimeEvent } from '../src/agent/runtime/event.ts';
import { AgentRuntime } from '../src/agent/runtime/runtime.ts';
import { AgentRunError } from '../src/agent/runtime/event.ts';
import { ToolExecutor } from '../src/agent/tool/executor.ts';
import { ToolRegistry } from '../src/agent/tool/registry.ts';

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

test('zero compaction parameters use Go defaults while preserving eight recent turns', async () => {
  const history = new InMemoryHistory();
  for (let turn = 0; turn < 10; turn++) {
    await history.append('s', { role: 'user', content: `question ${turn}` });
    await history.append('s', { role: 'assistant', content: `answer ${turn}` });
  }
  const snapshot = await history.snapshot('s');
  const strategy = new CompactionStrategy(0, 0);
  assert.equal(strategy.plan(snapshot), undefined);
  const plan = strategy.plan(snapshot, true);
  assert.equal(plan?.recentTurns, 8);
  assert.equal(plan?.throughSequence, 4);
  assert.equal(plan?.recent.length, 16);
});

test('zero compactor output limit requests the Go default', async () => {
  let requested: ChatRequest | undefined;
  const compactor = new LLMCompactor({ async chat(request) {
    requested = request;
    return { content: 'summary', toolCalls: [], reasoning: [], usage, finishReason: 'stop' };
  } }, 'mock', 0);
  await compactor.compact({ previousSummary: '', messages: [] });
  assert.equal(requested?.maxOutputTokens, 1024);
});

test('memory trims item IDs on update and delete within one session', async () => {
  const store = new InMemoryStore();
  const item = await store.add('s', ' choice ');
  const updated = await store.update('s', ` ${item.id} `, ' newer choice ');
  assert.equal(updated.content, 'newer choice');
  assert.equal((await store.search('other', '')).length, 0);
  await store.delete('s', ` ${item.id} `);
  assert.deepEqual(await store.search('s', ''), []);
});

test('memory tools trim actions and queries before applying the Go input rules', async () => {
  const store = new InMemoryStore();
  const tools = new ToolRegistry();
  const [searchTool, manageTool] = memoryTools(store);
  tools.register(searchTool);
  tools.register(manageTool);
  const definitions = tools.definitions();
  const manageParameters = definitions.find(tool => tool.name === 'manage_memory')?.parameters as { properties: { action: { enum?: string[] } } };
  const searchParameters = definitions.find(tool => tool.name === 'search_memory')?.parameters as { properties: { query: { maxLength?: number } } };
  assert.deepEqual(manageParameters.properties.action.enum, ['add', 'update', 'delete']);
  assert.equal(searchParameters.properties.query.maxLength, 500);
  const executor = new ToolExecutor(tools);
  const [added] = await executor.execute([{ id: 'add', name: 'manage_memory', arguments: '{"action":" add ","content":"saved"}' }], { sessionId: 's' });
  assert.equal(added?.ok, true);
  const [withinLimit] = await executor.execute([{ id: 'search', name: 'search_memory', arguments: JSON.stringify({ query: `  ${'x'.repeat(500)}  ` }) }], { sessionId: 's' });
  assert.equal(withinLimit?.ok, true);
  const [overLimit] = await executor.execute([{ id: 'search2', name: 'search_memory', arguments: JSON.stringify({ query: '你'.repeat(167) }) }], { sessionId: 's' });
  assert.equal(overLimit?.ok, false);
});

test('runtime binds a trimmed session ID to memory tools', async () => {
  const store = new InMemoryStore();
  const tools = new ToolRegistry();
  const [searchTool, manageTool] = memoryTools(store);
  tools.register(searchTool);
  tools.register(manageTool);
  const answers: ChatResponse[] = [
    { content: '', toolCalls: [{ id: 'remember', name: 'manage_memory', arguments: '{"action":"add","content":"preferred currency CNY"}' }], reasoning: [], usage, finishReason: 'tool_calls' },
    { content: 'Saved', toolCalls: [], reasoning: [], usage, finishReason: 'stop' },
  ];
  const providers = new ProviderRegistry();
  providers.register('mock', { async chat() { return answers.shift()!; } });
  const runtime = new AgentRuntime({ provider: 'mock', model: 'mock' }, providers, { prompt: { intro: 'Agent' }, tools }, new InMemoryHistory());
  for await (const event of runtime.run(' s ', 'Remember my currency')) assert.notEqual(event.type, 'run.error');
  assert.equal((await store.search('s', 'CNY')).length, 1);
  assert.equal((await store.search(' s ', 'CNY')).length, 0);
});

test('undefined tool output becomes JSON null in events, trace, and replay', async () => {
  const requests: ChatRequest[] = [];
  const answers: ChatResponse[] = [
    { content: '', toolCalls: [{ id: 'call_1', name: 'empty', arguments: '{}' }], reasoning: [], usage, finishReason: 'tool_calls' },
    { content: 'Done', toolCalls: [], reasoning: [], usage, finishReason: 'stop' },
  ];
  const providers = new ProviderRegistry();
  providers.register('mock', { async chat(request) { requests.push(structuredClone(request)); return answers.shift()!; } });
  const tools = new ToolRegistry();
  tools.register({ name: 'empty', description: 'Return no value', usage: 'Use for the test.', effect: 'read_only', schema: z.strictObject({}), execute: () => undefined });
  const history = new InMemoryHistory();
  const runtime = new AgentRuntime({ provider: 'mock', model: 'mock' }, providers, { prompt: { intro: 'Agent' }, tools }, history);
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.run('s', 'Call empty')) events.push(event);
  const toolEvent = events.find(event => event.type === 'tool.completed');
  assert.equal(toolEvent?.output, null);
  assert.equal(requests[1]?.messages.at(-1)?.content, 'null');
  const trace = (await history.list('s'))[1]?.trace;
  assert.equal(trace?.steps[1]?.kind === 'tool' && trace.steps[1].output, null);
  assert.ok((await runtime.buildContext('s', 'Again')).some(message => message.role === 'tool' && message.content === 'null'));
});

test('parallel tool results retain call order in events, provider history, and trace', async () => {
  let releaseFirst!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const providers = new ProviderRegistry();
  const requests: ChatRequest[] = [];
  const answers: ChatResponse[] = [
    { content: '', toolCalls: [
      { id: 'first', name: 'slow', arguments: '{}' },
      { id: 'second', name: 'fast', arguments: '{}' },
    ], reasoning: [], usage, finishReason: 'tool_calls' },
    { content: 'Done', toolCalls: [], reasoning: [], usage, finishReason: 'stop' },
  ];
  providers.register('mock', { async chat(request) { requests.push(structuredClone(request)); return answers.shift()!; } });
  const tools = new ToolRegistry();
  tools.register({ name: 'slow', description: 'Slow read', usage: 'Read slowly.', effect: 'read_only', schema: z.strictObject({}), async execute() { await gate; return { value: 1 }; } });
  tools.register({ name: 'fast', description: 'Fast read', usage: 'Read quickly.', effect: 'read_only', schema: z.strictObject({}), execute() { releaseFirst(); return { value: 2 }; } });
  const history = new InMemoryHistory();
  const runtime = new AgentRuntime({ provider: 'mock', model: 'mock' }, providers, { prompt: { intro: 'Agent' }, tools }, history);
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.run('s', 'Call both')) events.push(event);
  assert.deepEqual(events.filter(event => event.type === 'tool.completed').map(event => event.callId), ['first', 'second']);
  assert.deepEqual(requests[1]?.messages.filter(message => message.role === 'tool').map(message => message.toolCallId), ['first', 'second']);
  assert.deepEqual((await history.list('s'))[1]?.trace?.steps.filter(step => step.kind === 'tool').map(step => step.id), ['first', 'second']);
});

test('write and destructive effects never execute without a grant', async () => {
  let executions = 0;
  const tools = new ToolRegistry();
  for (const effect of ['write', 'destructive'] as const) tools.register({
    name: effect, description: effect, usage: effect, effect, schema: z.strictObject({}),
    execute: () => { executions++; return {}; },
  });
  const results = await new ToolExecutor(tools).execute([
    { id: 'c1', name: 'write', arguments: '{}' },
    { id: 'c2', name: 'destructive', arguments: '{}' },
  ], { sessionId: 's' });
  assert.equal(executions, 0);
  assert.deepEqual(results.map(result => result.ok), [false, false]);
});

test('provider error finish reason ends with a detectable failure event', async () => {
  const providers = new ProviderRegistry();
  providers.register('mock', { async chat() { return { content: '', toolCalls: [], reasoning: [], usage, finishReason: 'error' }; } });
  const runtime = new AgentRuntime({ provider: 'mock', model: 'mock' }, providers, { prompt: { intro: 'Agent' }, tools: new ToolRegistry() }, new InMemoryHistory());
  const events: RuntimeEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of runtime.run('s', 'Hello')) events.push(event);
  }, error => error instanceof AgentRunError && error.code === 'runtime_error');
  assert.equal(events.at(-1)?.type, 'run.error');
  assert.ok(!events.some(event => event.type === 'run.completed'));
});

test('a failed run rejects its AsyncIterable after emitting run.error', async () => {
  const providers = new ProviderRegistry();
  providers.register('mock', { async chat() { throw new Error('provider unavailable'); } });
  const runtime = new AgentRuntime({ provider: 'mock', model: 'mock' }, providers, { prompt: { intro: 'Agent' }, tools: new ToolRegistry() }, new InMemoryHistory());
  const events: RuntimeEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of runtime.run('s', 'Hello')) events.push(event);
  }, error => error instanceof AgentRunError && error.code === 'runtime_error' && error.message === 'provider unavailable');
  assert.equal(events.at(-1)?.type, 'run.error');
  assert.ok(!events.some(event => event.type === 'run.completed'));
});

test('runtime can be constructed before provider registration and resolves it when run starts', async () => {
  const providers = new ProviderRegistry();
  const history = new InMemoryHistory();
  const runtime = new AgentRuntime({ provider: 'late', model: 'mock' }, providers, { prompt: { intro: 'Agent' }, tools: new ToolRegistry() }, history);
  providers.register('late', { async chat() { return { content: 'Ready', toolCalls: [], reasoning: [], usage, finishReason: 'stop' }; } });
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.run('s', 'Hello')) events.push(event);
  assert.equal(events.at(-1)?.type, 'run.completed');
  assert.deepEqual((await history.list('s')).map(message => message.content), ['Hello', 'Ready']);
});

test('late provider registration also supports compaction when a run starts', async () => {
  const providers = new ProviderRegistry();
  const history = new InMemoryHistory();
  for (const [role, content] of [['user', 'old question'], ['assistant', 'old answer'], ['user', 'recent question'], ['assistant', 'recent answer']] as const) {
    await history.append('s', { role, content });
  }
  const runtime = new AgentRuntime({ provider: 'late', model: 'mock', historyLimit: 4, compactionRecentTurns: 1 },
    providers, { prompt: { intro: 'Agent' }, tools: new ToolRegistry() }, history);
  const answers: ChatResponse[] = [
    { content: 'Older state', toolCalls: [], reasoning: [], usage, finishReason: 'stop' },
    { content: 'Current answer', toolCalls: [], reasoning: [], usage, finishReason: 'stop' },
  ];
  providers.register('late', { async chat() { return answers.shift()!; } });
  const events: RuntimeEvent[] = [];
  for await (const event of runtime.run('s', 'Current question')) events.push(event);
  assert.equal(events.at(-1)?.type, 'run.completed');
  assert.equal((await history.snapshot('s')).summary.throughSequence, 2);
});

test('missing provider fails at run time without saving a user message', async () => {
  const history = new InMemoryHistory();
  const runtime = new AgentRuntime({ provider: 'missing', model: 'mock' }, new ProviderRegistry(), { prompt: { intro: 'Agent' }, tools: new ToolRegistry() }, history);
  const events: RuntimeEvent[] = [];
  await assert.rejects(async () => {
    for await (const event of runtime.run('s', 'Hello')) events.push(event);
  }, error => error instanceof AgentRunError && error.message.includes('not registered'));
  assert.deepEqual(events.map(event => event.type), ['run.error']);
  assert.deepEqual(await history.list('s'), []);
});

test('tool registration rejects invalid effects and non-object parameter schemas', () => {
  const tools = new ToolRegistry();
  const base = { name: 'inspect', description: 'Inspect data', usage: 'Read data.', schema: z.strictObject({}), execute: () => ({}) };
  assert.throws(() => tools.register({ ...base, effect: 'invalid' as never }), /effect/);
  assert.throws(() => tools.register({ ...base, effect: 'read_only', schema: z.string() }), /parameters/);
  assert.throws(() => tools.register({ ...base, effect: 'read_only', schema: undefined as never }), /schema|parameters/);
  assert.throws(() => tools.register({ ...base, effect: 'read_only', execute: undefined as never }), /execute/);
  assert.deepEqual(tools.definitions(), []);
  tools.register({ ...base, effect: 'read_only' });
  assert.equal(tools.definitions()[0]?.name, 'inspect');
});
