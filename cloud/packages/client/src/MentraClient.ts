import { EventBus } from "./EventBus";
import { GlassesManager } from "./managers/GlassesManager";
import { AppManager } from "./managers/AppManager";
import { ConnectionManager } from "./managers/ConnectionManager";
import { DisplayManager } from "./managers/DisplayManager";
import { TranscriptionManager } from "./managers/TranscriptionManager";
import type { Glasses, MentraError, TranscriptionEvent, DisplayEvent } from "./types";

export interface MentraClientConfig {
  cloudUrl?: string;
  token?: string;
}

export class MentraClient {
  private bus = new EventBus();
  private _token: string | null = null;

  // ── Managers ──────────────────────────────────────────────
  readonly glasses: GlassesManager;
  readonly apps: AppManager;
  readonly connection: ConnectionManager;
  readonly display: DisplayManager;
  readonly transcription: TranscriptionManager;

  constructor(config?: MentraClientConfig) {
    this.glasses = new GlassesManager();
    this.apps = new AppManager();
    this.connection = new ConnectionManager();
    this.display = new DisplayManager();
    this.transcription = new TranscriptionManager();

    if (config?.token) this._token = config.token;
    if (config?.cloudUrl) this.connection.setUrl(config.cloudUrl);

    // Wire internal event routing:
    // When display events arrive (from cloud or local), route to glasses
    this.display.on("event", (event: DisplayEvent) => {
      this.glasses.handleDisplayEvent(event);
    });
  }

  // ── Auth ───────────────────────────────────────────────────

  setToken(token: string): void {
    this._token = token;
  }

  // ── Connection Lifecycle ───────────────────────────────────

  async connect(): Promise<void> {
    if (!this._token) throw new Error("No token set. Call setToken() first.");

    this.connection.setStatus("connecting");

    // In real implementation, this would establish WebSocket + UDP
    // For now, just set connected state
    this.connection.setSessionId(`session_${Date.now()}`);
    this.connection.setStatus("connected");
    this.bus.emit("connected");
  }

  async disconnect(): Promise<void> {
    this.glasses.detach();
    this.connection.setStatus("disconnected");
    this.bus.emit("disconnected", "intentional");
  }

  get connected(): boolean {
    return this.connection.status === "connected";
  }

  get sessionId(): string | null {
    return this.connection.sessionId;
  }

  // ── Convenience Events ────────────────────────────────────

  on(event: "connected", handler: () => void): () => void;
  on(event: "disconnected", handler: (reason: string) => void): () => void;
  on(event: "error", handler: (error: MentraError) => void): () => void;
  on(event: string, handler: (...args: any[]) => void): () => void {
    return this.bus.on(event, handler);
  }

  // ── Inject events (for puddle/testing — simulate cloud messages) ──

  /** Inject a transcription event as if it came from the cloud */
  injectTranscription(event: TranscriptionEvent): void {
    this.transcription.handleEvent(event);
  }

  /** Inject a display event as if it came from a mini app via the cloud */
  injectDisplayEvent(event: DisplayEvent): void {
    this.display.handleEvent(event);
  }

  // ── Cleanup ────────────────────────────────────────────────

  destroy(): void {
    this.glasses.destroy();
    this.apps.destroy();
    this.connection.destroy();
    this.display.destroy();
    this.transcription.destroy();
    this.bus.removeAll();
  }
}
