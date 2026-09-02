import type { SessionBinding, SessionStore } from "./types";

export class InMemorySessionStore implements SessionStore {
  private readonly store = new Map<string, SessionBinding>();
  private isInitialized = false;

  public async init(): Promise<void> {
    this.isInitialized = true;
  }

  public async get(threadId: string): Promise<SessionBinding | null> {
    this.ensureInitialized();
    const item = this.store.get(threadId);
    if (!item) { return null; }
    return { ...item, metadata: item.metadata ? { ...item.metadata } : undefined };
  }

  public async set(binding: SessionBinding): Promise<void> {
    this.ensureInitialized();
    const now = Date.now();
    this.store.set(binding.threadId, {
      ...binding,
      createdAt: binding.createdAt || now,
      updatedAt: binding.updatedAt || now,
      metadata: binding.metadata ? { ...binding.metadata } : undefined,
    });
  }

  public async delete(threadId: string): Promise<boolean> {
    this.ensureInitialized();
    return this.store.delete(threadId);
  }

  public async list(): Promise<SessionBinding[]> {
    this.ensureInitialized();
    return Array.from(this.store.values()).map((item) => ({
      ...item,
      metadata: item.metadata ? { ...item.metadata } : undefined,
    }));
  }

  public async clear(): Promise<void> {
    this.ensureInitialized();
    this.store.clear();
  }

  public async close(): Promise<void> {
    this.store.clear();
    this.isInitialized = false;
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error("InMemorySessionStore is not initialized. Call init() first.");
    }
  }
}
