import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAIProvider, OpenAIUpstreamError } from '../src/agent/provider/openai.ts';

test('OpenAI provider replays function calls and reasoning context without server storage', async () => {
  let wire: any;
  const fetcher: typeof fetch = async (_url, init) => {
    wire = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ status: 'completed', output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked balances.' }] },
      { type: 'function_call', call_id: 'c2', name: 'portfolio', arguments: '{}' },
    ], usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } }), { status: 200 });
  };
  const provider = new OpenAIProvider({ apiKey: 'test', fetch: fetcher });
  const response = await provider.chat({ model: 'test', tools: [], messages: [
    { role: 'system', content: 'Instructions' },
    { role: 'assistant', content: '', providerContext: [{ type: 'reasoning', id: 'rs1' }], toolCalls: [{ id: 'c1', name: 'portfolio', arguments: '{}' }] },
    { role: 'tool', content: '{"balance":1}', toolCallId: 'c1' },
  ] });
  assert.equal(wire.store, false);
  assert.deepEqual(wire.include, ['reasoning.encrypted_content']);
  assert.deepEqual(wire.input.map((item: any) => item.type), ['reasoning', 'function_call', 'function_call_output']);
  assert.equal(response.toolCalls[0]?.id, 'c2');
  assert.deepEqual(response.reasoning, ['Checked balances.']);
  assert.equal(response.finishReason, 'tool_calls');
});

test('OpenAI provider exposes structured upstream status without leaking the response message', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test', fetch: async () => new Response(JSON.stringify({ error: { code: 'rate_limit', message: 'private upstream detail' } }), { status: 429 }) });
  await assert.rejects(provider.chat({ model: 'test', tools: [], messages: [] }), error => {
    assert.ok(error instanceof OpenAIUpstreamError);
    assert.equal(error.status, 429);
    assert.equal(error.code, 'rate_limit');
    assert.doesNotMatch(error.message, /private upstream detail/);
    return true;
  });
});
