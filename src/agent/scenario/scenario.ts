import type { PromptSpec } from '../prompt/prompt.ts';
import type { ToolRegistry } from '../tool/registry.ts';

export interface Scenario { prompt: PromptSpec; tools: ToolRegistry }
export type ScenarioFactory = () => Scenario;

export class ScenarioRegistry {
  private factories = new Map<string, ScenarioFactory>();
  register(name: string, factory: ScenarioFactory): void {
    if (!name.trim()) throw new Error('scenario name is required');
    if (this.factories.has(name)) throw new Error(`scenario ${name} is already registered`);
    this.factories.set(name, factory);
  }
  build(name: string): Scenario {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`scenario ${name} is not registered`);
    return factory();
  }
}
