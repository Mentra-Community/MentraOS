import type { MentraSession } from "@mentra/sdk";
import type { StateManager } from "../state/StateManager";
import type { StreamState } from "../../shared/state";

export interface ManagedStreamUrls {
  hlsUrl?: string;
  dashUrl?: string;
  webrtcUrl?: string;
  previewUrl?: string;
  streamId?: string;
}

interface InternalStreamState {
  active: boolean;
  mode: "direct" | "managed" | null;
  url: string | null;
  startedAt: Date | null;
  managedUrls: ManagedStreamUrls | null;
  lastStatus: string | null;
  lastError: string | null;
}

const VIDEO_CONFIG = {
  width: 1280,
  height: 720,
  bitrate: 4000000,
  frameRate: 15,
};

/**
 * Manages stream lifecycle for a single user.
 * Owned by UserSession — one StreamManager per user.
 */
export class StreamManager {
  private session: MentraSession | null = null;
  private statusCleanup: (() => void) | null = null;
  private stateManager: StateManager;

  private state: InternalStreamState = {
    active: false,
    mode: null,
    url: null,
    startedAt: null,
    managedUrls: null,
    lastStatus: null,
    lastError: null,
  };

  constructor(stateManager: StateManager) {
    this.stateManager = stateManager;
  }

  // ─── Session binding ─────────────────────────────────────────────────────

  attachSession(session: MentraSession): void {
    this.detachSession();
    this.session = session;

    // Check for existing streams from a previous session (orphaned stream adoption).
    // This asks the cloud "is there already an active stream for this user?"
    // and populates our state with full URLs if so.
    this.checkForExistingStream(session);

    this.statusCleanup = session.camera.onStreamStatus((status: any) => {
      const statusText =
        typeof status === "object" && status !== null
          ? status.status || "unknown"
          : String(status);

      this.state.lastStatus = statusText;

      if (statusText === "active" && !this.state.active) {
        this.state.active = true;

        // Adopt orphaned stream — if we don't have URLs yet (e.g. app restarted
        // while stream was still running), pull them from the status object.
        if (
          !this.state.managedUrls &&
          typeof status === "object" &&
          status !== null
        ) {
          const hlsUrl = status.hlsUrl || status.hls_url;
          const dashUrl = status.dashUrl || status.dash_url;
          const webrtcUrl = status.webrtcUrl || status.webrtc_url;
          const previewUrl = status.previewUrl || status.preview_url;
          const streamId = status.streamId || status.stream_id || status.uid;

          if (hlsUrl || webrtcUrl) {
            this.state.mode = "managed";
            this.state.url = webrtcUrl || hlsUrl || "managed";
            this.state.startedAt = this.state.startedAt || new Date();
            this.state.managedUrls = {
              hlsUrl,
              dashUrl,
              webrtcUrl,
              previewUrl,
              streamId,
            };
            session.logger.info("Adopted orphaned managed stream");
          } else if (!this.state.mode) {
            // Active but no managed URLs — likely a direct stream
            this.state.mode = "direct";
            this.state.url = status.streamUrl || status.stream_url || "direct";
            this.state.startedAt = this.state.startedAt || new Date();
            session.logger.info("Adopted orphaned direct stream");
          }
        }

        this.pushState();
      }

      if (
        statusText === "stopped" ||
        statusText === "error" ||
        statusText === "timeout"
      ) {
        this.reset();
        if (statusText === "error") {
          this.state.lastError =
            status?.message || status?.errorDetails || "Stream error";
        }
        this.pushState();
      }

      session.display.showTextWall(`Stream: ${statusText}`);
    });
  }

  /**
   * Ask the cloud if there's already an active stream for this user.
   * If yes, adopt it — populate our state with the stream info and push to SSE.
   */
  private async checkForExistingStream(session: MentraSession): Promise<void> {
    try {
      const existing = await (session.camera as any).checkExistingStream();

      if (!existing.hasActiveStream || !existing.streamInfo) return;

      // Don't overwrite if we already know about an active stream
      if (this.state.active) return;

      const info = existing.streamInfo;
      session.logger.info(
        { type: info.type, streamId: info.streamId },
        "Adopting existing stream from cloud",
      );

      this.state.active = true;
      this.state.lastStatus = info.status || "active";
      this.state.startedAt = info.createdAt
        ? new Date(info.createdAt)
        : new Date();

      if (info.type === "managed") {
        this.state.mode = "managed";
        this.state.url = info.webrtcUrl || info.hlsUrl || "managed";
        this.state.managedUrls = {
          hlsUrl: info.hlsUrl,
          dashUrl: info.dashUrl,
          webrtcUrl: info.webrtcUrl,
          previewUrl: info.previewUrl,
          streamId: info.streamId,
        };
      } else {
        this.state.mode = "direct";
        this.state.url = (info as any).streamUrl || "direct";
        this.state.managedUrls = null;
      }

      this.pushState();

      const label =
        info.type === "managed"
          ? `Adopted stream\n${info.webrtcUrl || info.hlsUrl || info.streamId}`
          : `Adopted stream\n${(info as any).streamUrl || info.streamId}`;
      session.display.showTextWall(label);
    } catch (err) {
      session.logger.debug(err, "checkExistingStream failed (non-fatal)");
    }
  }

  detachSession(): void {
    if (this.statusCleanup) {
      this.statusCleanup();
      this.statusCleanup = null;
    }
    this.session = null;
  }

  // ─── Stream control ──────────────────────────────────────────────────────

  async startManaged(): Promise<ManagedStreamUrls | null> {
    if (!this.session) {
      this.state.lastError = "No active session";
      this.pushState();
      return null;
    }

    if (this.state.active) {
      // Auto-stop the stale/existing stream before starting a fresh one.
      // This handles the case where checkForExistingStream() adopted a
      // stale stream from a previous session — the user shouldn't have
      // to manually stop it before starting a new one.
      this.session.logger.info(
        "Auto-stopping existing stream before starting new one",
      );
      await this.stop();
    }

    this.state.lastError = null;

    try {
      this.session.display.showTextWall("Starting managed stream...");

      const result = (await this.session.camera.startStream({
        quality: "720p",
        video: VIDEO_CONFIG,
      })) as any;

      const viewerUrl = result?.webrtcUrl || result?.hlsUrl;
      const managedUrls: ManagedStreamUrls = {
        hlsUrl: result?.hlsUrl,
        dashUrl: result?.dashUrl,
        webrtcUrl: result?.webrtcUrl,
        previewUrl: result?.previewUrl,
        streamId: result?.streamId,
      };

      this.state.active = true;
      this.state.mode = "managed";
      this.state.url = viewerUrl || "managed";
      this.state.startedAt = new Date();
      this.state.managedUrls = managedUrls;
      this.state.lastStatus = "active";
      this.pushState();

      this.session.display.showTextWall(
        `Streaming live\n${viewerUrl || "managed"}`,
      );

      return managedUrls;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.lastError = message;
      this.pushState();
      this.session.display.showTextWall(`Stream error:\n${message}`);
      return null;
    }
  }

  async startDirect(streamUrl: string): Promise<void> {
    if (!this.session) {
      this.state.lastError = "No active session";
      this.pushState();
      return;
    }

    if (this.state.active) {
      this.session.logger.info(
        "Auto-stopping existing stream before starting new one",
      );
      await this.stop();
    }

    this.state.lastError = null;

    try {
      this.session.display.showTextWall(`Streaming to:\n${streamUrl}`);

      await this.session.camera.startStream({
        direct: streamUrl,
        video: VIDEO_CONFIG,
      });

      this.state.active = true;
      this.state.mode = "direct";
      this.state.url = streamUrl;
      this.state.startedAt = new Date();
      this.state.managedUrls = null;
      this.state.lastStatus = "started";
      this.pushState();

      this.session.display.showTextWall(`Streaming live\n${streamUrl}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.lastError = message;
      this.pushState();
      this.session.display.showTextWall(`Stream error:\n${message}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.session) {
      return;
    }

    try {
      await this.session.camera.stopStream();
      this.session.display.showTextWall("Stream stopped");
    } catch (error) {
      // Ignore stop errors — the stream may already be dead
    }

    this.reset();
    this.pushState();
  }

  // ─── State ───────────────────────────────────────────────────────────────

  getState(): InternalStreamState {
    return { ...this.state };
  }

  getSnapshot(): StreamState {
    return {
      active: this.state.active,
      mode: this.state.mode,
      url: this.state.url,
      startedAt: this.state.startedAt?.toISOString() ?? null,
      status:
        this.state.lastStatus || (this.state.active ? "streaming" : "idle"),
      error: this.state.lastError,
      hlsUrl: this.state.managedUrls?.hlsUrl ?? null,
      dashUrl: this.state.managedUrls?.dashUrl ?? null,
      webrtcUrl: this.state.managedUrls?.webrtcUrl ?? null,
      previewUrl: this.state.managedUrls?.previewUrl ?? null,
      streamId: this.state.managedUrls?.streamId ?? null,
    };
  }

  isActive(): boolean {
    return this.state.active;
  }

  private reset(): void {
    this.state.active = false;
    this.state.mode = null;
    this.state.url = null;
    this.state.startedAt = null;
    this.state.managedUrls = null;
    this.state.lastStatus = null;
  }

  private pushState(): void {
    this.stateManager.set("stream", this.getSnapshot());
  }
}
