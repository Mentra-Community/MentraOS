/**
 * TranscriptionManager — v3 SDK Transcription API
 *
 * Replaces the old `session.events.onTranscription*()` methods with a cleaner,
 * composable API that supports multiple simultaneous subscriptions.
 *
 * @example
 * ```ts
 * const session = await mentra.connect();
 *
 * // Subscribe to all transcription (auto-detect language)
 * const stopAll = session.transcription.on((evt) => {
 *   console.log(`[${evt.language}] ${evt.text}`);
 * });
 *
 * // Also subscribe to a specific language — independent of the above
 * const stopEn = session.transcription.forLanguage("en", (evt) => {
 *   console.log(`English: ${evt.text}`);
 * });
 *
 * // Multiple languages in one call
 * const stopMulti = session.transcription.forLanguage(["ja", "es"], (evt) => {
 *   console.log(`${evt.language}: ${evt.text}`);
 * });
 *
 * // Configure hints / vocabulary / diarization
 * session.transcription.configure({
 *   languageHints: ["en", "ja"],
 *   vocabulary: ["MentraOS", "HIPAA"],
 *   diarization: true,
 * });
 *
 * // Cleanup individual subscriptions
 * stopEn();
 *
 * // Or tear down everything
 * session.transcription.stop();
 * ```
 *
 * @module
 */

import { StreamType } from "../../types";

// ─── Public Types ───────────────────────────────────────────────────────────

/**
 * Configuration options that influence transcription behaviour on the cloud.
 *
 * Passed to {@link TranscriptionManager.configure}. Applies globally to all
 * active subscriptions managed by this instance.
 */
export interface TranscriptionConfig {
  /** ISO 639-1 language hints to improve detection accuracy (e.g. `["en", "ja", "es"]`). */
  languageHints?: string[];
  /** Custom vocabulary / boosted terms (e.g. `["MentraOS", "HIPAA"]`). */
  vocabulary?: string[];
  /** Enable speaker diarisation. Defaults to `true`. */
  diarization?: boolean;
}

/**
 * Normalised transcription event delivered to subscriber callbacks.
 *
 * This is the *public* shape — it is mapped from the raw cloud
 * `TranscriptionData` message inside the manager so consumers never
 * need to think about wire-level details.
 */
export interface TranscriptionEvent {
  /** The transcribed text. */
  text: string;
  /** `true` when the cloud considers this utterance segment finalised. */
  isFinal: boolean;
  /** ISO 639-1 detected language code (e.g. `"en"`, `"ja"`). */
  language: string;
  /** Speaker identifier when diarisation is enabled. */
  speakerId?: string;
  /** Stable identifier for a contiguous utterance. Interim and final events for the same utterance share this ID. */
  utteranceId?: string;
  /** Recognition confidence in the range `[0, 1]`. */
  confidence?: number;
  /** Start time of the utterance segment in milliseconds. */
  startTime: number;
  /** End time of the utterance segment in milliseconds. */
  endTime: number;
  /** Audio duration in milliseconds. */
  duration?: number;
  /** Provider-specific metadata (token-level details, etc.). */
  metadata?: any;
}

/** Callback signature for transcription subscribers. */
export type TranscriptionHandler = (data: TranscriptionEvent) => void;

// ─── Internal Types ─────────────────────────────────────────────────────────

/**
 * Dependencies injected by MentraSession.
 *
 * This is intentionally a *structural* type — we don't import the concrete
 * `DataStreamRouter` class so that the manager remains unit-testable with
 * plain stubs.
 */
export interface TranscriptionManagerDeps {
  /** Register for DATA_STREAM messages by streamType key (exact or prefix). Returns a cleanup function. */
  router: {
    on(key: string, handler: (streamType: string, data: any, message: any) => void): () => void;
  };
  /** Add a subscription string (triggers SUBSCRIPTION_UPDATE to cloud). */
  addSubscription: (stream: string) => void;
  /** Remove a subscription string. */
  removeSubscription: (stream: string) => void;
  /** Send an arbitrary JSON message to the cloud. */
  sendMessage: (message: any) => void;
  /** Structured logger. */
  logger: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
}

/**
 * Internal bookkeeping for a single `on()` / `forLanguage()` registration.
 *
 * Each call to a public subscription method produces one `Registration` per
 * stream key it subscribes to, enabling independent cleanup.
 */
interface Registration {
  /** The subscription strings this registration added (e.g. `"transcription:en"`). */
  streams: string[];
  /** Cleanup functions returned by `router.on()` for each stream key. */
  routerCleanups: Array<() => void>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Stream prefix used on the wire. */
const STREAM_PREFIX = StreamType.TRANSCRIPTION; // "transcription"

/** Build the subscription string for a language code. */
function subscriptionKey(lang: string): string {
  return `${STREAM_PREFIX}:${lang}`;
}

/**
 * Map raw cloud `TranscriptionData` into the public {@link TranscriptionEvent}.
 *
 * The cloud sends fields like `detectedLanguage`, `transcribeLanguage`, and
 * `metadata` that we normalise into a friendlier shape.
 */
function normalise(streamType: string, raw: any): TranscriptionEvent {
  // Derive the language from `detectedLanguage` first, then fall back to the
  // subscription language embedded in the streamType ("transcription:en" → "en"),
  // and finally to an empty string.
  const language = raw.detectedLanguage ?? raw.transcribeLanguage ?? streamType.replace(`${STREAM_PREFIX}:`, "") ?? "";

  return {
    text: raw.text ?? "",
    isFinal: !!raw.isFinal,
    language,
    speakerId: raw.speakerId,
    utteranceId: raw.utteranceId,
    confidence: raw.confidence,
    startTime: raw.startTime ?? 0,
    endTime: raw.endTime ?? 0,
    duration: raw.duration,
    metadata: raw.metadata,
  };
}

// ─── Manager ────────────────────────────────────────────────────────────────

/**
 * Manages transcription subscriptions and dispatches normalised events to
 * application-level handlers.
 *
 * Every public subscription method (`on`, `forLanguage`) is **independent** —
 * multiple can be active simultaneously and each returns its own cleanup
 * function. Calling {@link stop} tears down *all* active subscriptions.
 */
export class TranscriptionManager {
  private readonly deps: TranscriptionManagerDeps;

  /**
   * All currently-active registrations. We track them so that {@link stop}
   * can clean everything up in one shot.
   */
  private registrations = new Set<Registration>();

  /**
   * Reference count per subscription stream string.
   *
   * Multiple independent registrations may share the same underlying stream
   * key (e.g. two `forLanguage("en", …)` calls). We only call
   * `deps.removeSubscription` when the ref-count drops to zero.
   */
  private refCounts = new Map<string, number>();

  /** Latest config applied via {@link configure}. */
  private currentConfig: TranscriptionConfig | null = null;

  constructor(deps: TranscriptionManagerDeps) {
    this.deps = deps;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Subscribe to **all** transcription events (auto-detect, all languages).
   *
   * Registers a prefix handler on the router for `"transcription"` so that
   * events for *any* language are delivered to `handler`. The cloud
   * subscription is `"transcription:auto"`.
   *
   * @param handler - Called for every incoming transcription event.
   * @returns A cleanup function that removes this specific subscription.
   */
  on(handler: TranscriptionHandler): () => void {
    const stream = subscriptionKey("auto"); // "transcription:auto"

    // Register on the router using the bare prefix so we receive
    // transcription:en, transcription:ja, transcription:auto, etc.
    const routerCleanup = this.deps.router.on(STREAM_PREFIX, (_streamType, data, _message) => {
      try {
        handler(normalise(_streamType, data));
      } catch (err) {
        this.deps.logger.error(`[TranscriptionManager] Error in on() handler:`, err);
      }
    });

    const reg: Registration = {
      streams: [stream],
      routerCleanups: [routerCleanup],
    };

    this.addRegistration(reg);

    return () => this.removeRegistration(reg);
  }

  /**
   * Subscribe to transcription for one or more specific languages.
   *
   * Each call is **independent** — multiple can be active simultaneously.
   * When an array is provided the handler fires for events in *any* of the
   * listed languages.
   *
   * @param lang - ISO 639-1 language code(s) (e.g. `"en"` or `["en", "ja"]`).
   * @param handler - Called for every matching transcription event.
   * @returns A cleanup function that removes this specific subscription.
   */
  forLanguage(lang: string | string[], handler: TranscriptionHandler): () => void {
    const langs = Array.isArray(lang) ? lang : [lang];

    if (langs.length === 0) {
      this.deps.logger.warn("[TranscriptionManager] forLanguage() called with empty language array — no-op.");
      return () => {};
    }

    const streams: string[] = [];
    const routerCleanups: Array<() => void> = [];

    for (const l of langs) {
      const stream = subscriptionKey(l); // e.g. "transcription:en"

      const cleanup = this.deps.router.on(stream, (_streamType, data, _message) => {
        try {
          handler(normalise(_streamType, data));
        } catch (err) {
          this.deps.logger.error(`[TranscriptionManager] Error in forLanguage("${l}") handler:`, err);
        }
      });

      streams.push(stream);
      routerCleanups.push(cleanup);
    }

    const reg: Registration = { streams, routerCleanups };
    this.addRegistration(reg);

    return () => this.removeRegistration(reg);
  }

  /**
   * Apply transcription configuration (language hints, custom vocabulary,
   * diarisation toggle).
   *
   * The configuration is sent to the cloud immediately and cached so that
   * it can be re-sent if the session reconnects.
   *
   * @param config - Configuration to apply.
   */
  configure(config: TranscriptionConfig): void {
    this.currentConfig = { ...config };

    this.deps.sendMessage({
      type: "transcription_config",
      languageHints: config.languageHints,
      vocabulary: config.vocabulary,
      diarization: config.diarization ?? true,
    });

    this.deps.logger.debug("[TranscriptionManager] Configuration sent:", config);
  }

  /**
   * Stop **all** transcription subscriptions and remove every handler.
   *
   * After calling this, no transcription callbacks will fire until new
   * subscriptions are created via {@link on} or {@link forLanguage}.
   */
  stop(): void {
    // Iterate over a snapshot — removeRegistration mutates the set.
    const snapshot = Array.from(this.registrations);
    for (const reg of snapshot) {
      this.removeRegistration(reg);
    }

    this.currentConfig = null;
    this.deps.logger.debug("[TranscriptionManager] All subscriptions stopped.");
  }

  // ─── Introspection (useful for testing / debugging) ─────────────────────

  /** Returns `true` if there is at least one active subscription. */
  get active(): boolean {
    return this.registrations.size > 0;
  }

  /** Returns the current configuration, or `null` if none has been set. */
  get config(): TranscriptionConfig | null {
    return this.currentConfig ? { ...this.currentConfig } : null;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /**
   * Track a new registration: increment ref-counts and call
   * `addSubscription` for any stream that is newly referenced.
   */
  private addRegistration(reg: Registration): void {
    this.registrations.add(reg);

    for (const stream of reg.streams) {
      const prev = this.refCounts.get(stream) ?? 0;
      this.refCounts.set(stream, prev + 1);

      // Only subscribe on the wire when the first handler for this stream
      // comes online.
      if (prev === 0) {
        this.deps.addSubscription(stream);
        this.deps.logger.debug(`[TranscriptionManager] Subscribed to "${stream}".`);
      }
    }
  }

  /**
   * Tear down a registration: unregister router handlers, decrement
   * ref-counts, and call `removeSubscription` when a stream drops to zero
   * references.
   */
  private removeRegistration(reg: Registration): void {
    if (!this.registrations.has(reg)) return; // Already removed (idempotent).

    // 1. Remove router handlers.
    for (const cleanup of reg.routerCleanups) {
      try {
        cleanup();
      } catch {
        // Best-effort — the router may have already been cleared.
      }
    }

    // 2. Decrement ref-counts and unsubscribe when necessary.
    for (const stream of reg.streams) {
      const count = this.refCounts.get(stream) ?? 0;
      const next = count - 1;

      if (next <= 0) {
        this.refCounts.delete(stream);
        this.deps.removeSubscription(stream);
        this.deps.logger.debug(`[TranscriptionManager] Unsubscribed from "${stream}".`);
      } else {
        this.refCounts.set(stream, next);
      }
    }

    // 3. Remove from the active set.
    this.registrations.delete(reg);
  }
}
