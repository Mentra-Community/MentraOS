/**
 * StateManager — Shared state between client/ and webview/
 *
 * client/ code calls state.set("key", value) → StateManager updates →
 * SSE pushes to webview → useMentra().state reactively updates.
 */

type Handler = (...args: any[]) => void;

export class StateManager {
  private store: Record<string, any> = {};
  private handlers = new Map<string, Set<Handler>>();

  getAll(): Record<string, any> {
    return { ...this.store };
  }

  get<T = any>(key: string): T {
    return this.store[key] as T;
  }

  set(key: string, value: any): void {
    this.store[key] = value;
    this.emit("change", { key, value });
    this.emit(`change:${key}`, value);
  }

  init(defaults: Record<string, any>): void {
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in this.store)) {
        this.store[key] = value;
      }
    }
  }

  onChange(handler: Handler): () => void {
    return this.on("change", handler);
  }

  on(event: string, handler: Handler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => { this.handlers.get(event)?.delete(handler); };
  }

  emit(event: string, ...args: any[]): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const handler of set) {
        try { handler(...args); } catch (e) { console.error(`[StateManager] Error in ${event}:`, e); }
      }
    }
  }
}
