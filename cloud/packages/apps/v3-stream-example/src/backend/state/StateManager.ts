import { type AppState, DEFAULT_APP_STATE } from "../../shared/state";

type Listener = (eventName: string, data: string) => void;

/**
 * Manages app state and broadcasts changes to connected SSE clients.
 * One StateManager per user — owned by UserSession.
 */
export class StateManager {
  private state: AppState = structuredClone(DEFAULT_APP_STATE);
  private listeners = new Set<Listener>();

  get<K extends keyof AppState>(key: K): AppState[K] {
    return this.state[key];
  }

  getAll(): AppState {
    return structuredClone(this.state);
  }

  set<K extends keyof AppState>(key: K, value: AppState[K]): void {
    this.state[key] = value;
    this.broadcast("update", JSON.stringify({ key, value }));
  }

  /** Subscribe to state changes. Immediately sends a snapshot. Returns unsubscribe fn. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // Send initial snapshot
    listener("snapshot", JSON.stringify(this.state));
    return () => {
      this.listeners.delete(listener);
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  private broadcast(eventName: string, data: string): void {
    for (const listener of this.listeners) {
      try {
        listener(eventName, data);
      } catch {
        // Listener threw — remove it (dead connection)
        this.listeners.delete(listener);
      }
    }
  }
}
