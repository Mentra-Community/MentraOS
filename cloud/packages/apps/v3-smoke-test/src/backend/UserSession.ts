import type { MentraSession, TranscriptionData } from "@mentra/sdk";

import type { AppState, AppStateKey, RuntimeState, StateSnapshot, StateSource, StateUpdate } from "../shared/state";

interface StateClient {
  close(): void;
  send(event: "ping" | "runtime_update" | "snapshot" | "state_update", payload: unknown): Promise<void> | void;
}

const USER_SESSIONS_KEY = Symbol.for("mentra.v3SmokeTest.userSessions");
(globalThis as Record<PropertyKey, unknown>)[USER_SESSIONS_KEY] ??= new Map<string, UserSession>();

const DEFAULT_RUNTIME_STATE: RuntimeState = {
  lastReconnectAt: null,
  reconnectCount: 0,
  sessionId: null,
  status: "no-session",
  stopReason: null,
};

const DEFAULT_APP_STATE: Partial<AppState> = {
  lastTranscript: null,
  lastUpdatedAt: null,
  transcriptCount: 0,
  transcriptMode: null,
  webviewNote: "",
};

export class UserSession {
  private static get sessions(): Map<string, UserSession> {
    return (globalThis as Record<PropertyKey, unknown>)[USER_SESSIONS_KEY] as Map<string, UserSession>;
  }

  static get(userId: string): UserSession | null {
    return this.sessions.get(userId) ?? null;
  }

  static getOrCreate(userId: string): UserSession {
    const existing = this.get(userId);
    if (existing) {
      return existing;
    }

    const userSession = new UserSession(userId);
    this.sessions.set(userId, userSession);
    return userSession;
  }

  static remove(userId: string): void {
    this.sessions.delete(userId);
  }

  private readonly stateClients = new Set<StateClient>();
  private mentraSession: MentraSession | null = null;
  private runtime: RuntimeState = { ...DEFAULT_RUNTIME_STATE };
  private state: Partial<AppState> = { ...DEFAULT_APP_STATE };

  private constructor(readonly userId: string) {}

  getSnapshot(): StateSnapshot {
    return {
      runtime: { ...this.runtime },
      state: { ...this.state },
    };
  }

  hasActiveSession(): boolean {
    return this.mentraSession !== null;
  }

  attachSession(session: MentraSession): void {
    this.mentraSession = session;
    this.runtime = {
      ...this.runtime,
      sessionId: session.sessionId,
      status: "connected",
      stopReason: null,
    };
    this.broadcastRuntime();
    this.broadcastSnapshot();
  }

  markReconnected(session: MentraSession): void {
    this.mentraSession = session;
    this.runtime = {
      ...this.runtime,
      lastReconnectAt: new Date().toISOString(),
      reconnectCount: this.runtime.reconnectCount + 1,
      sessionId: session.sessionId,
      status: "connected",
      stopReason: null,
    };
    this.broadcastRuntime();
  }

  markStopped(reason: string): void {
    this.mentraSession = null;
    this.runtime = {
      ...this.runtime,
      status: "stopped",
      stopReason: reason,
    };
    this.broadcastRuntime();
  }

  applyTranscription(event: Pick<TranscriptionData, "isFinal" | "text">): void {
    if (!event.text) {
      return;
    }

    this.setState("lastTranscript", event.text, "session");
    this.setState("transcriptMode", event.isFinal ? "final" : "live", "session");
    this.setState("transcriptCount", (this.state.transcriptCount ?? 0) + 1, "session");
  }

  setState<K extends AppStateKey>(key: K, value: AppState[K], source: StateSource): void {
    const timestamp = new Date().toISOString();

    this.state = {
      ...this.state,
      [key]: value,
      lastUpdatedAt: timestamp,
    };

    const update: StateUpdate<K> = {
      key,
      source,
      timestamp,
      value,
    };

    this.broadcast("state_update", update);
  }

  addStateClient(client: StateClient): void {
    this.stateClients.add(client);
  }

  removeStateClient(client: StateClient): void {
    this.stateClients.delete(client);
  }

  async sendPing(client: StateClient): Promise<void> {
    await client.send("ping", { timestamp: new Date().toISOString() });
  }

  async sendSnapshot(client: StateClient): Promise<void> {
    await client.send("snapshot", this.getSnapshot());
  }

  private broadcastRuntime(): void {
    this.broadcast("runtime_update", { runtime: { ...this.runtime } });
  }

  private broadcastSnapshot(): void {
    this.broadcast("snapshot", this.getSnapshot());
  }

  private broadcast(event: "ping" | "runtime_update" | "snapshot" | "state_update", payload: unknown): void {
    for (const client of this.stateClients) {
      Promise.resolve(client.send(event, payload)).catch(() => {
        this.removeStateClient(client);
        client.close();
      });
    }
  }
}
