/**
 * Mentra AI Configuration Constants
 */

/**
 * Response mode determines the length and depth of responses
 */
export enum ResponseMode {
  QUICK = 'quick',
  STANDARD = 'standard',
  DETAILED = 'detailed',
}

/**
 * Word limits for each response mode
 */
export const WORD_LIMITS = {
  // Speaker glasses (audio output)
  speaker: {
    [ResponseMode.QUICK]: 17,
    [ResponseMode.STANDARD]: 50,
    [ResponseMode.DETAILED]: 100,
  },
  // HUD glasses (visual display) - always short
  hud: {
    [ResponseMode.QUICK]: 15,
    [ResponseMode.STANDARD]: 15,
    [ResponseMode.DETAILED]: 15,
  },
};

/**
 * Conversation history settings
 */
export const CONVERSATION_SETTINGS = {
  // Maximum number of turns to include in context
  maxTurns: 30,
  // Maximum age of turns to include (1 hour in ms)
  maxAgeMs: 60 * 60 * 1000,
};

/**
 * Location caching settings
 */
export const LOCATION_CACHE_SETTINGS = {
  // Minimum movement to trigger geocoding refresh (in degrees, ~1km)
  minMovementDegrees: 0.01,
  // Geocode cache duration (10 minutes in ms)
  geocodeCacheDurationMs: 10 * 60 * 1000,
  // Weather cache duration (30 minutes in ms)
  weatherCacheDurationMs: 30 * 60 * 1000,
};

/**
 * Photo settings
 */
export const PHOTO_SETTINGS = {
  // Number of previous photos to keep for context
  previousPhotosToKeep: 2,
};

/**
 * Agent settings
 */
export const AGENT_SETTINGS = {
  // Maximum tool call iterations
  maxSteps: 5,
  // Model identifier (Mastra format: "provider/model")
  model: `google/${process.env.LLM_MODEL || 'gemini-3.1-flash-lite-preview'}`,
};

/**
 * User-selectable models (Settings → Model). Each entry maps a stable key
 * (persisted in UserSettings.model) to its display copy and the Mastra model
 * string the agent runs. `flashLite` is the default and reuses AGENT_SETTINGS.model
 * (the env-configured, known-good default). The non-default model strings can be
 * tuned without touching the UI — they all live here.
 */
export interface ModelOption {
  key: string;
  label: string;
  description: string;
  /** Mastra model string ("provider/model"). */
  model: string;
  /** Accent color for the picker icon. */
  accent: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    key: 'flash',
    label: 'Gemini Flash',
    description: 'Fast · best for quick answers',
    model: 'google/gemini-3.1-flash',
    accent: '#F0A88B',
  },
  {
    key: 'pro',
    label: 'Gemini Pro',
    description: 'Most capable · detailed replies',
    model: 'google/gemini-3.1-pro',
    accent: '#A89BF5',
  },
  {
    key: 'flashLite',
    label: 'Gemini Flash-Lite',
    description: 'Fastest · lightweight replies',
    model: AGENT_SETTINGS.model,
    accent: '#86CFAC',
  },
];

export const DEFAULT_MODEL_KEY = 'flashLite';

/** Resolve a persisted model key to a Mastra model string, falling back safely. */
export function resolveModel(key: string | undefined | null): string {
  const opt = MODEL_OPTIONS.find((m) => m.key === key);
  return opt ? opt.model : AGENT_SETTINGS.model;
}

/**
 * Giga-agent delegation settings.
 *
 * When configured, the fast agent gains an `ask_agent` tool that hands
 * multi-step / personal-account / long-running work to the user's
 * persistent agent (the `testaiassistant` control plane). The feature is
 * a no-op unless BOTH the base URL and the API key are set — so an
 * un-provisioned environment simply behaves like the standalone fast agent.
 *
 * - baseUrl  Control-plane origin, e.g. https://agents.augmentos.app
 * - apiKey   Shared server-to-server key (x-api-key). NEVER ships to a device.
 * - graceMs  How long a delegation blocks the turn before we bail to an
 *            "I'm on it" ack + a later follow-up (matches the control
 *            plane's own 2s grace window).
 */
export const AGENT_DELEGATION = {
  baseUrl: process.env.AGENTS_BASE_URL || '',
  apiKey: process.env.MENTRA_AGENT_API_KEY || '',
  graceMs: parseInt(process.env.AGENT_DELEGATE_GRACE_MS || '2000', 10),
};

/** True when delegation is fully configured and should be offered to the agent. */
export function isDelegationEnabled(): boolean {
  return Boolean(AGENT_DELEGATION.baseUrl && AGENT_DELEGATION.apiKey);
}
