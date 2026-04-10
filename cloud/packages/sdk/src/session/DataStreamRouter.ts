/**
 * DataStreamRouter — Typed Message Dispatch
 *
 * Replaces the 413-line if/else chain in the old AppSession.handleMessage()
 * with a clean registry pattern. Each manager registers handlers for the
 * message types it cares about. The router dispatches incoming messages
 * to all matching handlers.
 *
 * Two levels of dispatch:
 *
 * 1. **MessageHandlerRegistry** — routes by top-level `message.type`
 *    (e.g., "tpa_connection_ack", "settings_update", "data_stream",
 *    "device_state_update", "capabilities_update", etc.)
 *
 * 2. **DataStreamRouter** — routes DATA_STREAM messages by `streamType`
 *    (e.g., "transcription:en", "translation:en-ja", "button_press",
 *    "phone_notification", etc.)
 *
 * MentraSession wires them together:
 *   - Creates MessageHandlerRegistry
 *   - Creates DataStreamRouter
 *   - Registers DataStreamRouter.handle as the handler for "data_stream"
 *   - Each manager registers its handlers on one or both registries
 *
 * @example
 * ```ts
 * const messages = new MessageHandlerRegistry();
 * const streams = new DataStreamRouter();
 *
 * // MentraSession registers the bridge
 * messages.register("data_stream", (msg) => streams.handle(msg));
 *
 * // TranscriptionManager registers for transcription streams
 * streams.on("transcription", (streamType, data) => { ... });
 *
 * // DeviceManager registers for direct messages
 * messages.register("device_state_update", (msg) => { ... });
 * messages.register("capabilities_update", (msg) => { ... });
 *
 * // Dispatch an incoming message — ~5 lines instead of 413
 * const msg = JSON.parse(raw);
 * if (msg?.type) messages.dispatch(msg);
 * ```
 */

// ─── MessageHandlerRegistry ─────────────────────────────────────────────────

/**
 * Handler for a top-level message type.
 * Receives the full parsed message object.
 */
export type MessageHandler = (message: any) => void;

/**
 * Routes incoming messages by their `type` field to registered handlers.
 * Multiple handlers can be registered for the same message type — all fire.
 *
 * This replaces the massive if/else chain with O(1) lookup + iteration.
 */
export class MessageHandlerRegistry {
  /**
   * Map from message type string → array of handlers.
   * Using an array per type supports multiple managers registering
   * for the same message type (e.g., multiple subsystems interested
   * in CONNECTION_ACK).
   */
  private handlers = new Map<string, MessageHandler[]>();

  /**
   * Register a handler for a specific message type.
   * Multiple handlers per type are supported — all will fire.
   * Returns a cleanup function that removes this specific handler.
   *
   * @param type - The message `type` field value to match
   * @param handler - Function called with the full message object
   * @returns Cleanup function to unregister this handler
   */
  register(type: string, handler: MessageHandler): () => void {
    let list = this.handlers.get(type);
    if (!list) {
      list = [];
      this.handlers.set(type, list);
    }
    list.push(handler);

    // Return cleanup function
    return () => {
      const arr = this.handlers.get(type);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx !== -1) {
          arr.splice(idx, 1);
        }
        if (arr.length === 0) {
          this.handlers.delete(type);
        }
      }
    };
  }

  /**
   * Dispatch a message to all handlers registered for its `type`.
   * Returns true if at least one handler was called, false otherwise.
   *
   * Handlers are called synchronously in registration order.
   * Errors in one handler do not prevent other handlers from running.
   */
  dispatch(message: { type: string; [key: string]: any }): boolean {
    const list = this.handlers.get(message.type);
    if (!list || list.length === 0) {
      return false;
    }

    for (const handler of list) {
      try {
        handler(message);
      } catch (err) {
        // Don't let one handler's error kill dispatch to other handlers.
        // In production, MentraSession's logger will catch these via
        // a global error boundary. Here we just ensure dispatch continues.
        console.error(`[MessageHandlerRegistry] Handler error for type="${message.type}":`, err);
      }
    }

    return true;
  }

  /**
   * Check whether any handlers are registered for a message type.
   */
  has(type: string): boolean {
    const list = this.handlers.get(type);
    return !!list && list.length > 0;
  }

  /**
   * Remove all handlers for all message types.
   * Called during session cleanup/disconnect.
   */
  clear(): void {
    this.handlers.clear();
  }
}

// ─── DataStreamRouter ───────────────────────────────────────────────────────

/**
 * Handler for a DATA_STREAM sub-message.
 *
 * @param streamType - The full stream type string (e.g., "transcription:en", "button_press")
 * @param data - The payload data from the DATA_STREAM message (already unwrapped)
 * @param message - The full raw DATA_STREAM message (for handlers that need metadata)
 */
export type StreamHandler = (streamType: string, data: any, message: any) => void;

/**
 * Routes DATA_STREAM messages to handlers based on `streamType`.
 *
 * Supports two matching strategies:
 *
 * 1. **Exact match** — `streamType === registeredKey`
 *    e.g., registered "button_press" matches incoming "button_press"
 *
 * 2. **Prefix match** — `streamType.startsWith(registeredPrefix)`
 *    e.g., registered "transcription" matches "transcription:en", "transcription:auto"
 *    e.g., registered "translation" matches "translation:en-ja", "translation:auto-es"
 *    e.g., registered "touch_event" matches "touch_event:triple_tap"
 *
 * ALL matching handlers fire (not just the first match).
 * This is critical for supporting multiple simultaneous forLanguage() calls:
 *
 * ```ts
 * // Both handlers fire for "transcription:en" messages
 * router.on("transcription:en", handlerA);
 * router.on("transcription:en", handlerB);
 *
 * // Prefix handler also fires for "transcription:en" messages
 * router.on("transcription", handlerC);  // matches all transcription:*
 * ```
 *
 * Matching order: exact matches first, then prefix matches (longest prefix first).
 * Within the same key, handlers fire in registration order.
 */
export class DataStreamRouter {
  /**
   * Map from stream key (exact or prefix) → array of handlers.
   */
  private handlers = new Map<string, StreamHandler[]>();

  /**
   * Cached sorted prefix keys for efficient matching.
   * Invalidated when handlers are added or removed.
   * Sorted by length descending so longest prefix matches first.
   */
  private prefixKeysCache: string[] | null = null;

  /**
   * Register a handler for a stream type or prefix.
   *
   * @param key - Stream type to match. Can be:
   *   - Exact: "button_press", "transcription:en", "phone_notification"
   *   - Prefix: "transcription" (matches "transcription:en", "transcription:auto", etc.)
   * @param handler - Called with (streamType, data, fullMessage) for each match
   * @returns Cleanup function to unregister this handler
   *
   * @example
   * ```ts
   * // Exact match — only "button_press"
   * const stop = router.on("button_press", (st, data) => { ... });
   *
   * // Prefix match — all transcription streams
   * const stop = router.on("transcription", (st, data) => { ... });
   *
   * // Specific language
   * const stop = router.on("transcription:en", (st, data) => { ... });
   *
   * // Later: unsubscribe
   * stop();
   * ```
   */
  on(key: string, handler: StreamHandler): () => void {
    let list = this.handlers.get(key);
    if (!list) {
      list = [];
      this.handlers.set(key, list);
    }
    list.push(handler);
    this.prefixKeysCache = null; // Invalidate cache

    // Return cleanup function
    return () => {
      const arr = this.handlers.get(key);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx !== -1) {
          arr.splice(idx, 1);
        }
        if (arr.length === 0) {
          this.handlers.delete(key);
          this.prefixKeysCache = null; // Invalidate cache
        }
      }
    };
  }

  /**
   * Dispatch a DATA_STREAM message to all matching handlers.
   *
   * Expects a message shaped like:
   * ```json
   * {
   *   "type": "data_stream",
   *   "streamType": "transcription:en",
   *   "data": { "text": "hello", "isFinal": true, ... }
   * }
   * ```
   *
   * Returns true if at least one handler was called.
   */
  handle(message: any): boolean {
    const streamType: string | undefined = message?.streamType;
    if (!streamType) return false;

    const data = message?.data ?? message;

    let matched = false;

    // 1. Exact match — highest priority
    const exactHandlers = this.handlers.get(streamType);
    if (exactHandlers && exactHandlers.length > 0) {
      for (const handler of exactHandlers) {
        try {
          handler(streamType, data, message);
          matched = true;
        } catch (err) {
          console.error(`[DataStreamRouter] Handler error for streamType="${streamType}":`, err);
        }
      }
    }

    // 2. Prefix match — check all registered keys that are prefixes of streamType
    //    e.g., key "transcription" matches streamType "transcription:en"
    //    But NOT if the key IS the exact streamType (already handled above).
    const prefixKeys = this.getPrefixKeys();
    for (const key of prefixKeys) {
      // Skip exact match (already handled)
      if (key === streamType) continue;

      // Key must be a proper prefix: streamType starts with key,
      // and the character after the key is ':' or end-of-string.
      // This prevents "touch_event" from matching "touch_event_other" —
      // it only matches "touch_event:triple_tap" (colon separator).
      if (streamType.startsWith(key)) {
        const nextChar = streamType[key.length];
        if (nextChar === undefined || nextChar === ":") {
          const handlers = this.handlers.get(key);
          if (handlers) {
            for (const handler of handlers) {
              try {
                handler(streamType, data, message);
                matched = true;
              } catch (err) {
                console.error(
                  `[DataStreamRouter] Prefix handler error for key="${key}" streamType="${streamType}":`,
                  err,
                );
              }
            }
          }
        }
      }
    }

    return matched;
  }

  /**
   * Check whether any handlers are registered for a stream key.
   */
  has(key: string): boolean {
    const list = this.handlers.get(key);
    return !!list && list.length > 0;
  }

  /**
   * Get all registered stream keys (both exact and prefix).
   * Useful for deriving the current subscription set.
   */
  getRegisteredKeys(): string[] {
    return Array.from(this.handlers.keys()).filter((key) => {
      const list = this.handlers.get(key);
      return list && list.length > 0;
    });
  }

  /**
   * Remove all handlers.
   * Called during session cleanup/disconnect.
   */
  clear(): void {
    this.handlers.clear();
    this.prefixKeysCache = null;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /**
   * Get sorted prefix keys for matching, with longest first.
   * Uses a cache that's invalidated when handlers change.
   */
  private getPrefixKeys(): string[] {
    if (this.prefixKeysCache === null) {
      this.prefixKeysCache = Array.from(this.handlers.keys()).sort((a, b) => b.length - a.length);
    }
    return this.prefixKeysCache;
  }
}

// ─── Subscription Derivation ────────────────────────────────────────────────

/**
 * Derive the set of subscription strings from the DataStreamRouter's
 * registered handler keys. This is used by MentraSession to compute
 * the SUBSCRIPTION_UPDATE message payload.
 *
 * The logic:
 * - Each registered key on the DataStreamRouter represents a desired subscription.
 * - Keys like "transcription" (prefix) map to "transcription:auto" subscription.
 * - Keys like "transcription:en" (exact) map to "transcription:en" subscription.
 * - Non-subscribable keys (e.g., internal-only) are filtered out.
 *
 * @param router - The DataStreamRouter to derive subscriptions from
 * @param additionalSubscriptions - Extra subscriptions from other sources
 *   (e.g., DeviceManager state subscriptions that don't go through the router)
 * @returns Deduplicated array of subscription strings
 */
export function deriveSubscriptions(router: DataStreamRouter, additionalSubscriptions?: Set<string>): string[] {
  const subs = new Set<string>();

  for (const key of router.getRegisteredKeys()) {
    // The "transcription" prefix key means "subscribe to transcription:auto"
    if (key === "transcription") {
      subs.add("transcription:auto");
    }
    // The "translation" prefix key means "subscribe to all active translations"
    // Individual translation targets are registered as "translation:auto-es" etc.
    else if (key === "translation") {
      // Generic translation listener — the individual to()/fromTo() calls
      // register more specific keys that produce the actual subscriptions.
      // The prefix handler is just for the .on() catch-all.
      // Don't produce a subscription for the bare prefix.
    }
    // Everything else is used as-is
    else {
      subs.add(key);
    }
  }

  // Merge additional subscriptions
  if (additionalSubscriptions) {
    for (const sub of additionalSubscriptions) {
      subs.add(sub);
    }
  }

  return Array.from(subs);
}
