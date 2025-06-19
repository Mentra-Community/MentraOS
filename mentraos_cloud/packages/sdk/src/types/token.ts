/**
 * 🔐 TpaToken Types Module
 * 
 * Defines types for the TPA token authentication mechanism.
 */

/**
 * The payload structure for TPA tokens
 */
export interface TpaTokenPayload {
  /** User identifier */
  userId: string;

  /** TPA package name */
  packageName: string;

  /** Session identifier */
  sessionId: string;

  /** UNIX timestamp when token was issued (in seconds) */
  iat?: number;

  /** UNIX timestamp when token expires (in seconds) */
  exp?: number;
}

/**
 * Response from validating a TPA token
 */
export interface TokenValidationResult {
  /** Whether the token is valid */
  valid: boolean;

  /** The decoded payload if valid */
  payload?: TpaTokenPayload;

  /** Error message if invalid */
  error?: string;
}

/**
 * Configuration for token creation
 */
export interface TokenConfig {
  /** Secret key used for signing (should match AugmentOS Cloud) */
  secretKey: string;

  /** Token expiration time in seconds (default: 300 - 5 minutes) */
  expiresIn?: number;
}