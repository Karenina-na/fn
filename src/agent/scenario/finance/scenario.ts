import type { MemoryStore } from '../../memory/store.ts';
import { memoryTools } from '../../memory/tools.ts';
import { ScenarioRegistry } from '../scenario.ts';
import { ToolRegistry } from '../../tool/registry.ts';
import type { FinanceReader } from './domain.ts';
import { financeTools } from './tools.ts';
import { financePrompt } from './prompt.ts';

export type { FinanceReader } from './domain.ts';
export interface FinanceDependencies { finance: FinanceReader; memory: MemoryStore }

export function registerFinance(registry: ScenarioRegistry, dependencies: FinanceDependencies): void {
  if (!dependencies.finance || !dependencies.memory) throw new Error('finance reader and memory store are required');
  registry.register('finance', () => {
    const tools = new ToolRegistry();
    for (const tool of [...financeTools(dependencies.finance), ...memoryTools(dependencies.memory)]) tools.register(tool);
    return { prompt: financePrompt(), tools };
  });
}
