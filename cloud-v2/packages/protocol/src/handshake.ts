/**
 * @fileoverview Handshake payloads: connection.init and connection.ack.
 *
 * Mirrors docs/issues/002-cloud-runtime/protocol.md ("Auth and handshake").
 * Service-scoped config rides in scoped blocks; audio is the only one today.
 * Pure + isomorphic: no server imports.
 */
import { z } from "zod";
import { audioSubscriptionSchema } from "./audio";

// --- connection.init (client to cloud) --------------------------------------

export const connectionInitPayloadSchema = z.object({
  // omitted if provided via the ?token= fallback
  token: z.string().optional(),
  // semver of the client protocol build, e.g. "2.0.0"
  protocolVersion: z.string(),
  client: z
    .object({
      platform: z.enum(["ios", "android"]),
      appVersion: z.string().optional(),
    })
    .optional(),
  // Service-scoped config blocks. Audio is the only one today.
  audio: z
    .object({
      codec: z.enum(["lc3", "pcm"]),
      sampleRate: z.number().int(), // e.g. 16000
      // LC3 bitrate / frame size in bytes. Only meaningful when codec is
      // "lc3"; omitted PCM sessions keep treating payload bytes as PCM.
      frameSizeBytes: z.union([z.literal(20), z.literal(40), z.literal(60)]).optional(),
      // Optional initial subscription set, seeded atomically with the session
      // so audio that starts before the first REST update is not transcribed
      // with an empty set.
      initialSubscriptions: z.array(audioSubscriptionSchema).optional(),
    })
    .optional(),
});
export type ConnectionInit = z.infer<typeof connectionInitPayloadSchema>;

// --- connection.ack (cloud to client) ---------------------------------------

export const connectionAckPayloadSchema = z.object({
  sessionId: z.string(), // control-plane runtime session id
  negotiatedVersion: z.string(),
  // Audio session ingest coordinates (audio service, UDP path).
  audio: z
    .object({
      sessionTag: z.number().int(), // u32 stamped into UDP audio frames
      udp: z.object({ host: z.string(), port: z.number().int() }),
      // Per-session key for encrypting UDP audio. Delivered here because the
      // handshake is over the TLS WebSocket.
      encryption: z.object({
        algorithm: z.literal("xsalsa20-poly1305"), // NaCl secretbox
        key: z.string(), // base64, 32 bytes
      }),
    })
    .optional(),
});
export type ConnectionAck = z.infer<typeof connectionAckPayloadSchema>;
