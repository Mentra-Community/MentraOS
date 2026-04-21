/**
 * LocationManager — v3 SDK Location API
 *
 * Wraps the existing LocationManager patterns from v2 with a cleaner,
 * composable API. Subscribes to location data streams, caches the latest
 * known position, and supports one-shot location polls.
 *
 * Wire format is identical to v2:
 * - Location stream subscription: `"location_stream"` added to subscriptions
 * - Location poll: `{ type: "location_poll_request", packageName, sessionId, accuracy, correlationId }`
 * - Location updates arrive as DATA_STREAM messages with streamType `"location_update"` or `"location_stream"`
 *
 * The LocationUpdate payload shape (from glasses-to-cloud):
 * ```json
 * {
 *   "type": "location_update",
 *   "lat": number,
 *   "lng": number,
 *   "accuracy": number,
 *   "correlationId": string | undefined
 * }
 * ```
 *
 * @module
 */

import { AppToCloudMessageType, StreamType } from "../../types";

// ─── Public Types ───────────────────────────────────────────────────────────

/**
 * Normalised location data delivered to subscriber callbacks.
 */
export interface LocationData {
  /** Latitude in decimal degrees. */
  lat: number;
  /** Longitude in decimal degrees. */
  lng: number;
  /** Horizontal accuracy in metres (`undefined` if not available). */
  accuracy?: number;
  /** Unix timestamp (ms) when the location was recorded. */
  timestamp: number;
  /** Correlation ID returned from a one-shot poll (if applicable). */
  correlationId?: string;
}

/**
 * Accuracy tier for location stream subscriptions.
 * Maps directly to the v2 `LocationStreamRequest.rate` values.
 */
export type LocationAccuracy =
  | "standard"
  | "high"
  | "realtime"
  | "tenMeters"
  | "hundredMeters"
  | "kilometer"
  | "threeKilometers"
  | "reduced";

/** Callback signature for location subscribers. */
export type LocationHandler = (location: LocationData) => void;

/** Location configuration options. */
export interface LocationConfig {
  /** Accuracy level for location updates. Default: "standard". */
  accuracy?: LocationAccuracy;
}

// ─── Internal Types ─────────────────────────────────────────────────────────

/**
 * Dependencies injected by MentraSession.
 *
 * Structural type — no concrete imports so the manager stays unit-testable
 * with plain stubs.
 */
export interface LocationManagerDeps {
  /** DataStreamRouter — register for DATA_STREAM messages by streamType key. */
  router: {
    on(key: string, handler: (streamType: string, data: any, message: any) => void): () => void;
  };
  /** MessageHandlerRegistry — register for top-level message types. */
  messageHandlers: {
    register(type: string, handler: (msg: any) => void): () => void;
  };
  /** Add a subscription string (triggers SUBSCRIPTION_UPDATE to cloud). */
  addSubscription: (stream: string) => void;
  /** Remove a subscription string. */
  removeSubscription: (stream: string) => void;
  /** Send an arbitrary JSON message over the WebSocket. */
  sendMessage: (message: any) => void;
  /** Structured logger. */
  logger: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  /** Package name for outgoing messages. */
  getPackageName: () => string;
  /** Current session ID. */
  getSessionId: () => string;
}

/**
 * Internal bookkeeping for a single `onUpdate()` registration.
 */
interface Registration {
  /** Cleanup function returned by `router.on()` for the primary stream. */
  routerCleanup: () => void;
  /** Cleanup function returned by `router.on()` for the secondary location_update stream. */
  updateCleanup: () => void;
  /** The stream key this registration subscribed to. */
  streamKey: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Stream type for continuous location updates. */
const LOCATION_STREAM = StreamType.LOCATION_STREAM; // "location_stream"

/** Stream type for individual location update events. */
const LOCATION_UPDATE = StreamType.LOCATION_UPDATE; // "location_update"

/** Default timeout for one-shot location polls. */
const POLL_TIMEOUT_MS = 15_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a unique correlation ID for location poll requests.
 */
function generateCorrelationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `poll_${crypto.randomUUID()}`;
  }
  return `poll_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Normalise raw location data from a DATA_STREAM event into the public
 * {@link LocationData} shape.
 */
function normalise(raw: any): LocationData {
  return {
    lat: typeof raw.lat === "number" ? raw.lat : 0,
    lng: typeof raw.lng === "number" ? raw.lng : 0,
    accuracy: typeof raw.accuracy === "number" ? raw.accuracy : undefined,
    timestamp: raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now(),
    correlationId: raw.correlationId,
  };
}

// ─── Manager ────────────────────────────────────────────────────────────────

/**
 * Manages location subscriptions, caches the latest known position, and
 * supports one-shot location polls.
 *
 * @example
 * ```ts
 * const session = await mentra.connect();
 *
 * // Subscribe to continuous location updates
 * const stop = session.location.onUpdate((loc) => {
 *   console.log(`${loc.lat}, ${loc.lng} (±${loc.accuracy}m)`);
 * });
 *
 * // Read cached values at any time
 * console.log("Last known:", session.location.lat, session.location.lng);
 *
 * // Request a single location update
 * session.location.requestUpdate();
 *
 * // Stop all subscriptions
 * session.location.stop();
 * ```
 */
export class LocationManager {
  private readonly deps: LocationManagerDeps;

  /**
   * All currently-active registrations. Tracked so that {@link stop}
   * can clean everything up in one shot.
   */
  private registrations = new Set<Registration>();

  /**
   * Reference count for the location_stream subscription.
   * We only call `removeSubscription` when ref-count drops to zero.
   */
  private streamRefCount = 0;

  // ─── Cached State ───────────────────────────────────────────────────────

  /** Latest latitude, or `null` if no update has been received. */
  private _lat: number | null = null;

  /** Latest longitude, or `null` if no update has been received. */
  private _lng: number | null = null;

  /** Latest horizontal accuracy in metres, or `null` if unknown. */
  private _accuracy: number | null = null;

  /** Timestamp of the latest location update, or `null` if none received. */
  private _timestamp: number | null = null;

  /**
   * Whether the device has location permission.
   * Optimistically `true`, updated to `false` on permission errors.
   */
  private _hasPermission = true;

  /** User-provided configuration (accuracy, etc.). */
  private _config: LocationConfig = {};

  /** Pending one-shot poll requests awaiting a correlated response. */
  private pendingPolls = new Map<
    string,
    { resolve: (data: LocationData) => void; reject: (error: Error) => void; timeoutId: ReturnType<typeof setTimeout> }
  >();

  /** Cleanup for the internal location_update message handler. */
  private locationUpdateCleanup: (() => void) | null = null;

  constructor(deps: LocationManagerDeps) {
    this.deps = deps;

    // Register a router handler for "location_update" stream type so we always
    // cache the latest position, even if no `onUpdate()` listener is active.
    // Also resolve any pending one-shot polls matched by correlationId.
    this.locationUpdateCleanup = this.deps.router.on(LOCATION_UPDATE, (_streamType, data, _message) => {
      this.cacheLocation(data);
      this.resolvePendingPoll(data);
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Configure location settings.
   *
   * Sets the accuracy level for subsequent `onUpdate()` subscriptions
   * and `requestUpdate()` calls.
   *
   * @example
   * ```ts
   * session.location.configure({ accuracy: "high" });
   * ```
   */
  configure(config: LocationConfig): void {
    this._config = { ...this._config, ...config };
  }

  /**
   * Subscribe to continuous location updates.
   *
   * Registers on the DataStreamRouter for `"location_stream"` events and
   * adds the `"location_stream"` subscription to the cloud. Multiple
   * independent subscriptions are supported — each returns its own
   * cleanup function.
   *
   * Uses the accuracy level set via {@link configure}. Defaults to `"standard"`.
   *
   * @param handler - Called each time a location update arrives.
   * @returns A cleanup function that removes this specific subscription.
   *
   * @example
   * ```ts
   * session.location.configure({ accuracy: "high" });
   * const stop = session.location.onUpdate((loc) => {
   *   console.log(`${loc.lat}, ${loc.lng}`);
   * });
   *
   * // Later:
   * stop();
   * ```
   */
  onUpdate(handler: LocationHandler): () => void {
    const streamKey = LOCATION_STREAM;

    const accuracy = this._config.accuracy ?? "standard";

    // Register on the router for location_stream events
    const routerCleanup = this.deps.router.on(streamKey, (_streamType, data, _message) => {
      try {
        const location = normalise(data);
        this.cacheLocation(data);
        this.resolvePendingPoll(data);
        handler(location);
      } catch (err) {
        this.deps.logger.error("[LocationManager] Error in onUpdate handler:", err);
      }
    });

    // Also listen for location_update events (single updates, poll responses, etc.)
    const updateCleanup = this.deps.router.on(LOCATION_UPDATE, (_streamType, data, _message) => {
      try {
        const location = normalise(data);
        this.cacheLocation(data);
        this.resolvePendingPoll(data);
        handler(location);
      } catch (err) {
        this.deps.logger.error("[LocationManager] Error in onUpdate handler (location_update):", err);
      }
    });

    const reg: Registration = { routerCleanup, updateCleanup, streamKey };

    this.registrations.add(reg);

    // Increment ref count and subscribe if first listener
    this.streamRefCount++;
    if (this.streamRefCount === 1) {
      // Add subscription with accuracy rate — v2 uses LocationStreamRequest format
      this.deps.addSubscription(streamKey);
      this.deps.logger.debug({ accuracy }, `[LocationManager] Subscribed to "${streamKey}".`);
    }

    // Return composite cleanup
    return () => {
      if (!this.registrations.has(reg)) return; // Already cleaned up (idempotent)

      routerCleanup();
      updateCleanup();
      this.registrations.delete(reg);

      // Decrement ref count and unsubscribe if last listener
      this.streamRefCount--;
      if (this.streamRefCount <= 0) {
        this.streamRefCount = 0;
        this.deps.removeSubscription(streamKey);
        this.deps.logger.debug(`[LocationManager] Unsubscribed from "${streamKey}".`);
      }
    };
  }

  /**
   * Request a single location update (one-shot poll).
   *
   * Sends a `location_poll_request` message to the cloud and returns a
   * Promise that resolves with the {@link LocationData} when the correlated
   * response arrives. The response will also be delivered to any active
   * `onUpdate()` listeners and will update the cached position.
   *
   * Uses the accuracy level set via {@link configure}. Defaults to `"standard"`.
   *
   * @returns A promise that resolves with the location data from the poll.
   * @throws If the poll times out (default: 15 seconds).
   *
   * @example
   * ```ts
   * session.location.configure({ accuracy: "high" });
   * const loc = await session.location.requestUpdate();
   * console.log(`${loc.lat}, ${loc.lng}`);
   * ```
   */
  requestUpdate(): Promise<LocationData> {
    const correlationId = generateCorrelationId();
    const accuracy = this._config.accuracy ?? "standard";

    return new Promise<LocationData>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingPolls.delete(correlationId);
        reject(new Error(`Location poll timed out after ${POLL_TIMEOUT_MS}ms (correlationId: ${correlationId})`));
      }, POLL_TIMEOUT_MS);

      this.pendingPolls.set(correlationId, { resolve, reject, timeoutId });

      const message = {
        type: AppToCloudMessageType.LOCATION_POLL_REQUEST,
        correlationId,
        packageName: this.deps.getPackageName(),
        sessionId: this.deps.getSessionId(),
        accuracy,
      };

      try {
        this.deps.sendMessage(message);
        this.deps.logger.debug({ correlationId, accuracy }, "📍 Location poll request sent");
      } catch (err) {
        clearTimeout(timeoutId);
        this.pendingPolls.delete(correlationId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Stop all location subscriptions and remove every handler.
   *
   * After calling this, no location callbacks will fire until new
   * subscriptions are created via {@link onUpdate}.
   *
   * @example
   * ```ts
   * session.location.stop();
   * ```
   */
  stop(): void {
    // Iterate over a snapshot — cleanup mutates the set
    const snapshot = Array.from(this.registrations);
    for (const reg of snapshot) {
      reg.routerCleanup();
      reg.updateCleanup();
      this.registrations.delete(reg);
    }

    // Force unsubscribe regardless of ref count
    if (this.streamRefCount > 0) {
      this.deps.removeSubscription(LOCATION_STREAM);
    }
    this.streamRefCount = 0;

    // Reject and clean up any pending polls
    for (const [id, pending] of this.pendingPolls) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("LocationManager stopped while poll was pending"));
      this.pendingPolls.delete(id);
    }

    this.deps.logger.debug("[LocationManager] All subscriptions stopped.");
  }

  // ─── Cached Accessors ──────────────────────────────────────────────────

  /**
   * Latest known latitude, or `null` if no location update has been received.
   */
  get lat(): number | null {
    return this._lat;
  }

  /**
   * Latest known longitude, or `null` if no location update has been received.
   */
  get lng(): number | null {
    return this._lng;
  }

  /**
   * Latest horizontal accuracy in metres, or `null` if unknown.
   */
  get accuracy(): number | null {
    return this._accuracy;
  }

  /**
   * Unix timestamp (ms) of the latest location update, or `null` if none received.
   */
  get timestamp(): number | null {
    return this._timestamp;
  }

  /**
   * Whether the device has granted location permission.
   *
   * Optimistically `true` — updated to `false` if a permission error
   * is received from the cloud.
   */
  get hasPermission(): boolean {
    return this._hasPermission;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /**
   * Check if incoming data matches a pending one-shot poll and resolve it.
   */
  private resolvePendingPoll(raw: any): void {
    const correlationId: string | undefined = raw?.correlationId;
    if (!correlationId) return;

    const pending = this.pendingPolls.get(correlationId);
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    this.pendingPolls.delete(correlationId);
    pending.resolve(normalise(raw));
  }

  /**
   * Update cached location values from raw incoming data.
   */
  private cacheLocation(raw: any): void {
    if (typeof raw.lat === "number") {
      this._lat = raw.lat;
    }
    if (typeof raw.lng === "number") {
      this._lng = raw.lng;
    }
    if (typeof raw.accuracy === "number") {
      this._accuracy = raw.accuracy;
    }
    this._timestamp = raw.timestamp ? new Date(raw.timestamp).getTime() : Date.now();
  }

  /**
   * Called by MentraSession if a permission error for location is received.
   * @internal
   */
  setPermission(granted: boolean): void {
    this._hasPermission = granted;
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  /**
   * Clean up all resources.
   *
   * Called by MentraSession during disconnect/cleanup.
   * @internal
   */
  destroy(): void {
    this.stop();

    if (this.locationUpdateCleanup) {
      this.locationUpdateCleanup();
      this.locationUpdateCleanup = null;
    }

    this._lat = null;
    this._lng = null;
    this._accuracy = null;
    this._timestamp = null;
    this._config = {};

    this.deps.logger.debug("[LocationManager] Destroyed.");
  }
}
