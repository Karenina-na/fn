import type { Message, Snapshot } from '../message.ts';

export interface CompactionPlan {
  previousSummary: string;
  messages: Message[];
  recent: Message[];
  throughSequence: number;
  anchorSequence: number;
  compactedMessages: number;
  recentTurns: number;
}

export class CompactionStrategy {
  constructor(readonly threshold = 40, readonly recentTurns = 8) {}

  recentTurnCount(): number { return this.recentTurns > 0 ? this.recentTurns : 8; }

  plan(snapshot: Snapshot, force = false): CompactionPlan | undefined {
    const pending = snapshot.messages.filter(message => message.sequence > snapshot.summary.throughSequence);
    const firstUser = pending.findIndex(message => message.role === 'user');
    if (firstUser < 0) return;
    const messages = pending.slice(firstUser);
    if (!force && messages.length < (this.threshold > 0 ? this.threshold : 40)) return;
    const turns: { end: number; complete: boolean }[] = [];
    let hasAssistant = false;
    for (let index = 0; index < messages.length; index++) {
      if (messages[index]!.role === 'user') {
        if (index > 0) turns.push({ end: index, complete: true });
        hasAssistant = false;
      } else hasAssistant = true;
    }
    turns.push({ end: messages.length, complete: hasAssistant });
    const completeTurns = turns.findIndex(turn => !turn.complete);
    const completeCount = completeTurns < 0 ? turns.length : completeTurns;
    const recentTurns = this.recentTurnCount();
    const compactCount = completeCount - recentTurns;
    if (compactCount < 1) return;
    const end = turns[compactCount - 1]!.end;
    const selected = messages.slice(0, end);
    const latestUser = snapshot.messages.findLast(message => message.role === 'user');
    return {
      previousSummary: snapshot.summary.content, messages: selected, recent: messages.slice(end),
      throughSequence: selected.at(-1)!.sequence, anchorSequence: latestUser?.sequence ?? snapshot.messages.at(-1)?.sequence ?? 0,
      compactedMessages: selected.length, recentTurns,
    };
  }
}
