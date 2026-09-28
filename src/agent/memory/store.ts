export interface MemoryItem { id: string; content: string; createdAt: Date; updatedAt: Date }
export interface MemoryStore {
  search(sessionId: string, query: string, signal?: AbortSignal): Promise<MemoryItem[]>;
  add(sessionId: string, content: string, signal?: AbortSignal): Promise<MemoryItem>;
  update(sessionId: string, itemId: string, content: string, signal?: AbortSignal): Promise<MemoryItem>;
  delete(sessionId: string, itemId: string, signal?: AbortSignal): Promise<void>;
  clear(sessionId: string, signal?: AbortSignal): Promise<void>;
}

export class InMemoryStore implements MemoryStore {
  private items = new Map<string, MemoryItem[]>();
  private sequence = 0;

  private validate(sessionId: string, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (!sessionId.trim()) throw new Error('session id is required');
  }
  async search(sessionId: string, query: string, signal?: AbortSignal): Promise<MemoryItem[]> {
    this.validate(sessionId, signal);
    const needle = query.trim().toLowerCase();
    return structuredClone((this.items.get(sessionId) ?? []).filter(item => item.content.toLowerCase().includes(needle)));
  }
  async add(sessionId: string, content: string, signal?: AbortSignal): Promise<MemoryItem> {
    this.validate(sessionId, signal);
    content = content.trim();
    if (!content) throw new Error('memory content is required');
    const now = new Date();
    const item = { id: `memory_${++this.sequence}`, content, createdAt: now, updatedAt: now };
    this.items.set(sessionId, [...(this.items.get(sessionId) ?? []), item]);
    return structuredClone(item);
  }
  async update(sessionId: string, itemId: string, content: string, signal?: AbortSignal): Promise<MemoryItem> {
    this.validate(sessionId, signal);
    itemId = itemId.trim();
    content = content.trim();
    if (!itemId) throw new Error('memory item id is required');
    if (!content) throw new Error('memory content is required');
    const item = (this.items.get(sessionId) ?? []).find(item => item.id === itemId);
    if (!item) throw new Error('memory item not found');
    item.content = content;
    item.updatedAt = new Date();
    return structuredClone(item);
  }
  async delete(sessionId: string, itemId: string, signal?: AbortSignal): Promise<void> {
    this.validate(sessionId, signal);
    itemId = itemId.trim();
    if (!itemId) throw new Error('memory item id is required');
    const items = this.items.get(sessionId) ?? [];
    if (!items.some(item => item.id === itemId)) throw new Error('memory item not found');
    this.items.set(sessionId, items.filter(item => item.id !== itemId));
  }
  async clear(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.validate(sessionId, signal);
    this.items.delete(sessionId);
  }
}
