type Handler = (...args: any[]) => void;

export class EventBus {
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, handler: Handler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  emit(event: string, ...args: any[]): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (e) {
          console.error(`[EventBus] Error in ${event} handler:`, e);
        }
      }
    }
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
