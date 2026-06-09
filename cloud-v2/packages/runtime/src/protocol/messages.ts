/**
 * @fileoverview The WebSocket message registry.
 *
 * Each transport `type` maps 1:1 to an enveloped zod schema; the schemas are
 * combined into discriminated unions on `type` for parse-time validation on
 * both ends. Transport-level types live in protocol.md; per-service push events
 * (stream.transcript / stream.translation) are registered by the audio service
 * doc but their schemas live here so the one union validates everything.
 *
 * Pure + isomorphic: no server imports.
 */
import { z } from "zod";
import { envelope } from "./envelope";
import { connectionInitPayloadSchema, connectionAckPayloadSchema } from "./handshake";
import { controlPingPayloadSchema, controlPongPayloadSchema } from "./control";
import { protocolErrorPayloadSchema } from "./errors";
import { transcriptionDataSchema, translationDataSchema, udpLivenessAckPayloadSchema } from "./audio";
import { photoReadyPayloadSchema, photoErrorPayloadSchema } from "./camera";

// --- Per-type enveloped message schemas -------------------------------------

export const connectionInitMessage = envelope("connection.init", connectionInitPayloadSchema);
export const connectionAckMessage = envelope("connection.ack", connectionAckPayloadSchema);
export const controlPingMessage = envelope("control.ping", controlPingPayloadSchema);
export const controlPongMessage = envelope("control.pong", controlPongPayloadSchema);
export const errorMessage = envelope("error", protocolErrorPayloadSchema);

// Audio service push events (registered in audio/protocol.md).
export const streamTranscriptMessage = envelope("stream.transcript", transcriptionDataSchema);
export const streamTranslationMessage = envelope("stream.translation", translationDataSchema);
export const audioUdpLivenessAckMessage = envelope("audio.udp_liveness_ack", udpLivenessAckPayloadSchema);

// Camera service push events (registered in camera/spec.md).
export const photoReadyMessage = envelope("photo.ready", photoReadyPayloadSchema);
export const photoErrorMessage = envelope("photo.error", photoErrorPayloadSchema);

// --- Direction-scoped unions ------------------------------------------------

/** Messages the client sends to the cloud. */
export const clientToCloudMessage = z.discriminatedUnion("type", [
  connectionInitMessage,
  controlPingMessage,
  controlPongMessage,
]);
export type ClientToCloudMessage = z.infer<typeof clientToCloudMessage>;

/** Messages the cloud pushes to the client. */
export const cloudToClientMessage = z.discriminatedUnion("type", [
  connectionAckMessage,
  controlPingMessage,
  controlPongMessage,
  errorMessage,
  streamTranscriptMessage,
  streamTranslationMessage,
  audioUdpLivenessAckMessage,
  photoReadyMessage,
  photoErrorMessage,
]);
export type CloudToClientMessage = z.infer<typeof cloudToClientMessage>;

/** Every known message in either direction. */
export const anyMessage = z.discriminatedUnion("type", [
  connectionInitMessage,
  connectionAckMessage,
  controlPingMessage,
  controlPongMessage,
  errorMessage,
  streamTranscriptMessage,
  streamTranslationMessage,
  audioUdpLivenessAckMessage,
  photoReadyMessage,
  photoErrorMessage,
]);
export type AnyMessage = z.infer<typeof anyMessage>;
