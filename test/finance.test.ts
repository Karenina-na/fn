import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryStore } from '../src/agent/memory/store.ts';
import { registerFinance, type FinanceReader } from '../src/agent/scenario/finance/scenario.ts';
import { ScenarioRegistry } from '../src/agent/scenario/scenario.ts';
import { ToolExecutor } from '../src/agent/tool/executor.ts';

test('finance scenario registers scoped portfolio tools and memory capabilities', async () => {
  const reader: FinanceReader = {
    async getOverview(sessionId) { return { asOf: '2026-09-28T00:00:00Z', baseCurrency: 'CNY', totalValue: '100.00', sessionId }; },
    async listAccounts() { return []; },
    async listHoldings() { return []; },
    async listTransactions() { return []; },
  };
  const registry = new ScenarioRegistry();
  registerFinance(registry, { finance: reader, memory: new InMemoryStore() });
  const scenario = registry.build('finance');
  assert.deepEqual(scenario.tools.definitions().map(tool => tool.name), [
    'finance_accounts', 'finance_holdings', 'finance_overview', 'finance_transactions', 'manage_memory', 'search_memory',
  ]);
  assert.equal(scenario.tools.definitions().find(tool => tool.name === 'manage_memory')?.parameters.type, 'object');
  const [result] = await new ToolExecutor(scenario.tools).execute([{ id: 'c1', name: 'finance_overview', arguments: '{}' }], { sessionId: 'owner' });
  assert.equal(result?.ok, true);
  assert.equal((result as { output: { sessionId: string } }).output.sessionId, 'owner');
  assert.match(scenario.prompt.intro, /finance/i);
});
