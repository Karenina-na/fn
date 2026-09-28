import type { History, Message, NewMessage, Snapshot, Summary } from './message.ts';

const emptySummary = (): Summary => ({ content: '', throughSequence: 0, anchorSequence: 0, compactedMessages: 0, recentTurns: 0 });

export class InMemoryHistory implements History {
  private messages = new Map<string, Message[]>();
  private summaries = new Map<string, Summary>();
  private sequence = 0;

  async list(sessionId: string, limit = 0): Promise<Message[]> {
    const items = this.messages.get(sessionId) ?? [];
    return structuredClone(limit > 0 ? items.slice(-limit) : items);
  }

  async snapshot(sessionId: string): Promise<Snapshot> {
    return structuredClone({ messages: this.messages.get(sessionId) ?? [], summary: this.summaries.get(sessionId) ?? emptySummary() });
  }

  async append(sessionId: string, input: NewMessage): Promise<Message> {
    if (!sessionId.trim()) throw new Error('session id is required');
    const sequence = ++this.sequence;
    const message: Message = structuredClone({ ...input, id: input.id ?? `msg_${sequence}`, sequence, createdAt: new Date() });
    this.messages.set(sessionId, [...(this.messages.get(sessionId) ?? []), message].slice(-200));
    return structuredClone(message);
  }

  async saveSummary(sessionId: string, summary: Summary): Promise<void> {
    if (!(this.messages.get(sessionId) ?? []).some(message => message.sequence === summary.throughSequence)) {
      throw new Error('summary boundary message not found');
    }
    this.summaries.set(sessionId, structuredClone(summary));
  }

  async clear(sessionId: string): Promise<void> {
    this.messages.delete(sessionId);
    this.summaries.delete(sessionId);
  }

  async undo(sessionId: string, messageId: string): Promise<{ message: Message; remaining: Message[] }> {
    const items = this.messages.get(sessionId) ?? [];
    const index = items.findIndex(message => message.id === messageId);
    if (index < 0) throw new Error('message not found');
    const message = items[index]!;
    if (message.role !== 'user') throw new Error('message is not a user message');
    const remaining = items.slice(0, index);
    this.messages.set(sessionId, remaining);
    if ((this.summaries.get(sessionId)?.throughSequence ?? 0) >= message.sequence) this.summaries.delete(sessionId);
    return structuredClone({ message, remaining });
  }
}
