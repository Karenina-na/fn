import { z } from 'zod';
import type { Tool } from '../tool/tool.ts';
import type { MemoryStore } from './store.ts';

const searchSchema = z.strictObject({
  query: z.preprocess(value => typeof value === 'string' ? value.trim() : value, z.string().max(500)),
});
const manageSchema = z.strictObject({
  action: z.preprocess(value => typeof value === 'string' ? value.trim() : value, z.enum(['add', 'update', 'delete'])),
  id: z.string().optional(),
  content: z.string().optional(),
}).superRefine((input, context) => {
  const id = input.id?.trim();
  const content = input.content?.trim();
  const valid = input.action === 'add' ? !id && Boolean(content)
    : input.action === 'update' ? Boolean(id && content)
    : Boolean(id && !content);
  if (!valid) context.addIssue({ code: 'custom', message: `invalid ${input.action} memory arguments` });
});

export function memoryTools(store: MemoryStore): [Tool<z.infer<typeof searchSchema>>, Tool<z.infer<typeof manageSchema>>] {
  return [
    {
      name: 'search_memory', description: 'Search memory items in the current session.',
      usage: 'Search before answering when a prior decision or stable preference may matter; an empty query lists all items.',
      effect: 'read_only', schema: searchSchema,
      execute: async ({ query }, context) => {
        query = query.trim();
        if (new TextEncoder().encode(query).length > 500) throw new Error('memory query must not exceed 500 bytes');
        return { items: await store.search(context.sessionId, query, context.signal) };
      },
    },
    {
      name: 'manage_memory', description: 'Add, update or delete one memory item in the current session.',
      usage: 'Use for explicit requests to remember or forget and for stable reusable preferences; search before updating.',
      effect: 'session_write', schema: manageSchema,
      async execute(input, context) {
        switch (input.action) {
          case 'add': return { item: await store.add(context.sessionId, input.content!, context.signal) };
          case 'update': return { item: await store.update(context.sessionId, input.id!, input.content!, context.signal) };
          case 'delete': await store.delete(context.sessionId, input.id!, context.signal); return { deletedId: input.id };
        }
      },
    },
  ];
}
