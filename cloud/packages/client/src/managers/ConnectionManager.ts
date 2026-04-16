import { EventBus } from "../EventBus";
import type { ConnectionStatus, ConnectionInfo, MentraError } from "../types";

export class ConnectionManager {
  private bus = new EventBus();
  private _info: ConnectionInfo = {
    status: "disconnected",
    url: null,
    error: null,
    sessionId: null,
    lastConnectedAt: null,
    reconnectAttempts: 0,
  };

  get info(): ConnectionInfo { return { ...this._info }; }
  get status(): ConnectionStatus { return this._info.status; }
  get url(): string | null { return this._info.url; }
  get error(): string | null { return this._info.error; }
  get sessionId(): string | null { return this._info.sessionId; }
  get lastConnectedAt(): Date | null { return this._info.lastConnectedAt; }
  get reconnectAttempts(): number { return this._info.reconnectAttempts; }

  // ── Internal state updates ────────────────────────────────

  setStatus(status: ConnectionStatus): void {
    this._info.status = status;
    if (status === "connected") {
      this._info.lastConnectedAt = new Date();
      this._info.reconnectAttempts = 0;
      this._info.error = null;
    }
    this.bus.emit("status_changed", status);
    this.bus.emit("changed", this.info);
  }

  setError(error: string): void {
    this._info.error = error;
    this._info.status = "error";
    this.bus.emit("error", { code: "CONNECTION_ERROR", message: error, severity: "error" as const });
    this.bus.emit("changed", this.info);
  }

  setSessionId(id: string): void {
    this._info.sessionId = id;
  }

  setUrl(url: string): void {
    this._info.url = url;
  }

  incrementReconnectAttempts(): void {
    this._info.reconnectAttempts++;
  }

  // ── Events ─────────────────────────────────────────────────

  on(event: "status_changed", handler: (status: ConnectionStatus) => void): () => void;
  on(event: "error", handler: (error: MentraError) => void): () => void;
  on(event: "changed", handler: (info: ConnectionInfo) => void): () => void;
  on(event: string, handler: (...args: any[]) => void): () => void {
    return this.bus.on(event, handler);
  }

  destroy(): void { this.bus.removeAll(); }
}
