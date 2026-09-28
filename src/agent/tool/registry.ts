import { z } from 'zod';
import type { Tool, ToolDefinition } from './tool.ts';

export class ToolRegistry {
  private tools = new Map<string, { tool: Tool<any>; definition: ToolDefinition }>();

  register<I>(tool: Tool<I>): void {
    if (!tool || typeof tool !== 'object') throw new Error('tool is required');
    if (typeof tool.name !== 'string' || typeof tool.description !== 'string' || typeof tool.usage !== 'string') {
      throw new Error('tool name, description and usage are required');
    }
    const name = tool.name.trim();
    if (!name || !tool.description.trim() || !tool.usage.trim()) throw new Error('tool name, description and usage are required');
    if (typeof tool.execute !== 'function') throw new Error(`tool ${name} execute function is required`);
    if (!['read_only', 'session_write', 'write', 'destructive'].includes(tool.effect)) {
      throw new Error(`tool ${name} has invalid effect ${String(tool.effect)}`);
    }
    if (this.tools.has(name)) throw new Error(`tool ${name} is already registered`);
    let parameters: Record<string, unknown>;
    try {
      parameters = z.toJSONSchema(tool.schema) as Record<string, unknown>;
    } catch {
      throw new Error(`tool ${name} parameters must be a valid Zod object schema`);
    }
    if (parameters.type !== 'object') throw new Error(`tool ${name} parameters must be an object schema`);
    this.tools.set(name, {
      tool: { ...tool, name },
      definition: { name, description: tool.description, usage: tool.usage, effect: tool.effect, parameters },
    });
  }

  get(name: string): Tool<any> | undefined { return this.tools.get(name)?.tool; }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map(entry => entry.definition)
      .sort((a, b) => a.name.localeCompare(b.name)).map(definition => structuredClone(definition));
  }
}
