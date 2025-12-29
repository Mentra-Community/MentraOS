import dotenv from "dotenv";
import { AccessToken, VideoGrant, RoomServiceClient } from "livekit-server-sdk";
import { Logger } from "pino";

import { logger as rootLogger } from "../../logging/pino-logger";
import UserSession from "../UserSession";

import LiveKitGrpcClient from "./LiveKitGrpcClient";

dotenv.config();

export class LiveKitManager {
  private readonly logger: Logger;
  private readonly session: UserSession;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly livekitUrl: string;
  private bridgeClient: LiveKitGrpcClient | null = null;
  // private micEnabled = false;
  private healthTimer: NodeJS.Timeout | null = null;
  private lastRejoinAttemptAt: number | null = null;

  constructor(session: UserSession) {
    this.session = session;

    const startMs = (session as any).startTime instanceof Date ? (session as any).startTime.getTime() : Date.now();
    const lkTraceId = `livekit:${session.userId}:${startMs}`;
    this.logger = rootLogger.child({
      service: "LiveKitManager",
      userId: session.userId,
      feature: "livekit",
      lkTraceId,
    });
    this.apiKey = process.env.LIVEKIT_API_KEY || "";
    this.apiSecret = process.env.LIVEKIT_API_SECRET || "";
    this.livekitUrl = process.env.LIVEKIT_URL || "";
    this.logger.info(
      {
        apiKey: this.apiKey,
        apiSecret: this.apiSecret,
        livekitUrl: this.livekitUrl,
      },
      "⚡️ LiveKitManager initialized",
    );
    if (!this.apiKey || !this.apiSecret || !this.livekitUrl) {
      this.logger.warn("LIVEKIT env vars are not fully configured");
    }
  }

  getRoomName(): string {
    return this.session.userId;
  }

  getUrl(): string {
    return this.livekitUrl;
  }

  async mintClientPublishToken(): Promise<string | null> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const at = new AccessToken(this.apiKey, this.apiSecret, {
        identity: this.session.userId,
        ttl: 300,
      });
      const grant: VideoGrant = {
        roomJoin: true,
        room: this.getRoomName(),
        canPublish: true,
        canSubscribe: false,
        canPublishData: true,
      } as VideoGrant;
      at.addGrant(grant);
      const token = await at.toJwt();
      this.logger.info({ roomName: this.getRoomName(), token }, "Minted client publish token");
      return token;
    } catch (error) {
      this.logger.error(error, "Failed to mint client publish token");
      return null;
    }
  }

  /**
   * Handle LIVEKIT_INIT by preparing subscriber and returning connection info.
   */
  async handleLiveKitInit(): Promise<{
    url: string;
    roomName: string;
    token: string;
  } | null> {
    const url = this.getUrl();
    const roomName = this.getRoomName();

    // Mint publish token for clients
    const token = await this.mintClientPublishToken();

    if (!url || !roomName || !token) {
      this.logger.warn(
        {
          hasUrl: Boolean(url),
          hasRoom: Boolean(roomName),
          hasToken: Boolean(token),
          feature: "livekit",
        },
        "LIVEKIT_INFO not ready (missing url/room/token)",
      );
      return null;
    }

    try {
      await this.startBridgeSubscriber({ url, roomName });
    } catch (e) {
      const logger = this.logger.child({ feature: "livekit" });
      logger.error(e, "Failed to start bridge subscriber");
    }

    this.logger.info({ roomName }, "Returning LiveKit info");
    return { url, roomName, token };
  }

  async mintClientSubscribeToken(): Promise<string | null> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const at = new AccessToken(this.apiKey, this.apiSecret, {
        identity: this.session.userId,
        ttl: 300,
      });
      const grant: VideoGrant = {
        roomJoin: true,
        room: this.getRoomName(),
        canPublish: false,
        canSubscribe: true,
      } as VideoGrant;
      at.addGrant(grant);
      const token = await at.toJwt();
      this.logger.info({ roomName: this.getRoomName(), token }, "Minted client subscribe token");
      return token;
    } catch (error) {
      this.logger.error(error, "Failed to mint client subscribe token");
      return null;
    }
  }

  async mintAgentSubscribeToken(): Promise<string | null> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const at = new AccessToken(this.apiKey, this.apiSecret, {
        identity: `cloud-agent:${this.session.userId}`,
        ttl: 60000,
      });
      const grant: VideoGrant = {
        roomJoin: true,
        room: this.getRoomName(),
        canPublish: false,
        canSubscribe: true,
      } as VideoGrant;
      at.addGrant(grant);
      const token = await at.toJwt();
      this.logger.info({ roomName: this.getRoomName(), token }, "Minted agent subscribe token");
      return token;
    } catch (error) {
      this.logger.error(error, "Failed to mint agent subscribe token");
      return null;
    }
  }

  /**
   * Mint a token for the bridge that allows both publishing and subscribing
   * so the Go bridge can publish server-side audio and we can subscribe to streams.
   */
  async mintAgentBridgeToken(): Promise<string | null> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const at = new AccessToken(this.apiKey, this.apiSecret, {
        identity: `cloud-agent:${this.session.userId}`,
        ttl: "600000m",
      });
      const grant: VideoGrant = {
        roomJoin: true,
        room: this.getRoomName(),
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      } as VideoGrant;
      at.addGrant(grant);
      const token = await at.toJwt();
      this.logger.info({ roomName: this.getRoomName(), token }, "Minted agent bridge token (pub+sub)");
      return token;
    } catch (error) {
      this.logger.error(error, "Failed to mint agent bridge token");
      return null;
    }
  }

  /**
   * Start subscriber via Go livekit-bridge and stream 16 kHz PCM to AudioManager.
   */
  private async startBridgeSubscriber(info: { url: string; roomName: string }): Promise<void> {
    if (this.bridgeClient && this.bridgeClient.isConnected()) {
      this.logger.debug("Bridge subscriber already connected");
      return;
    }
    const targetIdentity = this.session.userId; // client publishes as plain userId
    this.bridgeClient = new LiveKitGrpcClient(this.session);
    const bridgeToken = await this.mintAgentBridgeToken();
    if (!bridgeToken) {
      this.logger.warn("Failed to mint bridge token for WS bridge");
      return;
    }
    await this.bridgeClient.connect({
      url: info.url,
      roomName: info.roomName,
      token: bridgeToken,
      targetIdentity,
    });
    this.logger.info({ feature: "livekit", room: info.roomName }, "Bridge subscriber connected");

    // Health monitoring interval - no logging, just keeps internal state fresh
    // Logging every 10 seconds creates too much noise in production
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => {
        // Keep the health check running for internal monitoring,
        // but don't log routine health checks
        const _isConnected = this.bridgeClient?.isConnected() ?? false;
        // Health state available via getBridgeClient().isConnected() if needed
      }, 10000);
    }
  }

  /** Expose the current bridge client for server playback control. */
  public getBridgeClient(): LiveKitGrpcClient | null {
    return this.bridgeClient;
  }

  public async ensureBridgeConnected(): Promise<void> {
    if (this.bridgeClient && this.bridgeClient.isConnected()) return;
    if (this.bridgeClient && this.bridgeClient.isConnecting()) {
      this.logger.debug({ feature: "livekit" }, "Bridge connection already in progress, skipping");
      return;
    }
    this.logger.info({ feature: "livekit" }, "Ensuring bridge subscriber is connected");
    await this.startBridgeSubscriber({
      url: this.getUrl(),
      roomName: this.getRoomName(),
    });
  }

  // Signal from MicrophoneManager
  public onMicStateChange(): void {
    // this.micEnabled = isOn;
    this.applySubscribeState();
  }

  private applySubscribeState(): void {
    const shouldSubscribe = this.session.microphoneManager.isEnabled();
    this.ensureBridgeConnected()
      .then(() => {
        if (!this.bridgeClient || !this.bridgeClient.isConnected()) {
          this.logger.warn({ feature: "livekit" }, "Bridge not connected; cannot toggle subscribe");
          return;
        }
        if (shouldSubscribe) {
          this.logger.info({ feature: "livekit", target: this.session.userId }, "Enabling bridge subscribe");
          this.bridgeClient.enableSubscribe(this.session.userId);
        } else {
          this.logger.info({ feature: "livekit" }, "Disabling bridge subscribe");
          this.bridgeClient.disableSubscribe();
        }
      })
      .catch((err) => this.logger.error({ feature: "livekit", err }, "Failed ensuring bridge connection"));
  }

  public dispose(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.bridgeClient) {
      this.logger.info({ feature: "livekit" }, "Disposing bridge client");
      this.bridgeClient.dispose();
      this.bridgeClient = null;
    }
  }

  /**
   * Query the Go bridge for room connectivity status for this session.
   * Returns null if the bridge client is not available.
   */
  public async getBridgeStatus(): Promise<{
    connected: boolean;
    participant_id?: string;
    participant_count?: number;
    last_disconnect_at?: number;
    last_disconnect_reason?: string;
    server_version?: string;
  } | null> {
    if (!this.bridgeClient) {
      this.logger.warn({ feature: "livekit" }, "getBridgeStatus: no bridge client");
      return null;
    }
    try {
      // LiveKitGrpcClient.getStatus() returns the raw status object
      const status = await (this.bridgeClient as any).getStatus();
      this.logger.info({ feature: "livekit", status }, "Bridge status fetched");
      return status ?? null;
    } catch (err) {
      this.logger.warn({ feature: "livekit", err }, "Failed to fetch bridge status");
      return null;
    }
  }

  /**
   * Get the HTTP URL for LiveKit API calls (converts wss:// to https://)
   */
  private getHttpUrl(): string {
    return this.livekitUrl.replace(/^wss?:\/\//, (m) => (m === "wss://" ? "https://" : "http://"));
  }

  /**
   * Check if the mobile client is currently in the LiveKit room.
   * Uses LiveKit Server SDK to query room participants.
   */
  public async isClientInRoom(): Promise<boolean> {
    if (!this.apiKey || !this.apiSecret || !this.livekitUrl) {
      this.logger.warn({ feature: "livekit" }, "Cannot check room - LiveKit not configured");
      return false;
    }

    try {
      const roomService = new RoomServiceClient(this.getHttpUrl(), this.apiKey, this.apiSecret);
      const participants = await roomService.listParticipants(this.getRoomName());
      const clientInRoom = participants.some((p) => p.identity === this.session.userId);

      this.logger.debug(
        {
          feature: "livekit",
          roomName: this.getRoomName(),
          clientIdentity: this.session.userId,
          clientInRoom,
          participantCount: participants.length,
        },
        "Checked if client in room",
      );

      return clientInRoom;
    } catch (err) {
      this.logger.error({ feature: "livekit", err }, "Failed to check if client in room");
      return false;
    }
  }

  /**
   * Get detailed room status including all participants.
   * Useful for debugging LiveKit connection issues.
   */
  public async getRoomStatus(): Promise<{
    roomName: string;
    clientInRoom: boolean;
    bridgeInRoom: boolean;
    participants: string[];
    micEnabled: boolean;
    bridgeConnected: boolean;
  }> {
    const roomName = this.getRoomName();
    const clientIdentity = this.session.userId;
    const bridgeIdentity = `cloud-agent:${this.session.userId}`;
    const micEnabled = this.session.microphoneManager?.isEnabled() ?? false;
    const bridgeConnected = this.bridgeClient?.isConnected() ?? false;

    let participants: string[] = [];
    let clientInRoom = false;
    let bridgeInRoom = false;

    if (this.apiKey && this.apiSecret && this.livekitUrl) {
      try {
        const roomService = new RoomServiceClient(this.getHttpUrl(), this.apiKey, this.apiSecret);
        const parts = await roomService.listParticipants(roomName);
        participants = parts.map((p) => p.identity);
        clientInRoom = participants.includes(clientIdentity);
        bridgeInRoom = participants.includes(bridgeIdentity);
      } catch (err) {
        this.logger.error({ feature: "livekit", err }, "Failed to get room participants");
      }
    }

    const status = {
      roomName,
      clientInRoom,
      bridgeInRoom,
      participants,
      micEnabled,
      bridgeConnected,
    };

    this.logger.info({ feature: "livekit", ...status }, "Room status");
    return status;
  }

  /**
   * Rejoin the LiveKit room when the bridge was kicked/disconnected.
   * Applies a small backoff window to avoid rejoin storms.
   */
  public async rejoinBridge(): Promise<void> {
    const now = Date.now();
    const backoffMs = parseInt(process.env.LIVEKIT_REJOIN_BACKOFF_MS || "2000", 10) || 2000;

    if (this.lastRejoinAttemptAt && now - this.lastRejoinAttemptAt < backoffMs) {
      this.logger.warn(
        {
          feature: "livekit",
          backoffMs,
          sinceLast: now - this.lastRejoinAttemptAt,
        },
        "Skipping rejoin due to backoff window",
      );
      return;
    }
    this.lastRejoinAttemptAt = now;

    if (!this.bridgeClient) {
      this.bridgeClient = new LiveKitGrpcClient(this.session);
    }

    const token = await this.mintAgentBridgeToken();
    if (!token) {
      this.logger.warn({ feature: "livekit" }, "Failed to mint bridge token for rejoin");
      return;
    }

    const params = {
      url: this.getUrl(),
      roomName: this.getRoomName(),
      token,
      targetIdentity: this.session.userId,
    };

    try {
      await (this.bridgeClient as any).rejoin(params);
      this.logger.info({ feature: "livekit", room: params.roomName }, "Bridge rejoined LiveKit room");
    } catch (err) {
      this.logger.error({ feature: "livekit", err }, "Bridge rejoin failed");
    }
  }
}

export default LiveKitManager;
