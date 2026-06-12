/**
 * @fileoverview Canonical audio wire types for the Mentra Runtime protocol.
 *
 * zod schemas + inferred TS types for the audio service's subscription model
 * and result types. These are the single source of truth; `src/audio.types.ts`
 * re-exports the subscription types from here and adds `subscriptionKey()`.
 *
 * Mirrors docs/issues/002-cloud-runtime/audio/spec.md
 * ("Subscription model" and "Result types"). Pure + isomorphic: no server
 * imports, safe to bundle into the RN client.
 */
import { z } from "zod";

// --- Subscription model -----------------------------------------------------

export const languageSourceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("specific"), code: z.string() }),
  z.object({ mode: z.literal("auto"), hints: z.array(z.string()).optional() }),
]);
export type LanguageSource = z.infer<typeof languageSourceSchema>;

export const transcriptionSubscriptionSchema = z.object({
  kind: z.literal("transcription"),
  language: languageSourceSchema,
});
export type TranscriptionSubscription = z.infer<
  typeof transcriptionSubscriptionSchema
>;

export const translationSubscriptionSchema = z.object({
  kind: z.literal("translation"),
  source: languageSourceSchema,
  target: z.string(),
});
export type TranslationSubscription = z.infer<
  typeof translationSubscriptionSchema
>;

export const audioSubscriptionSchema = z.discriminatedUnion("kind", [
  transcriptionSubscriptionSchema,
  translationSubscriptionSchema,
]);
export type AudioSubscription = z.infer<typeof audioSubscriptionSchema>;

// --- UDP liveness -----------------------------------------------------------

export const UDP_LIVENESS_PROBE_PREFIX = "mentra:udp-probe:";

export const udpLivenessAckPayloadSchema = z.object({
  sessionId: z.string(),
  sessionTag: z.number().int(),
  probeId: z.string(),
  receivedAt: z.number().int(),
});
export type UdpLivenessAckPayload = z.infer<typeof udpLivenessAckPayloadSchema>;

// --- Result types -----------------------------------------------------------

export const transcriptionTokenSchema = z.object({
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  confidence: z.number(),
  isFinal: z.boolean(),
  speaker: z.string().optional(),
  // per-token; mid-sentence language switches are possible
  detectedLanguage: z.string().optional(),
});
export type TranscriptionToken = z.infer<typeof transcriptionTokenSchema>;

export const transcriptionDataSchema = z.object({
  userId: z.string(),
  subscription: transcriptionSubscriptionSchema,

  // Aggregated for simple consumers
  text: z.string(),
  isFinal: z.boolean(),
  utteranceId: z.string().optional(),
  speakerId: z.string().optional(),
  startMs: z.number(),
  endMs: z.number(),
  durationMs: z.number().optional(),
  confidence: z.number().optional(),

  // Language resolution
  resolvedLanguage: z.string(),
  languageDetected: z.boolean(),

  // Per-token detail for consumers that need it
  tokens: z.array(transcriptionTokenSchema),

  provider: z.string(),
  timestamp: z.number(),
});
export type TranscriptionData = z.infer<typeof transcriptionDataSchema>;

export const translationDataSchema = z.object({
  userId: z.string(),
  subscription: translationSubscriptionSchema,

  text: z.string(), // translated
  originalText: z.string().optional(), // source-language text
  isFinal: z.boolean(),
  utteranceId: z.string().optional(),
  speakerId: z.string().optional(),
  startMs: z.number(),
  endMs: z.number(),
  durationMs: z.number().optional(),
  confidence: z.number().optional(),

  source: z.object({
    language: z.string(), // resolved (specified or detected)
    detected: z.boolean(),
    confidence: z.number().optional(),
  }),
  target: z.object({ language: z.string() }),

  provider: z.string(),
  timestamp: z.number(),
});
export type TranslationData = z.infer<typeof translationDataSchema>;
