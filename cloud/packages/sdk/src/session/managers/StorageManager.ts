/**
 * StorageManager — v3 SDK Key-Value Storage API
 *
 * Wraps the existing SimpleStorage patterns from v2 with a cleaner,
 * composable API. Provides localStorage-like semantics with cloud
 * synchronisation via HTTP REST endpoints.
 *
 * **Mental Model:** Local cache (RAM) is the source of truth for reads.
 * Writes are applied to RAM immediately and batched/debounced to the
 * server for persistence. On disconnect, pending writes are flushed.
 *
 * Data is isolated by userId and packageName on the server side.
 * The REST endpoints live on the SDK's own HTTP server (same origin
 * as the WebSocket connection, minus the `/app-ws` path).
 *
 * REST API:
 * - `GET    /api/sdk/simple-storage/:userId`            → fetch all data
 * - `PUT    /api/sdk/simple-storage/:userId`             → batch upsert `{ data: { key: value } }`
 * - `DELETE /api/sdk/simple-storage/:userId/:key`        → delete single key
 * - `DELETE /api/sdk/simple-storage/:userId`             → clear all data
 *
 * @module
 */

// ─── Public Types ───────────────────────────────────────────────────────────

/**
 * Dependencies injected by MentraSession.
 *
 * Structural type — no concrete imports so the manager stays unit-testable
 * with plain stubs.
 */
export interface StorageManagerDeps {
  /** DataStreamRouter — not used by StorageManager but part of the shared shape. */
  router: {
    on(key: string, handler: (streamType: string, data: any, message: any) => void): () => void;
  };
  /** MessageHandlerRegistry — not used by StorageManager but part of the shared shape. */
  messageHandlers: {
    register(type: string, handler: (msg: any) => void): () => void;
  };
  /** Add a subscription string (not used by StorageManager). */
  addSubscription: (stream: string) => void;
  /** Remove a subscription string (not used by StorageManager). */
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
  /** Package name — used for auth headers. */
  getPackageName: () => string;
  /** Current session ID. */
  getSessionId: () => string;
  /** Server URL for HTTP API calls (WebSocket URL or HTTP base). */
  getServerUrl?: () => string | null;
}

/**
 * Configuration options for StorageManager.
 */
export interface StorageManagerConfig {
  /** User ID for storage isolation. */
  userId: string;
  /** API key for authentication. */
  apiKey?: string;
}

// ─── Internal Types ─────────────────────────────────────────────────────────

/** Shape of the GET response from the storage API. */
interface StorageResponse {
  success: boolean;
  data?: Record<string, string>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum size for a single value in bytes/characters. */
const MAX_VALUE_SIZE = 100_000; // 100 KB

/** Debounce idle time before flushing pending writes to the server. */
const DEBOUNCE_MS = 3_000; // 3 seconds

/** Maximum wait time before forcing a flush, regardless of activity. */
const MAX_WAIT_MS = 10_000; // 10 seconds

// ─── Manager ────────────────────────────────────────────────────────────────

/**
 * Key-value storage with local caching and debounced cloud sync.
 *
 * Provides a familiar `get`/`set`/`delete`/`clear` interface backed by
 * an in-memory cache with automatic persistence to the MentraOS cloud.
 * Writes are batched and debounced to minimise network traffic.
 *
 * @example
 * ```ts
 * const session = await mentra.connect();
 *
 * // Set a value
 * await session.storage.set("username", "alice");
 *
 * // Get a value
 * const name = await session.storage.get("username");
 * console.log(name); // "alice"
 *
 * // Check existence
 * const exists = await session.storage.has("username");
 *
 * // Delete a key
 * await session.storage.delete("username");
 *
 * // Flush pending writes immediately
 * await session.storage.flush();
 * ```
 */
export class StorageManager {
  private readonly deps: StorageManagerDeps;
  private readonly userId: string;
  private readonly apiKey: string;

  /** Local cache — `null` means "not yet loaded from server". */
  private cache: Record<string, any> | null = null;

  /** Base URL for HTTP API calls. */
  private readonly baseUrl: string;

  // ─── Debounce / Batching State ──────────────────────────────────────────

  /** Pending writes waiting to be flushed. */
  private pendingWrites = new Map<string, any>();

  /** Timer for the idle debounce window. */
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  /** Timer for the maximum wait window. */
  private maxWaitTimer: ReturnType<typeof setTimeout> | undefined;

  /** Timestamp of the first write in the current batch. */
  private firstWriteTime: number | undefined;

  constructor(deps: StorageManagerDeps, config: StorageManagerConfig) {
    this.deps = deps;
    this.userId = config.userId;
    this.apiKey = config.apiKey ?? "unknown-api-key";
    this.baseUrl = this.resolveBaseUrl();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Get a value by key.
   *
   * Reads from the local cache. If the cache has not been populated yet,
   * it is fetched from the server first.
   *
   * @param key - The storage key to retrieve.
   * @returns The stored value, or `undefined` if the key does not exist.
   *
   * @example
   * ```ts
   * const value = await session.storage.get("theme");
   * ```
   */
  async get(key: string): Promise<any> {
    try {
      await this.ensureCacheLoaded();
      return this.cache?.[key];
    } catch (error) {
      this.deps.logger.error("[StorageManager] Error getting item:", error);
      return undefined;
    }
  }

  /**
   * Set a value for a key.
   *
   * The local cache is updated immediately. The write is batched and
   * debounced — it will be persisted to the server after 3 seconds of
   * idle time or 10 seconds maximum, whichever comes first.
   *
   * @param key - The storage key.
   * @param value - The value to store. Will be serialised as JSON on the server.
   * @throws If the serialised value exceeds the 100 KB size limit.
   *
   * @example
   * ```ts
   * await session.storage.set("score", "42");
   * ```
   */
  async set(key: string, value: any): Promise<void> {
    const serialised = typeof value === "string" ? value : JSON.stringify(value);

    if (serialised.length > MAX_VALUE_SIZE) {
      throw new Error(
        `StorageManager value exceeds 100KB limit (${serialised.length} chars). ` +
          `For large files, use your own S3 bucket storage.`,
      );
    }

    await this.ensureCacheLoaded();

    // Optimistic update — RAM is source of truth
    if (this.cache) {
      this.cache[key] = serialised;
    }

    // Add to pending batch
    this.pendingWrites.set(key, serialised);

    // Schedule debounced flush
    this.scheduleFlush();
  }

  /**
   * Delete a single key.
   *
   * Removes the key from the local cache immediately and sends a DELETE
   * request to the server. Unlike `set()`, deletes are flushed immediately
   * for consistency.
   *
   * @param key - The storage key to remove.
   *
   * @example
   * ```ts
   * await session.storage.delete("old-key");
   * ```
   */
  async delete(key: string): Promise<void> {
    try {
      await this.ensureCacheLoaded();

      // Remove from local cache
      if (this.cache) {
        delete this.cache[key];
      }

      // Remove from pending writes if queued
      this.pendingWrites.delete(key);

      // Flush delete immediately to server
      const response = await fetch(
        `${this.baseUrl}/api/sdk/simple-storage/${encodeURIComponent(this.userId)}/${encodeURIComponent(key)}`,
        {
          method: "DELETE",
          headers: this.getAuthHeaders(),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.deps.logger.error("[StorageManager] Failed to delete key from server:", errorText);
      }
    } catch (error) {
      this.deps.logger.error("[StorageManager] Error deleting item:", error);
    }
  }

  /**
   * Clear all stored data.
   *
   * Empties the local cache and sends a DELETE request to remove all
   * data from the server.
   *
   * @example
   * ```ts
   * await session.storage.clear();
   * ```
   */
  async clear(): Promise<void> {
    try {
      // Clear local state
      this.cache = {};
      this.pendingWrites.clear();
      this.clearTimers();

      // Clear on server
      const response = await fetch(`${this.baseUrl}/api/sdk/simple-storage/${encodeURIComponent(this.userId)}`, {
        method: "DELETE",
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.deps.logger.error("[StorageManager] Failed to clear storage on server:", errorText);
      }
    } catch (error) {
      this.deps.logger.error("[StorageManager] Error clearing storage:", error);
    }
  }

  /**
   * Get all storage keys.
   *
   * @returns An array of all keys currently in storage.
   *
   * @example
   * ```ts
   * const allKeys = await session.storage.keys();
   * console.log("Stored keys:", allKeys);
   * ```
   */
  async keys(): Promise<string[]> {
    try {
      await this.ensureCacheLoaded();
      return Object.keys(this.cache || {});
    } catch (error) {
      this.deps.logger.error("[StorageManager] Error getting keys:", error);
      return [];
    }
  }

  /**
   * Check whether a key exists in storage.
   *
   * @param key - The storage key to check.
   * @returns `true` if the key exists.
   *
   * @example
   * ```ts
   * if (await session.storage.has("user-prefs")) {
   *   // load prefs
   * }
   * ```
   */
  async has(key: string): Promise<boolean> {
    try {
      await this.ensureCacheLoaded();
      return key in (this.cache || {});
    } catch (error) {
      this.deps.logger.error("[StorageManager] Error checking key:", error);
      return false;
    }
  }

  /**
   * Get a shallow copy of all stored key-value pairs.
   *
   * @returns A record of all stored data.
   *
   * @example
   * ```ts
   * const allData = await session.storage.getAll();
   * console.log(allData);
   * ```
   */
  async getAll(): Promise<Record<string, any>> {
    try {
      await this.ensureCacheLoaded();
      return { ...(this.cache || {}) };
    } catch (error) {
      this.deps.logger.error("[StorageManager] Error getting all data:", error);
      return {};
    }
  }

  /**
   * Set multiple key-value pairs at once.
   *
   * All values are validated for size before any are applied. The local
   * cache is updated immediately and writes are batched for persistence.
   *
   * @param data - A record of key-value pairs to set.
   * @throws If any value exceeds the 100 KB size limit.
   *
   * @example
   * ```ts
   * await session.storage.setMultiple({
   *   theme: "dark",
   *   language: "en",
   *   fontSize: "14",
   * });
   * ```
   */
  async setMultiple(data: Record<string, any>): Promise<void> {
    // Validate all values first
    for (const [key, value] of Object.entries(data)) {
      const serialised = typeof value === "string" ? value : JSON.stringify(value);
      if (serialised.length > MAX_VALUE_SIZE) {
        throw new Error(`StorageManager value for key "${key}" exceeds 100KB limit (${serialised.length} chars).`);
      }
    }

    await this.ensureCacheLoaded();

    // Update cache and pending writes
    for (const [key, value] of Object.entries(data)) {
      const serialised = typeof value === "string" ? value : JSON.stringify(value);
      if (this.cache) {
        this.cache[key] = serialised;
      }
      this.pendingWrites.set(key, serialised);
    }

    // Schedule debounced flush
    this.scheduleFlush();
  }

  /**
   * Flush all pending writes to the server immediately.
   *
   * This is called automatically by the debounce/max-wait timers, but can
   * also be called explicitly (e.g., before disconnect). If there are no
   * pending writes, this is a no-op.
   *
   * @throws If the server returns an error (413 for size limit, 429 for rate limit).
   *
   * @example
   * ```ts
   * await session.storage.flush();
   * ```
   */
  async flush(): Promise<void> {
    if (this.pendingWrites.size === 0) return;

    // Clear all timers
    this.clearTimers();

    // Snapshot and clear pending writes
    const batch = Object.fromEntries(this.pendingWrites);
    this.pendingWrites.clear();

    try {
      const response = await fetch(`${this.baseUrl}/api/sdk/simple-storage/${encodeURIComponent(this.userId)}`, {
        method: "PUT",
        headers: this.getAuthHeaders(),
        body: JSON.stringify({ data: batch }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.deps.logger.error("[StorageManager] Failed to persist writes:", errorText);

        if (response.status === 413) {
          throw new Error("StorageManager total size exceeds 1MB limit. Delete unused keys.");
        }
        if (response.status === 429) {
          throw new Error("StorageManager rate limit exceeded.");
        }
        throw new Error(`StorageManager flush failed: ${errorText}`);
      }
    } catch (error) {
      this.deps.logger.error("[StorageManager] Error flushing writes:", error);
      throw error;
    }
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  /**
   * Flush pending writes and clean up all resources.
   *
   * Called by MentraSession during disconnect/cleanup.
   * @internal
   */
  async destroy(): Promise<void> {
    // Attempt to flush any pending writes before shutting down
    try {
      await this.flush();
    } catch (error) {
      this.deps.logger.error("[StorageManager] Error flushing on destroy:", error);
    }

    this.clearTimers();
    this.pendingWrites.clear();
    this.cache = null;

    this.deps.logger.debug("[StorageManager] Destroyed.");
  }

  // ─── Internal: Cache Loading ────────────────────────────────────────────

  /**
   * Ensure the local cache is populated from the server.
   * Only fetches once — subsequent calls are no-ops.
   */
  private async ensureCacheLoaded(): Promise<void> {
    if (this.cache !== null) return;
    await this.fetchFromServer();
  }

  /**
   * Fetch all stored data from the server and populate the local cache.
   */
  private async fetchFromServer(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/sdk/simple-storage/${encodeURIComponent(this.userId)}`, {
        headers: this.getAuthHeaders(),
      });

      if (response.ok) {
        const result = (await response.json()) as StorageResponse;
        if (result.success && result.data) {
          this.cache = result.data;
        } else {
          this.cache = {};
        }
      } else {
        this.deps.logger.error("[StorageManager] Failed to fetch storage from server:", await response.text());
        this.cache = {};
      }
    } catch (error) {
      this.deps.logger.error("[StorageManager] Error fetching storage from server:", error);
      this.cache = {};
    }
  }

  // ─── Internal: Debounce / Batching ──────────────────────────────────────

  /**
   * Schedule a debounced flush of pending writes.
   *
   * Uses a two-timer strategy:
   * 1. **Idle timer** — fires after {@link DEBOUNCE_MS} of inactivity (reset on each write).
   * 2. **Max wait timer** — fires after {@link MAX_WAIT_MS} from the first write in the batch,
   *    ensuring writes are never delayed indefinitely during continuous activity.
   */
  private scheduleFlush(): void {
    // Track first write time for max-wait calculation
    if (!this.firstWriteTime) {
      this.firstWriteTime = Date.now();
    }

    // Clear existing idle debounce timer
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    // Calculate remaining time until max-wait deadline
    const elapsedMs = Date.now() - this.firstWriteTime;
    const remainingMaxWaitMs = MAX_WAIT_MS - elapsedMs;

    // If max wait already exceeded, flush immediately
    if (remainingMaxWaitMs <= 0) {
      this.flush().catch((err) => {
        this.deps.logger.error("[StorageManager] Error in scheduled flush:", err);
      });
      return;
    }

    // Set idle debounce timer (capped at remaining max-wait)
    this.debounceTimer = setTimeout(
      () => {
        this.flush().catch((err) => {
          this.deps.logger.error("[StorageManager] Error in debounced flush:", err);
        });
      },
      Math.min(DEBOUNCE_MS, remainingMaxWaitMs),
    );

    // Set max-wait timer if not already running
    if (this.maxWaitTimer === undefined && remainingMaxWaitMs > 0) {
      this.maxWaitTimer = setTimeout(() => {
        this.flush().catch((err) => {
          this.deps.logger.error("[StorageManager] Error in max-wait flush:", err);
        });
      }, remainingMaxWaitMs);
    }
  }

  /**
   * Clear all flush timers and reset batch tracking state.
   */
  private clearTimers(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.maxWaitTimer !== undefined) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = undefined;
    }
    this.firstWriteTime = undefined;
  }

  // ─── Internal: HTTP Helpers ─────────────────────────────────────────────

  /**
   * Resolve the base URL for HTTP API calls.
   *
   * Converts the WebSocket URL (e.g., `wss://host/app-ws`) to an HTTP URL
   * (e.g., `https://host`). Falls back to `http://localhost:8002` if no
   * server URL is available.
   */
  private resolveBaseUrl(): string {
    const serverUrl = this.deps.getServerUrl?.() ?? null;
    if (!serverUrl) return "http://localhost:8002";
    return serverUrl.replace(/\/app-ws$/, "").replace(/^ws/, "http");
  }

  /**
   * Generate auth headers for API requests.
   *
   * Uses the `packageName:apiKey` format expected by the SDK server's
   * auth middleware.
   */
  private getAuthHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.deps.getPackageName()}:${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }
}
