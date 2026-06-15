/**
 * Mentra AI Configuration Constants
 */

/** Response mode determines the length and depth of responses. */
export enum ResponseMode {
  QUICK = "quick",
  STANDARD = "standard",
  DETAILED = "detailed",
}

/** Word limits for each response mode. */
export const WORD_LIMITS = {
  // Speaker glasses (audio output)
  speaker: {
    [ResponseMode.QUICK]: 17,
    [ResponseMode.STANDARD]: 50,
    [ResponseMode.DETAILED]: 100,
  },
  // HUD glasses (visual display) — always short
  hud: {
    [ResponseMode.QUICK]: 15,
    [ResponseMode.STANDARD]: 15,
    [ResponseMode.DETAILED]: 15,
  },
}

/** Conversation history settings. */
export const CONVERSATION_SETTINGS = {
  /** Maximum number of turns to include in context. */
  maxTurns: 30,
  /** Maximum age of turns to include (1 hour in ms). */
  maxAgeMs: 60 * 60 * 1000,
}

/** Location caching settings. */
export const LOCATION_CACHE_SETTINGS = {
  /** Minimum movement to trigger geocoding refresh (in degrees, ~1km). */
  minMovementDegrees: 0.01,
  /** Geocode cache duration (10 minutes in ms). */
  geocodeCacheDurationMs: 10 * 60 * 1000,
  /** Weather cache duration (30 minutes in ms). */
  weatherCacheDurationMs: 30 * 60 * 1000,
}

/** Photo settings. */
export const PHOTO_SETTINGS = {
  /** Number of previous photos to keep for context. */
  previousPhotosToKeep: 2,
}

/** Agent settings. */
export const AGENT_SETTINGS = {
  /** Maximum tool call iterations. */
  maxSteps: 5,
  /** Model identifier (Mastra format: "provider/model"). */
  model: `google/${process.env.LLM_MODEL || "gemini-3.1-flash-lite-preview"}`,
}
