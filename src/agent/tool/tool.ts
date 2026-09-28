import { z } from 'zod';

export type ToolEffect = 'read_only' | 'session_write' | 'write' | 'destructive';
export interface ToolContext { sessionId: string; signal?: AbortSignal }
export interface Tool<I = unknown> {
  name: string;
  description: string;
  usage: string;
  effect: ToolEffect;
  schema: z.ZodType<I>;
  execute(input: I, context: ToolContext): Promise<unknown> | unknown;
}
export interface ToolDefinition {
  name: string;
  description: string;
  usage: string;
  effect: ToolEffect;
  parameters: Record<string, unknown>;
}
export interface ToolCall { id: string; name: string; arguments: string }
export type ToolResult =
  | { callId: string; name: string; ok: true; output: unknown }
  | { callId: string; name: string; ok: false; error: string };
