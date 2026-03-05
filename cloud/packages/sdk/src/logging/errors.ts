/**
 * MentraOS SDK Error Classes
 *
 * Structured error hierarchy for programmatic error handling.
 * All classes extend Error so `instanceof Error` checks still work (backward compatible).
 *
 * Usage:
 * ```typescript
 * import { MentraAuthError, MentraConnectionError } from '@mentra/sdk';
 *
 * session.events.onError((error) => {
 *   if (error instanceof MentraAuthError) {
 *     console.log('Bad API key, check your config');
 *   } else if (error instanceof MentraConnectionError) {
 *     console.log('Connection issue, will retry');
 *   }
 * });
 * ```
 */

/**
 * Base error class for all MentraOS SDK errors.
 *
 * Every SDK error has a `.code` string for programmatic matching
 * without relying on `.message` string parsing.
 */
export class MentraError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "MentraError";
    // Fix prototype chain for instanceof checks in transpiled code.
    // TypeScript/Bun transpilation can break `instanceof` for subclassed builtins
    // without this. See: https://github.com/microsoft/TypeScript/wiki/Breaking-Changes#extending-built-ins-like-error-array-and-map-may-no-longer-work
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Authentication or authorization failure.
 *
 * Thrown/emitted when:
 * - API key is invalid or expired
 * - Token verification fails
 * - Cloud rejects credentials
 */
export class MentraAuthError extends MentraError {
  constructor(message: string) {
    super(message, "AUTH_ERROR");
    this.name = "MentraAuthError";
  }
}

/**
 * Connection-level failure.
 *
 * Thrown/emitted when:
 * - WebSocket connection is refused (ECONNREFUSED)
 * - Connection is lost unexpectedly
 * - All reconnection attempts are exhausted
 * - Server is unreachable
 */
export class MentraConnectionError extends MentraError {
  constructor(message: string, code: string = "CONNECTION_ERROR") {
    super(message, code);
    this.name = "MentraConnectionError";
  }
}

/**
 * Operation timed out.
 *
 * Thrown/emitted when:
 * - WebSocket connection handshake exceeds timeout
 * - Photo request times out
 * - Audio play request times out
 */
export class MentraTimeoutError extends MentraError {
  constructor(message: string) {
    super(message, "TIMEOUT_ERROR");
    this.name = "MentraTimeoutError";
  }
}

/**
 * Configuration or input validation failure.
 *
 * Thrown synchronously when:
 * - WebSocket URL is missing or malformed
 * - Layout is missing required properties
 * - Invalid language code is provided
 * - Required config fields are absent
 */
export class MentraValidationError extends MentraError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
    this.name = "MentraValidationError";
  }
}

/**
 * Permission denied by MentraOS Cloud.
 *
 * Emitted when:
 * - App subscribes to a stream it lacks permission for
 * - Cloud rejects a subscription request
 *
 * Includes the stream name and required permission for programmatic handling.
 */
export class MentraPermissionError extends MentraError {
  constructor(
    message: string,
    public readonly stream: string,
    public readonly requiredPermission: string,
  ) {
    super(message, "PERMISSION_ERROR");
    this.name = "MentraPermissionError";
  }
}
