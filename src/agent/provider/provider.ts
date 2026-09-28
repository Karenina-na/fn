import type { ToolCall, ToolDefinition } from '../tool/tool.ts';
import type { Usage } from '../conversation/message.ts';

export type ProviderMessage =
  | { role: 'system' | 'context' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; providerContext?: unknown[] }
  | { role: 'tool'; content: string; toolCallId: string };
export interface ChatRequest { model: string; messages: ProviderMessage[]; tools: ToolDefinition[]; maxOutputTokens?: number; signal?: AbortSignal }
export type FinishReason = 'stop' | 'tool_calls' | 'max_tokens' | 'error';
export interface ChatResponse { content: string; toolCalls: ToolCall[]; reasoning: string[]; providerContext?: unknown[]; usage: Usage; finishReason: FinishReason }
export interface Provider { chat(request: ChatRequest): Promise<ChatResponse> }

export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  register(name: string, provider: Provider): void {
    if (!name.trim()) throw new Error('provider name is required');
    if (this.providers.has(name)) throw new Error(`provider ${name} is already registered`);
    this.providers.set(name, provider);
  }
  get(name: string): Provider {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`provider ${name} is not registered`);
    return provider;
  }
}
