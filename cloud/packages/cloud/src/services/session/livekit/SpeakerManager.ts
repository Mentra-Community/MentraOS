import { Logger } from "pino";
import { logger as rootLogger } from "../../logging/pino-logger";
import UserSession from "../UserSession";
import { AudioPlayRequest, AudioStopRequest } from "@mentra/sdk";

export class SpeakerManager {
  private readonly logger: Logger;
  private readonly session: UserSession;

  constructor(session: UserSession) {
    this.session = session;
    this.logger = rootLogger.child({
      service: "SpeakerManager",
      userId: session.userId,
    });

    // Hook JSON events from the bridge (optional)
    const bridge = this.session.liveKitManager.getBridgeClient();
    bridge?.onEvent((evt: any) => this.handleBridgeEvent(evt));
  }

  async ensureReady(): Promise<boolean> {
    try {
      // Only proceed if LiveKit is configured for this session
      const hasLiveKit = !!this.session.liveKitManager.getUrl();
      if (!hasLiveKit) {
        this.logger.info(
          { feature: "livekit" },
          "SpeakerManager disabled: LiveKit not configured for session",
        );
        return false;
      }
      await (this.session.liveKitManager as any).ensureBridgeConnected?.();
      const bridge = this.session.liveKitManager.getBridgeClient();
      if (bridge) {
        // Reattach handler on every ensure to cover reconnects
        bridge.onEvent((evt: any) => this.handleBridgeEvent(evt));
      }
      return !!bridge && bridge.isConnected();
    } catch (e) {
      this.logger.warn(e as Error, "SpeakerManager bridge not ready");
      return false;
    }
  }

  async start(msg: AudioPlayRequest): Promise<void> {
    if (!(await this.ensureReady())) return;
    const bridge = this.session.liveKitManager.getBridgeClient();
    if (!bridge) return;
    try {
      this.logger.info(
        { requestId: msg.requestId, url: msg.audioUrl },
        "SpeakerManager start",
      );
      bridge.playUrl({
        requestId: msg.requestId,
        url: msg.audioUrl,
        volume: msg.volume,
        stopOther: msg.stopOtherAudio,
        trackId: msg.trackId ?? 0, // Default to track 0 (speaker)
      });
    } catch (e) {
      this.logger.error(e as Error, "SpeakerManager failed to start");
    }
  }

  async stop(msg: AudioStopRequest): Promise<void> {
    if (!(await this.ensureReady())) return;
    const bridge = this.session.liveKitManager.getBridgeClient();
    if (!bridge) return;
    try {
      this.logger.info({ packageName: msg.packageName }, "SpeakerManager stop");
      bridge.stopPlayback();
    } catch (e) {
      this.logger.error(e as Error, "SpeakerManager failed to stop");
    }
  }

  handleBridgeEvent(evt: any): void {
    if (!evt || typeof evt !== "object") return;
    if (evt.type === "play_started") {
      this.logger.info(
        { requestId: evt.requestId, url: evt.url },
        "SpeakerManager play started",
      );
      return;
    }
    if (evt.type === "play_complete") {
      this.logger.info(
        {
          requestId: evt.requestId,
          success: evt.success,
          durationMs: evt.durationMs,
          error: evt.error,
        },
        "SpeakerManager play complete",
      );
      return;
    }
    if (evt.type === "error") {
      this.logger.warn({ error: evt.error }, "SpeakerManager bridge error");
      return;
    }
  }

  dispose(): void {
    // nothing to clean up yet
  }
}

export default SpeakerManager;
