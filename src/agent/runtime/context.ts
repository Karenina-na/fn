import type { History, Message, Summary } from '../conversation/message.ts';
import type { Compactor } from '../conversation/compact/compactor.ts';
import { summaryContext } from '../conversation/compact/compactor.ts';
import { CompactionStrategy, type CompactionPlan } from '../conversation/compact/strategy.ts';
import { buildPrompt, type PromptSpec } from '../prompt/prompt.ts';
import type { ProviderMessage } from '../provider/provider.ts';
import type { ToolRegistry } from '../tool/registry.ts';

export interface CompactionState { summary: string; compactedMessages: number; recentTurns: number; afterMessageId: string }
export interface CompactionResult { compacted: boolean; state: CompactionState }

export class ContextBuilder {
  private strategy: CompactionStrategy;
  constructor(
    private readonly history: History,
    private readonly prompt: PromptSpec,
    private readonly tools: ToolRegistry,
    threshold = 40,
    recentTurns = 8,
    private readonly compactor?: Compactor,
  ) { this.strategy = new CompactionStrategy(threshold, recentTurns); }

  async build(sessionId: string, userMessage: string, signal?: AbortSignal): Promise<ProviderMessage[]> {
    signal?.throwIfAborted();
    const snapshot = await this.history.snapshot(sessionId);
    const plan = this.strategy.plan(snapshot);
    const summary = plan ? await this.executeCompaction(sessionId, plan, signal) : snapshot.summary.content;
    const pending = plan?.recent ?? snapshot.messages.filter(message => message.sequence > snapshot.summary.throughSequence);
    const firstUser = pending.findIndex(message => message.role === 'user');
    const messages: ProviderMessage[] = [];
    const system = buildPrompt(this.prompt, this.tools.definitions());
    if (system) messages.push({ role: 'system', content: system });
    if (summary) messages.push(summaryContext(summary));
    if (firstUser >= 0) for (const message of pending.slice(firstUser)) messages.push(...this.providerMessages(message));
    messages.push({ role: 'user', content: userMessage });
    return messages;
  }

  async compact(sessionId: string, signal?: AbortSignal): Promise<CompactionResult> {
    signal?.throwIfAborted();
    const snapshot = await this.history.snapshot(sessionId);
    const plan = this.strategy.plan(snapshot, true);
    const anchor = snapshot.summary.anchorSequence || snapshot.summary.throughSequence;
    if (!plan) return { compacted: false, state: {
      summary: snapshot.summary.content, compactedMessages: snapshot.summary.compactedMessages,
      recentTurns: this.strategy.recentTurnCount(), afterMessageId: this.idAt(snapshot.messages, anchor),
    } };
    const summary = await this.executeCompaction(sessionId, plan, signal);
    return { compacted: true, state: { summary, compactedMessages: plan.compactedMessages, recentTurns: plan.recentTurns, afterMessageId: this.idAt(snapshot.messages, plan.anchorSequence) } };
  }

  private idAt(messages: Message[], sequence: number): string { return messages.find(message => message.sequence === sequence)?.id ?? ''; }

  private async executeCompaction(sessionId: string, plan: CompactionPlan, signal?: AbortSignal): Promise<string> {
    if (!this.compactor) throw new Error('conversation compactor is not configured');
    const summary = await this.compactor.compact({ previousSummary: plan.previousSummary, messages: plan.messages }, signal);
    signal?.throwIfAborted();
    const saved: Summary = { content: summary, throughSequence: plan.throughSequence, anchorSequence: plan.anchorSequence, compactedMessages: plan.compactedMessages, recentTurns: plan.recentTurns };
    await this.history.saveSummary(sessionId, saved);
    return summary;
  }

  private providerMessages(message: Message): ProviderMessage[] {
    if (message.role === 'user') return [{ role: 'user', content: message.content }];
    if (!message.trace) return [{ role: 'assistant', content: message.content }];
    const result: ProviderMessage[] = [];
    let batch: Extract<Message['trace'], object>['steps'] = [];
    const flush = () => {
      if (!batch.length) return;
      const calls = batch.filter(step => step.kind === 'tool');
      result.push({ role: 'assistant', content: '', toolCalls: calls.map(step => ({ id: step.id, name: step.name, arguments: JSON.stringify(step.input) })) });
      for (const step of calls) result.push({ role: 'tool', content: JSON.stringify(step.output ?? null), toolCallId: step.id });
      batch = [];
    };
    for (const step of message.trace.steps) {
      if (step.kind === 'reasoning') flush();
      else if (step.id && step.name) batch.push(step);
    }
    flush();
    if (message.content || result.length || !message.trace.steps.length) result.push({ role: 'assistant', content: message.content });
    return result;
  }
}
