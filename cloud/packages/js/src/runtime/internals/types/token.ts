/**
 * 🔐 AppToken Types Module
 *
 * Defines types for the App token authentication mechanism.
 */

/**
 * The payload structure for App tokens
 */
export interface AppTokenPayload {
  /** User identifier */
  userId: string;

  /** App package name */
  packageName: string;

  /** Session identifier */
  sessionId: string;

  /** UNIX timestamp when token was issued (in seconds) */
  iat?: number;

  /** UNIX timestamp when token expires (in seconds) */
  exp?: number;
}

/**
 * Response from validating a App token
 */
export interface TokenValidationResult {
  /** Whether the token is valid */
  valid: boolean;

  /** The decoded payload if valid */
  payload?: AppTokenPayload;

  /** Error message if invalid */
  error?: string;
}

/**
 * Configuration for token creation
 */
export interface TokenConfig {
  /** Secret key used for signing (should match MentraOS Cloud) */
  secretKey: string;

  /** Token expiration time in seconds (default: 300 - 5 minutes) */
  expiresIn?: number;
}
