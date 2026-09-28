import type { History, TraceStep, Usage } from '../conversation/message.ts';
import { LLMCompactor } from '../conversation/compact/compactor.ts';
import type { ProviderMessage } from '../provider/provider.ts';
import { ProviderRegistry } from '../provider/provider.ts';
import type { Scenario } from '../scenario/scenario.ts';
import { ToolExecutor } from '../tool/executor.ts';
import { ContextBuilder, type CompactionResult } from './context.ts';
import { AgentRunError, type RuntimeEvent } from './event.ts';

export interface RuntimeConfig {
  provider: string;
  model: string;
  maxToolRounds?: number;
  historyLimit?: number;
  compactionRecentTurns?: number;
  compactionMaxOutputTokens?: number;
  maxOutputTokens?: number;
}

export class AgentRuntime {
  private readonly context: ContextBuilder;
  private readonly executor: ToolExecutor;
  private runSequence = 0;
  private readonly maxToolRounds: number;

  constructor(private readonly config: RuntimeConfig, private readonly providers: ProviderRegistry, private readonly scenario: Scenario, private readonly history: History) {
    this.maxToolRounds = config.maxToolRounds && config.maxToolRounds > 0 ? config.maxToolRounds : 6;
    const historyLimit = config.historyLimit && config.historyLimit > 0 ? config.historyLimit : 40;
    const recentTurns = config.compactionRecentTurns && config.compactionRecentTurns > 0 ? config.compactionRecentTurns : Math.min(8, Math.max(1, Math.floor(historyLimit / 4)));
    this.context = new ContextBuilder(history, scenario.prompt, scenario.tools, historyLimit, recentTurns,
      new LLMCompactor({ chat: request => providers.get(config.provider).chat(request) }, config.model, config.compactionMaxOutputTokens));
    this.executor = new ToolExecutor(scenario.tools);
  }

  buildContext(sessionId: string, userMessage: string, signal?: AbortSignal): Promise<ProviderMessage[]> { return this.context.build(sessionId, userMessage, signal); }
  compact(sessionId: string, signal?: AbortSignal): Promise<CompactionResult> { return this.context.compact(sessionId, signal); }
  snapshot(sessionId: string) { return this.history.snapshot(sessionId); }

  /** A failed run emits run.error and then rejects the iterator with AgentRunError. */
  async *run(sessionId: string, userMessage: string, signal?: AbortSignal): AsyncIterable<RuntimeEvent> {
    let runId: string | undefined;
    try {
      const provider = this.providers.get(this.config.provider);
      const messages = await this.context.build(sessionId, userMessage, signal);
      signal?.throwIfAborted();
      const user = await this.history.append(sessionId, { role: 'user', content: userMessage });
      runId = `run_${++this.runSequence}`;
      yield { type: 'run.started', runId, messageId: user.id };
      const usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const steps: TraceStep[] = [];
      for (let round = 0; round <= this.maxToolRounds; round++) {
        signal?.throwIfAborted();
        const reasoning: TraceStep = { id: `${runId}-reasoning-${round}`, kind: 'reasoning', status: 'running' };
        steps.push(reasoning);
        yield { type: 'reasoning.started', runId };
        const response = await provider.chat({ model: this.config.model, messages, tools: this.scenario.tools.definitions(), maxOutputTokens: this.config.maxOutputTokens, signal });
        signal?.throwIfAborted();
        if (!response) throw new Error('provider returned no response');
        const reasoningText = response.reasoning.join('\n\n');
        reasoning.status = 'complete';
        if (reasoningText) reasoning.message = reasoningText;
        yield { type: 'reasoning.completed', runId, message: reasoningText };
        usage.inputTokens += response.usage.inputTokens;
        usage.outputTokens += response.usage.outputTokens;
        usage.totalTokens += response.usage.totalTokens;
        if (response.finishReason === 'error') throw new Error('provider returned an error finish reason');

        if (!response.toolCalls.length) {
          if (response.content) yield { type: 'content.delta', delta: response.content };
          await this.history.append(sessionId, { role: 'assistant', content: response.content, trace: { steps, finishReason: response.finishReason, usage } });
          yield { type: 'run.completed', runId, finishReason: response.finishReason, usage };
          return;
        }
        if (round === this.maxToolRounds) throw new Error('tool round limit reached');
        messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls, providerContext: response.providerContext });
        for (const call of response.toolCalls) {
          let input: unknown;
          try { input = JSON.parse(call.arguments); } catch { input = call.arguments; }
          steps.push({ id: call.id, kind: 'tool', name: call.name, input, status: 'running' });
          yield { type: 'tool.started', callId: call.id, name: call.name, input };
        }
        const results = await this.executor.execute(response.toolCalls, { sessionId: sessionId.trim(), signal });
        signal?.throwIfAborted();
        for (const result of results) {
          const output = result.ok ? result.output ?? null : { error: result.error };
          const step = steps.find(item => item.kind === 'tool' && item.id === result.callId);
          if (step && step.kind === 'tool') { step.output = output; step.status = result.ok ? 'complete' : 'error'; }
          yield { type: 'tool.completed', callId: result.callId, name: result.name, output, isError: !result.ok };
          messages.push({ role: 'tool', content: JSON.stringify(output), toolCallId: result.callId });
        }
      }
    } catch (error) {
      const failure = new AgentRunError(signal?.aborted ? 'aborted' : 'runtime_error', error instanceof Error ? error.message : String(error), runId, error);
      yield { type: 'run.error', runId, code: failure.code, message: failure.message };
      throw failure;
    }
  }
}
