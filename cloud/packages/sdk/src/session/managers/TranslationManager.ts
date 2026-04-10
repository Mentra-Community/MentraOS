/**
 * TranslationManager — v3 SDK Translation API
 *
 * Replaces the old `session.events.ontranslationForLanguage()` method with a
 * cleaner, composable API that supports multiple simultaneous subscriptions.
 *
 * @example
 * ```ts
 * const session = await mentra.connect();
 *
 * // Subscribe to ALL active translation events
 * const stopAll = session.translation.on((evt) => {
 *   console.log(`[${evt.sourceLanguage} → ${evt.targetLanguage}] ${evt.text}`);
 * });
 *
 * // Auto-detect source, translate to Spanish
 * const stopEs = session.translation.to("es", (evt) => {
 *   console.log(`Spanish: ${evt.text}`);
 * });
 *
 * // Auto-detect source, translate to multiple targets
 * const stopMulti = session.translation.to(["es", "ja"], (evt) => {
 *   console.log(`${evt.targetLanguage}: ${evt.text}`);
 * });
 *
 * // Explicit source → target
 * const stopEnJa = session.translation.fromTo("en", "ja", (evt) => {
 *   console.log(`EN→JA: ${evt.text}`);
 * });
 *
 * // Explicit source → multiple targets
 * const stopEnMulti = session.translation.fromTo("en", ["ja", "es"], (evt) => {
 *   console.log(`EN→${evt.targetLanguage}: ${evt.text}`);
 * });
 *
 * // Cleanup individual subscriptions
 * stopEs();
 *
 * // Or tear down everything
 * session.translation.stop();
 * ```
 *
 * @module
 */

import { StreamType } from "../../types";

// ─── Public Types ───────────────────────────────────────────────────────────

/**
 * Normalised translation event delivered to subscriber callbacks.
 *
 * This is the *public* shape — it is mapped from the raw cloud
 * `TranslationData` message inside the manager so consumers never
 * need to think about wire-level details.
 */
export interface TranslationEvent {
  /** The translated text. */
  text: string;
  /** `true` when the cloud considers this segment finalised. */
  isFinal: boolean;
  /** ISO 639-1 source language code (e.g. `"en"`, `"ja"`). */
  sourceLanguage: string;
  /** ISO 639-1 target language code (e.g. `"es"`, `"ja"`). */
  targetLanguage: string;
  /** The original (untranslated) text, when available. */
  originalText?: string;
  /** Stable identifier for a contiguous utterance. */
  utteranceId?: string;
  /** Translation confidence in the range `[0, 1]`. */
  confidence?: number;
  /** Start time of the segment in milliseconds. */
  startTime: number;
  /** End time of the segment in milliseconds. */
  endTime: number;
}

/** Callback signature for translation subscribers. */
export type TranslationHandler = (data: TranslationEvent) => void;

// ─── Internal Types ─────────────────────────────────────────────────────────

/**
 * Dependencies injected by MentraSession.
 *
 * This is intentionally a *structural* type — we don't import the concrete
 * `DataStreamRouter` class so that the manager remains unit-testable with
 * plain stubs.
 */
export interface TranslationManagerDeps {
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
 * Internal bookkeeping for a single `on()` / `to()` / `fromTo()` registration.
 *
 * Each call to a public subscription method produces one `Registration` per
 * stream key it subscribes to, enabling independent cleanup.
 */
interface Registration {
  /** The subscription strings this registration added (e.g. `"translation:auto-es"`). */
  streams: string[];
  /** Cleanup functions returned by `router.on()` for each stream key. */
  routerCleanups: Array<() => void>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Stream prefix used on the wire. */
const STREAM_PREFIX = StreamType.TRANSLATION; // "translation"

/**
 * Build the wire subscription key for a translation pair.
 *
 * Wire protocol:
 * - `to("es")`           → `"translation:auto-es"`
 * - `fromTo("en", "ja")` → `"translation:en-ja"`
 */
function subscriptionKey(source: string, target: string): string {
  return `${STREAM_PREFIX}:${source}-${target}`;
}

/**
 * Parse a stream type string like `"translation:en-ja"` into its source and
 * target language components. Returns `null` if parsing fails.
 */
function parseStreamType(streamType: string): { source: string; target: string } | null {
  const prefixLen = STREAM_PREFIX.length + 1; // "translation:"
  if (!streamType.startsWith(`${STREAM_PREFIX}:`)) return null;

  const pair = streamType.slice(prefixLen);
  const dashIdx = pair.indexOf("-");
  if (dashIdx === -1) return null;

  return {
    source: pair.slice(0, dashIdx),
    target: pair.slice(dashIdx + 1),
  };
}

/**
 * Map raw cloud `TranslationData` into the public {@link TranslationEvent}.
 *
 * The cloud sends fields like `transcribeLanguage`, `translateLanguage`, and
 * `originalText` that we normalise into a friendlier shape.
 */
function normalise(streamType: string, raw: any): TranslationEvent {
  // Derive languages from the raw data first, falling back to parsing the
  // streamType for robustness.
  const parsed = parseStreamType(streamType);

  const sourceLanguage = raw.transcribeLanguage ?? parsed?.source ?? "";
  const targetLanguage = raw.translateLanguage ?? parsed?.target ?? "";

  return {
    text: raw.text ?? "",
    isFinal: !!raw.isFinal,
    sourceLanguage,
    targetLanguage,
    originalText: raw.originalText,
    utteranceId: raw.utteranceId,
    confidence: raw.confidence,
    startTime: raw.startTime ?? 0,
    endTime: raw.endTime ?? 0,
  };
}

// ─── Manager ────────────────────────────────────────────────────────────────

/**
 * Manages translation subscriptions and dispatches normalised events to
 * application-level handlers.
 *
 * Every public subscription method (`on`, `to`, `fromTo`) is **independent** —
 * multiple can be active simultaneously and each returns its own cleanup
 * function. Calling {@link stop} tears down *all* active subscriptions.
 */
export class TranslationManager {
  private readonly deps: TranslationManagerDeps;

  /**
   * All currently-active registrations. We track them so that {@link stop}
   * can clean everything up in one shot.
   */
  private registrations = new Set<Registration>();

  /**
   * Reference count per subscription stream string.
   *
   * Multiple independent registrations may share the same underlying stream
   * key (e.g. two `to("es", …)` calls). We only call
   * `deps.removeSubscription` when the ref-count drops to zero.
   */
  private refCounts = new Map<string, number>();

  constructor(deps: TranslationManagerDeps) {
    this.deps = deps;
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Subscribe to **all** active translation events.
   *
   * Registers a prefix handler on the router for `"translation"` so that
   * events for *any* language pair are delivered to `handler`. No wire
   * subscription is added for the bare prefix — the individual `to()` and
   * `fromTo()` calls produce the actual subscriptions. This handler simply
   * listens to whatever translations are already flowing.
   *
   * @param handler - Called for every incoming translation event.
   * @returns A cleanup function that removes this specific subscription.
   */
  on(handler: TranslationHandler): () => void {
    // Register on the router using the bare prefix so we receive
    // translation:en-ja, translation:auto-es, etc.
    const routerCleanup = this.deps.router.on(STREAM_PREFIX, (_streamType, data, _message) => {
      try {
        handler(normalise(_streamType, data));
      } catch (err) {
        this.deps.logger.error("[TranslationManager] Error in on() handler:", err);
      }
    });

    // The catch-all listener does NOT produce a wire subscription — only
    // specific to()/fromTo() calls do. We still track the registration so
    // that stop() can tear it down.
    const reg: Registration = {
      streams: [],
      routerCleanups: [routerCleanup],
    };

    this.registrations.add(reg);

    return () => this.removeRegistration(reg);
  }

  /**
   * Auto-detect source language and translate to one or more target
   * languages.
   *
   * Each call is **independent** — multiple can be active simultaneously.
   * When an array is provided the handler fires for events in *any* of the
   * listed target languages.
   *
   * Wire protocol:
   * - `to("es")` → subscribes `"translation:auto-es"`
   * - `to(["es", "ja"])` → subscribes `"translation:auto-es"` + `"translation:auto-ja"`
   *
   * @param target - ISO 639-1 target language code(s).
   * @param handler - Called for every matching translation event.
   * @returns A cleanup function that removes this specific subscription.
   */
  to(target: string | string[], handler: TranslationHandler): () => void {
    const targets = Array.isArray(target) ? target : [target];

    if (targets.length === 0) {
      this.deps.logger.warn("[TranslationManager] to() called with empty target array — no-op.");
      return () => {};
    }

    const streams: string[] = [];
    const routerCleanups: Array<() => void> = [];

    for (const t of targets) {
      const stream = subscriptionKey("auto", t); // e.g. "translation:auto-es"

      const cleanup = this.deps.router.on(stream, (_streamType, data, _message) => {
        try {
          handler(normalise(_streamType, data));
        } catch (err) {
          this.deps.logger.error(`[TranslationManager] Error in to("${t}") handler:`, err);
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
   * Translate from an explicit source language to one or more target
   * languages.
   *
   * Wire protocol:
   * - `fromTo("en", "ja")` → subscribes `"translation:en-ja"`
   * - `fromTo("en", ["ja", "es"])` → subscribes `"translation:en-ja"` + `"translation:en-es"`
   *
   * @param source - ISO 639-1 source language code.
   * @param target - ISO 639-1 target language code(s).
   * @param handler - Called for every matching translation event.
   * @returns A cleanup function that removes this specific subscription.
   */
  fromTo(source: string, target: string | string[], handler: TranslationHandler): () => void {
    const targets = Array.isArray(target) ? target : [target];

    if (targets.length === 0) {
      this.deps.logger.warn("[TranslationManager] fromTo() called with empty target array — no-op.");
      return () => {};
    }

    const streams: string[] = [];
    const routerCleanups: Array<() => void> = [];

    for (const t of targets) {
      const stream = subscriptionKey(source, t); // e.g. "translation:en-ja"

      const cleanup = this.deps.router.on(stream, (_streamType, data, _message) => {
        try {
          handler(normalise(_streamType, data));
        } catch (err) {
          this.deps.logger.error(`[TranslationManager] Error in fromTo("${source}", "${t}") handler:`, err);
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
   * Stop **all** translation subscriptions and remove every handler.
   *
   * After calling this, no translation callbacks will fire until new
   * subscriptions are created via {@link on}, {@link to}, or {@link fromTo}.
   */
  stop(): void {
    // Iterate over a snapshot — removeRegistration mutates the set.
    const snapshot = Array.from(this.registrations);
    for (const reg of snapshot) {
      this.removeRegistration(reg);
    }

    this.deps.logger.debug("[TranslationManager] All subscriptions stopped.");
  }

  // ─── Introspection (useful for testing / debugging) ─────────────────────

  /** Returns `true` if there is at least one active subscription. */
  get active(): boolean {
    return this.registrations.size > 0;
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
        this.deps.logger.debug(`[TranslationManager] Subscribed to "${stream}".`);
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
        this.deps.logger.debug(`[TranslationManager] Unsubscribed from "${stream}".`);
      } else {
        this.refCounts.set(stream, next);
      }
    }

    // 3. Remove from the active set.
    this.registrations.delete(reg);
  }
}
