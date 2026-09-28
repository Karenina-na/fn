import { z } from 'zod';
import type { ChatRequest, ChatResponse, Provider } from './provider.ts';

const outputItem = z.object({
  type: z.string(),
  call_id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.string().optional(),
  summary: z.array(z.object({ text: z.string() })).optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
}).passthrough();

const envelope = z.object({
  status: z.string(),
  output: z.array(outputItem),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), total_tokens: z.number() }).optional(),
  incomplete_details: z.object({ reason: z.string() }).nullable().optional(),
  error: z.object({ message: z.string() }).nullable().optional(),
});

export interface OpenAIProviderOptions { apiKey: string; baseUrl?: string; fetch?: typeof fetch }

export class OpenAIUpstreamError extends Error {
  constructor(readonly status: number, readonly code?: string) {
    super(`OpenAI returned status ${status}${code ? ` (${code})` : ''}`);
    this.name = 'OpenAIUpstreamError';
  }
}

export class OpenAIProvider implements Provider {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: OpenAIProviderOptions) {
    const base = new URL(options.baseUrl?.trim() || 'https://api.openai.com/v1');
    const parts = base.pathname.split('/').filter(Boolean);
    if (!parts.includes('v1')) parts.push('v1');
    base.pathname = `/${parts.join('/')}`;
    this.baseUrl = base.toString().replace(/\/$/, '');
    this.fetcher = options.fetch ?? fetch;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.options.apiKey) throw new Error('OpenAI API key is not configured');
    const input: unknown[] = [];
    const instructions: string[] = [];
    for (const message of request.messages) {
      if (message.role === 'system' || message.role === 'context') { instructions.push(message.content); continue; }
      if (message.role === 'tool') { input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content }); continue; }
      if (message.content) input.push({ role: message.role, content: message.content });
      if (message.role === 'assistant') {
        input.push(...(message.providerContext ?? []));
        for (const call of message.toolCalls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
      }
    }
    const wire = {
      model: request.model, instructions: instructions.join('\n\n'), input,
      tools: request.tools.map(tool => {
        const { $schema: _, ...parameters } = tool.parameters;
        return { type: 'function', name: tool.name, description: tool.description, parameters, strict: false };
      }),
      parallel_tool_calls: true, store: false,
      include: ['reasoning.encrypted_content'],
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    };
    const response = await this.fetcher(`${this.baseUrl}/responses`, {
      method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(wire), signal: request.signal,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const parsed = z.object({ error: z.object({ code: z.string().optional() }) }).safeParse(body);
      throw new OpenAIUpstreamError(response.status, parsed.success ? parsed.data.error.code : undefined);
    }
    const data = envelope.parse(await response.json());
    if (data.error || data.status === 'failed') throw new Error('OpenAI response failed');
    const result: ChatResponse = {
      content: '', toolCalls: [], reasoning: [], providerContext: [],
      usage: { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0, totalTokens: data.usage?.total_tokens ?? 0 },
      finishReason: 'stop',
    };
    for (const item of data.output) {
      if (item.type === 'reasoning') {
        result.providerContext!.push(item);
        for (const summary of item.summary ?? []) if (summary.text.trim()) result.reasoning.push(summary.text.trim());
      } else if (item.type === 'message') {
        for (const content of item.content ?? []) if (content.type === 'output_text') result.content += content.text ?? '';
      } else if (item.type === 'function_call') {
        if (!item.call_id || !item.name || item.arguments === undefined) throw new Error('OpenAI returned an incomplete function call');
        result.toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
      }
    }
    if (result.toolCalls.length) result.finishReason = 'tool_calls';
    if (data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens') result.finishReason = 'max_tokens';
    return result;
  }
}
