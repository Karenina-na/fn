import type { Message } from '../message.ts';

interface CleanTool { id: string; name: string; status: string; input: unknown; output?: unknown }
interface CleanMessage { role: string; content?: string; tools?: CleanTool[] }

function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_key, current) => current && typeof current === 'object' && !Array.isArray(current)
    ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)))
    : current) ?? 'null';
}

function bounded(output: unknown): unknown {
  const serialized = JSON.stringify(output);
  if (!serialized || new TextEncoder().encode(serialized).length <= 2048) return output;
  const result: Record<string, unknown> = { truncated: true, bytes: new TextEncoder().encode(serialized).length, type: Array.isArray(output) ? 'array' : typeof output };
  if (Array.isArray(output)) result.items = output.length;
  else if (typeof output === 'string') result.characters = [...output].length;
  else if (output && typeof output === 'object') result.keys = Object.keys(output).sort();
  return result;
}

export function normalize(messages: Message[]): CleanMessage[] {
  return messages.map((message, messageIndex) => {
    let candidates: { exactKey: string; attemptKey: string; tool: CleanTool }[] = [];
    for (const step of message.trace?.steps ?? []) {
      if (step.kind !== 'tool') continue;
      const attemptKey = `${step.name}\u0000${canonicalJSON(step.input)}`;
      const exactKey = `${attemptKey}\u0000${step.status}\u0000${canonicalJSON(step.output)}`;
      candidates = candidates.filter(candidate => candidate.exactKey !== exactKey);
      if (step.status === 'complete') {
        candidates = candidates.filter(candidate => candidate.tool.status !== 'error' || candidate.attemptKey !== attemptKey);
      }
      candidates.push({ exactKey, attemptKey, tool: { id: step.id, name: step.name, status: step.status, input: step.input, output: step.status === 'error' ? { error: String((step.output as { error?: unknown } | undefined)?.error ?? '').slice(0, 512) } : bounded(step.output) } });
    }
    const references = messages.slice(messageIndex).map(item => `${item.content}\n${(item.trace?.steps ?? []).filter(step => step.kind === 'tool').map(step => canonicalJSON(step.input)).join('\n')}`).join('\n').toLowerCase();
    const relevant = candidates.map(candidate => candidate.tool).filter(tool => {
      if (tool.status !== 'error') return true;
      const error = String((tool.output as { error?: string })?.error ?? '').toLowerCase();
      return Boolean(tool.id && references.includes(tool.id.toLowerCase())) || Boolean(error && references.includes(error));
    });
    return { role: message.role, ...(message.content ? { content: message.content } : {}), ...(relevant.length ? { tools: relevant } : {}) };
  });
}
