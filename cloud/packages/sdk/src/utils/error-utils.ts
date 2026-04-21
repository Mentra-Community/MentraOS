/**
 * Error Utilities
 *
 * Shared error handling utilities to replace the ~20 copy-pasted
 * error wrapping patterns throughout the old AppSession.
 *
 * Before (scattered across AppSession):
 *   } catch (error) {
 *     const errorMessage = error instanceof Error ? error.message : String(error);
 *     this.logger.error({ error: errorMessage }, "Something failed");
 *   }
 *
 * After:
 *   } catch (error) {
 *     this.logger.error({ error: toErrorMessage(error) }, "Something failed");
 *   }
 */

// ─── Error Message Extraction ───────────────────────────────────────────────

/**
 * Safely extract a human-readable error message from any thrown value.
 *
 * JavaScript allows throwing anything — Error objects, strings, numbers,
 * null, undefined, objects, etc. This function normalizes all of them
 * into a string suitable for logging.
 *
 * @param error - Any value that was thrown or caught
 * @returns A string error message
 *
 * @example
 * ```ts
 * try {
 *   await doSomething();
 * } catch (error) {
 *   logger.error({ error: toErrorMessage(error) }, "doSomething failed");
 * }
 * ```
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error === null) {
    return "null";
  }
  if (error === undefined) {
    return "undefined";
  }
  if (typeof error === "object") {
    // Some libraries throw plain objects with a message field
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") {
      return obj.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

// ─── Error Wrapping ─────────────────────────────────────────────────────────

/**
 * Wrap an unknown caught value into a proper Error instance.
 * If it's already an Error, returns it as-is.
 * Otherwise, creates a new Error with the extracted message.
 *
 * Useful when you need to re-throw or pass an Error object
 * but the catch block might have received a non-Error value.
 *
 * @param error - Any value that was thrown or caught
 * @param fallbackMessage - Optional message to use if the error has no message
 * @returns An Error instance
 *
 * @example
 * ```ts
 * try {
 *   await riskyOperation();
 * } catch (error) {
 *   throw toError(error, "riskyOperation failed");
 * }
 * ```
 */
export function toError(error: unknown, fallbackMessage?: string): Error {
  if (error instanceof Error) {
    return error;
  }
  const message = toErrorMessage(error);
  return new Error(message || fallbackMessage || "Unknown error");
}

// ─── Safe Execution ─────────────────────────────────────────────────────────

/**
 * Execute a function and swallow any errors, optionally logging them.
 * Used for fire-and-forget operations where failure is acceptable
 * (e.g., cleanup handlers, optional notifications, analytics).
 *
 * @param fn - The function to execute
 * @param onError - Optional error handler (e.g., logger.warn)
 *
 * @example
 * ```ts
 * // Cleanup that shouldn't throw
 * safeExec(() => transport.close(), (err) => logger.warn({ err }, "close failed"));
 *
 * // Fire-and-forget analytics
 * safeExec(() => trackEvent("session_start"));
 * ```
 */
export function safeExec(fn: () => void, onError?: (error: Error) => void): void {
  try {
    fn();
  } catch (err) {
    if (onError) {
      onError(toError(err));
    }
  }
}

/**
 * Execute an async function and swallow any errors, optionally logging them.
 * Async version of safeExec.
 *
 * @param fn - The async function to execute
 * @param onError - Optional error handler
 *
 * @example
 * ```ts
 * await safeExecAsync(
 *   () => session.storage.set("lastActive", Date.now()),
 *   (err) => logger.warn({ err }, "Failed to persist lastActive")
 * );
 * ```
 */
export async function safeExecAsync(fn: () => Promise<void>, onError?: (error: Error) => void): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (onError) {
      onError(toError(err));
    }
  }
}

// ─── Deprecation Warnings ───────────────────────────────────────────────────

/**
 * Set of deprecation keys that have already been warned about.
 * Prevents spamming the console with the same deprecation warning
 * on every access — warns once per session, not once per call.
 */
const _deprecationWarnings = new Set<string>();

/**
 * Log a deprecation warning once per key per process lifetime.
 * Subsequent calls with the same key are silently ignored.
 *
 * @param key - Unique identifier for this deprecation (e.g., "session.layouts")
 * @param message - The deprecation message to log
 * @param logger - Optional structured logger; falls back to console.warn
 *
 * @example
 * ```ts
 * get layouts() {
 *   warnOnce(
 *     "session.layouts",
 *     "session.layouts is deprecated. Use session.display instead.",
 *     this.logger
 *   );
 *   return this.display;
 * }
 * ```
 */
export function warnOnce(key: string, message: string, logger?: { warn: (msg: string) => void }): void {
  if (_deprecationWarnings.has(key)) return;
  _deprecationWarnings.add(key);

  const formatted = `⚠️  DEPRECATION: ${message}`;
  if (logger) {
    logger.warn(formatted);
  } else {
    console.warn(formatted);
  }
}

/**
 * Reset all deprecation warning state.
 * Only useful in tests to ensure warnings fire again.
 */
export function resetDeprecationWarnings(): void {
  _deprecationWarnings.clear();
}

// ─── Timeout Utility ────────────────────────────────────────────────────────

/**
 * Create a promise that rejects after a timeout.
 * Useful for racing against operations that might hang.
 *
 * @param ms - Timeout in milliseconds
 * @param message - Error message on timeout
 * @returns A promise that rejects after `ms` milliseconds
 *
 * @example
 * ```ts
 * const result = await Promise.race([
 *   doSlowThing(),
 *   timeout(5000, "doSlowThing timed out after 5s"),
 * ]);
 * ```
 */
export function timeout(ms: number, message?: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(message ?? `Operation timed out after ${ms}ms`));
    }, ms);
  });
}
