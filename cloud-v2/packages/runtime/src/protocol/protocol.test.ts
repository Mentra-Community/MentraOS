/**
 * @fileoverview Exhaustive tests for the `@mentra/cloud-runtime/protocol` types.
 *
 * Goal: 100% coverage of the protocol package. Every schema parses a valid
 * example and rejects an invalid one; every discriminated union routes each of
 * its variants and rejects unknown ones; the envelope helper builds the right
 * shape. These types are the one contract the cloud server, the cloud-client,
 * and the test harness all validate against, so they are worth pinning hard.
 */
import { describe, test, expect } from "bun:test";
import { z } from "zod";

import {
  // envelope
  PROTOCOL_MAJOR,
  envelope,
  envelopeSchema,
  // audio: subscriptions
  languageSourceSchema,
  transcriptionSubscriptionSchema,
  translationSubscriptionSchema,
  audioSubscriptionSchema,
  // audio: results
  transcriptionTokenSchema,
  transcriptionDataSchema,
  translationDataSchema,
  udpLivenessAckPayloadSchema,
  // handshake
  connectionInitPayloadSchema,
  connectionAckPayloadSchema,
  // control
  controlPingPayloadSchema,
  controlPongPayloadSchema,
  // errors
  PROTOCOL_ERROR_CODES,
  protocolErrorPayloadSchema,
  // messages
  connectionInitMessage,
  connectionAckMessage,
  controlPingMessage,
  controlPongMessage,
  errorMessage,
  streamTranscriptMessage,
  streamTranslationMessage,
  audioUdpLivenessAckMessage,
  clientToCloudMessage,
  cloudToClientMessage,
  anyMessage,
} from "./index";

// === sample payloads, reused across the message tests ===

const transcriptionSub = {
  kind: "transcription" as const,
  language: { mode: "specific" as const, code: "en-US" },
};
const translationSub = {
  kind: "translation" as const,
  source: { mode: "auto" as const },
  target: "es",
};
const transcriptionData = {
  userId: "u1",
  subscription: transcriptionSub,
  text: "hello world",
  isFinal: true,
  startMs: 0,
  endMs: 1000,
  resolvedLanguage: "en-US",
  languageDetected: false,
  tokens: [],
  provider: "soniox",
  timestamp: 1700000000000,
};
const translationData = {
  userId: "u1",
  subscription: translationSub,
  text: "hola mundo",
  isFinal: true,
  startMs: 0,
  endMs: 1000,
  source: { language: "en-US", detected: true },
  target: { language: "es" },
  provider: "soniox",
  timestamp: 1700000000000,
};
const wrap = (type: string, payload: unknown, extra: object = {}) => ({
  v: 2,
  type,
  timestamp: 1,
  payload,
  ...extra,
});

// === envelope ===

describe("envelope", () => {
  test("PROTOCOL_MAJOR is 2", () => {
    expect(PROTOCOL_MAJOR).toBe(2);
  });

  test("envelope() builds a schema that validates a matching message", () => {
    const schema = envelope("x.test", z.object({ n: z.number() }));
    const ok = schema.safeParse({ v: 2, type: "x.test", timestamp: 5, payload: { n: 1 } });
    expect(ok.success).toBe(true);
  });

  test("envelope() accepts the optional id and rejects a wrong type/major/timestamp", () => {
    const schema = envelope("x.test", z.object({ n: z.number() }));
    expect(schema.safeParse({ v: 2, type: "x.test", id: "abc", timestamp: 5, payload: { n: 1 } }).success).toBe(true);
    expect(schema.safeParse({ v: 2, type: "other", timestamp: 5, payload: { n: 1 } }).success).toBe(false);
    expect(schema.safeParse({ v: 1, type: "x.test", timestamp: 5, payload: { n: 1 } }).success).toBe(false);
    expect(schema.safeParse({ v: 2, type: "x.test", timestamp: 1.5, payload: { n: 1 } }).success).toBe(false);
    expect(schema.safeParse({ v: 2, type: "x.test", id: 7, timestamp: 5, payload: { n: 1 } }).success).toBe(false);
  });

  test("envelopeSchema parses any type with an open payload, rejects bad shape", () => {
    expect(envelopeSchema.safeParse({ v: 2, type: "anything", timestamp: 1, payload: { a: 1 } }).success).toBe(true);
    expect(envelopeSchema.safeParse({ v: 2, type: 123, timestamp: 1, payload: {} }).success).toBe(false);
    expect(envelopeSchema.safeParse({ v: 3, type: "x", timestamp: 1, payload: {} }).success).toBe(false);
  });
});

// === audio: subscriptions ===

describe("audio subscriptions", () => {
  test("languageSource: specific and auto (with and without hints)", () => {
    expect(languageSourceSchema.safeParse({ mode: "specific", code: "en-US" }).success).toBe(true);
    expect(languageSourceSchema.safeParse({ mode: "auto" }).success).toBe(true);
    expect(languageSourceSchema.safeParse({ mode: "auto", hints: ["en", "es"] }).success).toBe(true);
    expect(languageSourceSchema.safeParse({ mode: "specific" }).success).toBe(false); // missing code
    expect(languageSourceSchema.safeParse({ mode: "nope" }).success).toBe(false); // bad discriminant
  });

  test("transcription and translation subscription schemas", () => {
    expect(transcriptionSubscriptionSchema.safeParse(transcriptionSub).success).toBe(true);
    expect(translationSubscriptionSchema.safeParse(translationSub).success).toBe(true);
    expect(translationSubscriptionSchema.safeParse({ kind: "translation", source: { mode: "auto" } }).success).toBe(false); // missing target
  });

  test("audioSubscription union routes both kinds and rejects unknown", () => {
    expect(audioSubscriptionSchema.safeParse(transcriptionSub).success).toBe(true);
    expect(audioSubscriptionSchema.safeParse(translationSub).success).toBe(true);
    expect(audioSubscriptionSchema.safeParse({ kind: "captions", language: { mode: "auto" } }).success).toBe(false);
  });
});

// === audio: result types ===

describe("audio result types", () => {
  test("transcriptionToken: minimal valid + optionals + invalid", () => {
    expect(transcriptionTokenSchema.safeParse({ text: "hi", startMs: 0, endMs: 1, confidence: 0.9, isFinal: true }).success).toBe(true);
    expect(transcriptionTokenSchema.safeParse({ text: "hi", startMs: 0, endMs: 1, confidence: 0.9, isFinal: true, speaker: "s1", detectedLanguage: "en" }).success).toBe(true);
    expect(transcriptionTokenSchema.safeParse({ text: "hi", startMs: 0, endMs: 1, isFinal: true }).success).toBe(false); // missing confidence
  });

  test("transcriptionData: full, with optionals + tokens, and invalid", () => {
    expect(transcriptionDataSchema.safeParse(transcriptionData).success).toBe(true);
    expect(
      transcriptionDataSchema.safeParse({
        ...transcriptionData,
        utteranceId: "utt1",
        speakerId: "spk1",
        durationMs: 1000,
        confidence: 0.95,
        tokens: [{ text: "hi", startMs: 0, endMs: 1, confidence: 0.9, isFinal: true }],
      }).success,
    ).toBe(true);
    expect(transcriptionDataSchema.safeParse({ ...transcriptionData, isFinal: "yes" }).success).toBe(false);
    expect(transcriptionDataSchema.safeParse({ ...transcriptionData, subscription: translationSub }).success).toBe(false); // wrong sub kind
  });

  test("translationData: full, with optionals, and invalid", () => {
    expect(translationDataSchema.safeParse(translationData).success).toBe(true);
    expect(
      translationDataSchema.safeParse({
        ...translationData,
        originalText: "hello world",
        speakerId: "spk1",
        durationMs: 1000,
        confidence: 0.9,
        source: { language: "en-US", detected: true, confidence: 0.8 },
      }).success,
    ).toBe(true);
    expect(translationDataSchema.safeParse({ ...translationData, target: { language: 5 } }).success).toBe(false);
  });
});

describe("audio liveness", () => {
  test("udp liveness ack payload validates", () => {
    expect(
      udpLivenessAckPayloadSchema.safeParse({
        sessionId: "s1",
        sessionTag: 123,
        probeId: "probe-1",
        receivedAt: 1700000000000,
      }).success,
    ).toBe(true);
    expect(udpLivenessAckPayloadSchema.safeParse({ sessionTag: 123 }).success).toBe(false);
  });
});

// === handshake ===

describe("handshake", () => {
  test("connection.init: minimal, full (client + audio + initialSubscriptions), invalid", () => {
    expect(connectionInitPayloadSchema.safeParse({ protocolVersion: "2.0.0" }).success).toBe(true);
    expect(
      connectionInitPayloadSchema.safeParse({
        token: "jwt",
        protocolVersion: "2.0.0",
        client: { platform: "ios", appVersion: "1.2.3" },
        audio: {
          codec: "lc3",
          sampleRate: 16000,
          frameSizeBytes: 60,
          initialSubscriptions: [transcriptionSub, translationSub],
        },
      }).success,
    ).toBe(true);
    expect(connectionInitPayloadSchema.safeParse({}).success).toBe(false); // missing protocolVersion
    expect(connectionInitPayloadSchema.safeParse({ protocolVersion: "2.0.0", client: { platform: "web" } }).success).toBe(false); // bad platform
    expect(connectionInitPayloadSchema.safeParse({ protocolVersion: "2.0.0", audio: { codec: "opus", sampleRate: 16000 } }).success).toBe(false); // bad codec
    expect(connectionInitPayloadSchema.safeParse({ protocolVersion: "2.0.0", audio: { codec: "lc3", sampleRate: 16000, frameSizeBytes: 30 } }).success).toBe(false); // bad frame size
  });

  test("connection.ack: minimal, with audio block, invalid", () => {
    expect(connectionAckPayloadSchema.safeParse({ sessionId: "s1", negotiatedVersion: "2.0.0" }).success).toBe(true);
    expect(
      connectionAckPayloadSchema.safeParse({
        sessionId: "s1",
        negotiatedVersion: "2.0.0",
        audio: {
          sessionTag: 12345,
          udp: { host: "1.2.3.4", port: 5000 },
          encryption: { algorithm: "xsalsa20-poly1305", key: "AAAA" },
        },
      }).success,
    ).toBe(true);
    expect(connectionAckPayloadSchema.safeParse({ negotiatedVersion: "2.0.0" }).success).toBe(false); // missing sessionId
    expect(
      connectionAckPayloadSchema.safeParse({
        sessionId: "s1",
        negotiatedVersion: "2.0.0",
        audio: { sessionTag: 1, udp: { host: "h", port: 1 }, encryption: { algorithm: "aes", key: "k" } },
      }).success,
    ).toBe(false); // bad algorithm literal
  });
});

// === control ===

describe("control", () => {
  test("ping/pong accept an empty object and reject extra keys (strict)", () => {
    expect(controlPingPayloadSchema.safeParse({}).success).toBe(true);
    expect(controlPongPayloadSchema.safeParse({}).success).toBe(true);
    expect(controlPingPayloadSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(controlPongPayloadSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

// === errors ===

describe("errors", () => {
  test("PROTOCOL_ERROR_CODES has the right fatal flags", () => {
    expect(PROTOCOL_ERROR_CODES.AUTH_FAILED.fatal).toBe(true);
    expect(PROTOCOL_ERROR_CODES.AUTH_EXPIRED.fatal).toBe(true);
    expect(PROTOCOL_ERROR_CODES.UNSUPPORTED_VERSION.fatal).toBe(true);
    expect(PROTOCOL_ERROR_CODES.BAD_REQUEST.fatal).toBe(false);
    expect(PROTOCOL_ERROR_CODES.UNKNOWN_TYPE.fatal).toBe(false);
    expect(PROTOCOL_ERROR_CODES.INTERNAL.fatal).toBe(false);
  });

  test("protocolError payload: valid and invalid", () => {
    expect(protocolErrorPayloadSchema.safeParse({ code: "AUTH_FAILED", message: "bad token", fatal: true }).success).toBe(true);
    expect(protocolErrorPayloadSchema.safeParse({ code: "X", message: "y" }).success).toBe(false); // missing fatal
  });
});

// === messages + unions ===

describe("messages", () => {
  test("each enveloped message validates its own wrapped payload", () => {
    expect(connectionInitMessage.safeParse(wrap("connection.init", { protocolVersion: "2.0.0" })).success).toBe(true);
    expect(connectionAckMessage.safeParse(wrap("connection.ack", { sessionId: "s1", negotiatedVersion: "2.0.0" })).success).toBe(true);
    expect(controlPingMessage.safeParse(wrap("control.ping", {})).success).toBe(true);
    expect(controlPongMessage.safeParse(wrap("control.pong", {})).success).toBe(true);
    expect(errorMessage.safeParse(wrap("error", { code: "INTERNAL", message: "boom", fatal: false })).success).toBe(true);
    expect(streamTranscriptMessage.safeParse(wrap("stream.transcript", transcriptionData)).success).toBe(true);
    expect(streamTranslationMessage.safeParse(wrap("stream.translation", translationData)).success).toBe(true);
    expect(
      audioUdpLivenessAckMessage.safeParse(
        wrap("audio.udp_liveness_ack", {
          sessionId: "s1",
          sessionTag: 123,
          probeId: "probe-1",
          receivedAt: 1700000000000,
        }),
      ).success,
    ).toBe(true);
  });

  test("clientToCloud union routes its variants and rejects others", () => {
    expect(clientToCloudMessage.safeParse(wrap("connection.init", { protocolVersion: "2.0.0" })).success).toBe(true);
    expect(clientToCloudMessage.safeParse(wrap("control.ping", {})).success).toBe(true);
    expect(clientToCloudMessage.safeParse(wrap("control.pong", {})).success).toBe(true);
    // a cloud->client type is not a valid client->cloud message
    expect(clientToCloudMessage.safeParse(wrap("stream.transcript", transcriptionData)).success).toBe(false);
  });

  test("cloudToClient union routes every push type", () => {
    expect(cloudToClientMessage.safeParse(wrap("connection.ack", { sessionId: "s1", negotiatedVersion: "2.0.0" })).success).toBe(true);
    expect(cloudToClientMessage.safeParse(wrap("control.ping", {})).success).toBe(true);
    expect(cloudToClientMessage.safeParse(wrap("control.pong", {})).success).toBe(true);
    expect(cloudToClientMessage.safeParse(wrap("error", { code: "INTERNAL", message: "boom", fatal: false })).success).toBe(true);
    expect(cloudToClientMessage.safeParse(wrap("stream.transcript", transcriptionData)).success).toBe(true);
    expect(cloudToClientMessage.safeParse(wrap("stream.translation", translationData)).success).toBe(true);
    expect(
      cloudToClientMessage.safeParse(
        wrap("audio.udp_liveness_ack", {
          sessionId: "s1",
          sessionTag: 123,
          probeId: "probe-1",
          receivedAt: 1700000000000,
        }),
      ).success,
    ).toBe(true);
    // a client->cloud type is not a valid cloud->client message
    expect(cloudToClientMessage.safeParse(wrap("connection.init", { protocolVersion: "2.0.0" })).success).toBe(false);
  });

  test("anyMessage routes both directions; rejects unknown type and wrong major", () => {
    expect(anyMessage.safeParse(wrap("connection.init", { protocolVersion: "2.0.0" })).success).toBe(true);
    expect(anyMessage.safeParse(wrap("stream.translation", translationData)).success).toBe(true);
    expect(anyMessage.safeParse(wrap("does.not.exist", {})).success).toBe(false);
    expect(anyMessage.safeParse(wrap("control.ping", {}, { v: 1 })).success).toBe(false);
  });

  test("a wrapped message with the wrong payload for its type is rejected", () => {
    expect(cloudToClientMessage.safeParse(wrap("stream.transcript", { not: "a transcript" })).success).toBe(false);
  });
});
