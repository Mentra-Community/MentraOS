// cloud/src/services/client/livekit.service.ts
// LiveKit token minting utilities for client APIs

import { logger } from "../../services/logging/pino-logger";
import { AccessToken, VideoGrant } from "livekit-server-sdk";

const EMAIL_IDENTITY_MAX = 128;
// const DEFAULT_TTL = 300; // seconds

export async function mintTestToken(email: string, roomName: string) {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    throw new Error("LIVEKIT_URL/API_KEY/API_SECRET not configured");
  }

  const allowRegex = process.env.LIVEKIT_ALLOWED_ROOMS_REGEX;
  if (allowRegex && !new RegExp(allowRegex).test(roomName)) {
    throw new Error("roomName not allowed");
  }

  const identity = sanitizeIdentity(email);

  const grant: VideoGrant & { canPublishData?: boolean } = {
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    // data channels for signaling/controls if needed
    canPublishData: true,
  };
  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: identity,
    ttl: "5m",
  });
  at.addGrant(grant);

  const token = await at.toJwt();

  logger.info({ identity, roomName }, "Minted LiveKit test token");
  return { url, token, identity };
}

export async function mintToken(email: string, roomName: string) {
  const url = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!url || !apiKey || !apiSecret) {
    throw new Error("LIVEKIT_URL/API_KEY/API_SECRET not configured");
  }

  const allowRegex = process.env.LIVEKIT_ALLOWED_ROOMS_REGEX;
  if (allowRegex && !new RegExp(allowRegex).test(roomName)) {
    throw new Error("roomName not allowed");
  }

  const identity = email; //sanitizeIdentity(email);

  const grant: VideoGrant & { canPublishData?: boolean } = {
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    // data channels for signaling/controls if needed
    canPublishData: true,
  };
  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: identity,
    ttl: "1440m",
  });
  at.addGrant(grant);

  const token = await at.toJwt();

  logger.info({ identity, roomName }, "Minted LiveKit test token");
  return { url, token, identity };
}

function sanitizeIdentity(email: string): string {
  const base = String(email).trim().toLowerCase();
  const safe = base.replace(/\s+/g, "_").replace(/[^a-z0-9@._-]/g, "");
  const prefixed = `test-${safe}`;
  return prefixed.length > EMAIL_IDENTITY_MAX
    ? prefixed.slice(0, EMAIL_IDENTITY_MAX)
    : prefixed;
}
