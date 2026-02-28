import { Logger } from "pino";
import { logger as rootLogger } from "../../logging/pino-logger";
import { AccessToken } from "livekit-server-sdk";

export interface LiveKitGrants {
  roomJoin?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  room?: string;
}

export interface LiveKitTokenRequest {
  identity: string;
  roomName: string;
  grants: LiveKitGrants;
  ttlSeconds?: number;
}

export class LiveKitTokenService {
  private readonly logger: Logger;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly livekitUrl: string;

  constructor() {
    this.logger = rootLogger.child({ service: "LiveKitTokenService" });
    this.apiKey = process.env.LIVEKIT_API_KEY || "";
    this.apiSecret = process.env.LIVEKIT_API_SECRET || "";
    this.livekitUrl = process.env.LIVEKIT_URL || "";

    if (!this.apiKey || !this.apiSecret || !this.livekitUrl) {
      this.logger.warn("LIVEKIT env vars are not fully configured");
    }
  }

  getUrl(): string {
    return this.livekitUrl;
  }

  async mintAccessTokenAsync(req: LiveKitTokenRequest): Promise<string | null> {
    if (!this.apiKey || !this.apiSecret) {
      this.logger.error("LIVEKIT_API_KEY/SECRET missing");
      return null;
    }
    try {
      const at = new AccessToken(this.apiKey, this.apiSecret, {
        identity: req.identity,
        ttl: req.ttlSeconds || 300,
      });
      at.addGrant({
        roomJoin: req.grants.roomJoin ?? true,
        canPublish: req.grants.canPublish ?? false,
        canSubscribe: req.grants.canSubscribe ?? false,
        room: req.grants.room || req.roomName,
      } as any);
      const token = await at.toJwt();
      return token as unknown as string;
    } catch (error) {
      this.logger.error({ error }, "Failed to mint LiveKit access token");
      return null;
    }
  }
}

export const liveKitTokenService = new LiveKitTokenService();
