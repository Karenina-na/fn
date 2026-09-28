import type { FinishReason } from '../provider/provider.ts';
import type { Usage } from '../conversation/message.ts';

export type RunErrorCode = 'aborted' | 'runtime_error';

export class AgentRunError extends Error {
  constructor(readonly code: RunErrorCode, message: string, readonly runId?: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AgentRunError';
  }
}

export type RuntimeEvent =
  | { type: 'run.started'; runId: string; messageId: string }
  | { type: 'reasoning.started'; runId: string }
  | { type: 'reasoning.completed'; runId: string; message: string }
  | { type: 'content.delta'; delta: string }
  | { type: 'tool.started'; callId: string; name: string; input: unknown }
  | { type: 'tool.completed'; callId: string; name: string; output: unknown; isError: boolean }
  | { type: 'run.completed'; runId: string; finishReason: Exclude<FinishReason, 'error'>; usage: Usage }
  | { type: 'run.error'; runId?: string; code: RunErrorCode; message: string };
