/**
 * 🔐 TPA Token Utilities
 * 
 * Provides utilities for working with TPA tokens.
 */
import * as jwt from 'jsonwebtoken';
import { TpaTokenPayload, TokenValidationResult, TokenConfig } from '../../types/token';

/**
 * Default token expiration (1 day)
 */
const DEFAULT_EXPIRATION = 60 * 60 * 24; // seconds * minutes * hours (1 day).

/**
 * Create a TPA token for a user session
 * 
 * @param payload - Token payload data
 * @param config - Token configuration
 * @returns JWT token string
 * 
 * @example
 * ```typescript
 * const token = createToken(
 *   { 
 *     userId: 'user123',
 *     packageName: 'org.example.myapp',
 *     sessionId: 'session789'
 *   },
 *   { secretKey: 'your_secret_key' }
 * );
 * ```
 */
export function createToken(
  payload: Omit<TpaTokenPayload, 'iat' | 'exp'>,
  config: TokenConfig
): string {
  return jwt.sign(
    payload,
    config.secretKey,
    { expiresIn: config.expiresIn || DEFAULT_EXPIRATION }
  );
}

/**
 * Validate and decode a TPA token
 * 
 * @param token - JWT token string
 * @param secretKey - Secret key used for validation
 * @returns Token validation result
 * 
 * @example
 * ```typescript
 * const result = validateToken('eyJhbGciOiJIUzI1...', 'your_secret_key');
 * if (result.valid) {
 *   // Use result.payload
 * }
 * ```
 */
export function validateToken(
  token: string,
  secretKey: string
): TokenValidationResult {
  try {
    const decoded = jwt.verify(token, secretKey) as TpaTokenPayload;
    return {
      valid: true,
      payload: decoded
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Generate a webview URL with an embedded TPA token
 * 
 * @param baseUrl - Base URL of the webview
 * @param token - JWT token string
 * @returns Full URL with token parameter
 * 
 * @example
 * ```typescript
 * const url = generateWebviewUrl(
 *   'https://example.com/webview',
 *   'eyJhbGciOiJIUzI1...'
 * );
 * // Returns: https://example.com/webview?token=eyJhbGciOiJIUzI1...
 * ```
 */
export function generateWebviewUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.searchParams.append('token', token);
  return url.toString();
}

/**
 * Extract a TPA token from a URL
 * 
 * @param url - URL string containing a token parameter
 * @returns Token string or null if not found
 * 
 * @example
 * ```typescript
 * const token = extractTokenFromUrl(
 *   'https://example.com/webview?token=eyJhbGciOiJIUzI1...'
 * );
 * ```
 */
export function extractTokenFromUrl(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.searchParams.get('token');
  } catch (error) {
    return null;
  }
}