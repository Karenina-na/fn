import type { ToolCall, ToolContext, ToolResult } from './tool.ts';
import { ToolRegistry } from './registry.ts';

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(calls: ToolCall[], context: ToolContext): Promise<ToolResult[]> {
    return Promise.all(calls.map(async call => {
      try {
        context.signal?.throwIfAborted();
        const tool = this.registry.get(call.name);
        if (!tool) throw new Error(`tool ${call.name} is not registered`);
        if (tool.effect !== 'read_only' && tool.effect !== 'session_write') throw new Error(`tool effect ${tool.effect} is not allowed`);
        const input = tool.schema.parse(JSON.parse(call.arguments));
        const output = await tool.execute(input, context);
        context.signal?.throwIfAborted();
        return { callId: call.id, name: call.name, ok: true as const, output };
      } catch (error) {
        return { callId: call.id, name: call.name, ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    }));
  }
}
