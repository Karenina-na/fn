export type TraceStep =
  | { id: string; kind: 'reasoning'; status: 'running' | 'complete' | 'error'; message?: string }
  | { id: string; kind: 'tool'; status: 'running' | 'complete' | 'error'; name: string; input: unknown; output?: unknown };

export interface Usage { inputTokens: number; outputTokens: number; totalTokens: number }

export interface MessageTrace {
  steps: TraceStep[];
  finishReason: string;
  usage: Usage;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  sequence: number;
  trace?: MessageTrace;
}

export interface Summary {
  content: string;
  throughSequence: number;
  anchorSequence: number;
  compactedMessages: number;
  recentTurns: number;
}

export interface Snapshot { messages: Message[]; summary: Summary }

export type NewMessage = Pick<Message, 'role' | 'content'> & Partial<Pick<Message, 'id' | 'trace'>>;

export interface History {
  list(sessionId: string, limit?: number): Promise<Message[]>;
  snapshot(sessionId: string): Promise<Snapshot>;
  append(sessionId: string, message: NewMessage): Promise<Message>;
  saveSummary(sessionId: string, summary: Summary): Promise<void>;
  clear(sessionId: string): Promise<void>;
  undo(sessionId: string, messageId: string): Promise<{ message: Message; remaining: Message[] }>;
}
