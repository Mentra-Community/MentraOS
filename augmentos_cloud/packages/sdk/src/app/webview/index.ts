// src/app/webview/index.ts
import axios from 'axios';
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../types';
// Note: Your Express app needs to use cookie-parser middleware for this to work
// Example: app.use(require('cookie-parser')());
import * as crypto from 'crypto';
import { KEYUTIL, KJUR, RSAKey } from "jsrsasign";


const userTokenPublicKey = process.env.MENTRAOS_CLOUD_USER_TOKEN_PUBLIC_KEY || "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Yt2RtNOdeKQxWMY0c84\nADpY1Jy58YWZhaEgP2A5tBwFUKgy/TH9gQLWZjQ3dQ/6XXO8qq0kluoYFqM7ZDRF\nzJ0E4Yi0WQncioLRcCx4q8pDmqY9vPKgv6PruJdFWca0l0s3gZ3BqSeWum/C23xK\nFPHPwi8gvRdc6ALrkcHeciM+7NykU8c0EY8PSitNL+Tchti95kGu+j6APr5vNewi\nzRpQGOdqaLWe+ahHmtj6KtUZjm8o6lan4f/o08C6litizguZXuw2Nn/Kd9fFI1xF\nIVNJYMy9jgGaOi71+LpGw+vIpwAawp/7IvULDppvY3DdX5nt05P1+jvVJXPxMKzD\nTQIDAQAB\n-----END PUBLIC KEY-----";


/**
 * Extracts the temporary token from a URL string.
 * @param url The URL string, typically window.location.href.
 * @returns The token string or null if not found.
 */
export function extractTempToken(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.searchParams.get('aos_temp_token');
  } catch (e) {
    console.error("Error parsing URL for temp token:", e);
    return null;
  }
}

/**
 * Exchanges a temporary token for a user ID with the MentraOS Cloud.
 * This should be called from the App's backend server.
 * @param cloudApiUrl The base URL of the MentraOS Cloud API.
 * @param tempToken The temporary token obtained from the webview URL.
 * @param apiKey Your App's secret API key.
 * @returns A Promise that resolves with an object containing the userId.
 * @throws Throws an error if the exchange fails (e.g., invalid token, expired, network error).
 */
export async function exchangeToken(
  cloudApiUrl: string,
  tempToken: string,
  apiKey: string,
  packageName: string
): Promise<{ userId: string }> {
  const endpoint = `${cloudApiUrl}/api/auth/exchange-user-token`;
  console.log(`Exchanging token for user at ${endpoint}`);
  try {
    const response = await axios.post(
      endpoint,
      { aos_temp_token: tempToken, packageName: packageName },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: 10000, // 10 second timeout
      }
    );

    if (response.status === 200 && response.data.success && response.data.userId) {
      return { userId: response.data.userId };
    } else {
      // Handle specific error messages from the server if available
      const errorMessage = response.data?.error || `Failed with status ${response.status}`;
      throw new Error(errorMessage);
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const data = error.response?.data;
      const message = data?.error || error.message || 'Unknown error during token exchange';
      console.error(`Token exchange failed with status ${status}: ${message}`);
      throw new Error(`Token exchange failed: ${message}`);
    } else {
      console.error('Unexpected error during token exchange:', error);
      throw new Error('An unexpected error occurred during token exchange.');
    }
  }
}

/**
 * Signs a user ID to create a secure session token.
 * @param userId The user ID to sign
 * @param secret The secret key used for signing
 * @returns A signed session token string
 */
function signSession(userId: string, secret: string): string {
  // Format: userId.timestamp.signature
  const timestamp = Date.now();
  const data = `${userId}|${timestamp}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('hex');

  return `${data}|${signature}`;
}

/**
 * Verifies and extracts the user ID from a signed session token.
 * @param token The signed session token
 * @param secret The secret key used for verification
 * @param maxAge The maximum age of the token in milliseconds
 * @returns The extracted user ID if valid, or null if invalid
 */
function verifySession(token: string, secret: string, maxAge?: number): string | null {
  try {
    const parts = token.split('|');
    if (parts.length !== 3) return null;

    const [userId, timestampStr, signature] = parts;
    const timestamp = parseInt(timestampStr, 10);

    // Check if token has expired
    if (maxAge && Date.now() - timestamp > maxAge) {
      console.log(`Session token expired: ${token}.  Parsed date is ${timestamp}, meaning age is ${Date.now() - timestamp}, but maxAge is ${maxAge}`);
      return null;
    }

    // Verify signature
    const data = `${userId}|${timestamp}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('hex');

    if (signature !== expectedSignature) {
      console.log(`Session token signature mismatch: ${signature} !== ${expectedSignature}`);
      return null;
    }

    return userId;
  } catch (error) {
    console.error("Session verification failed:", error);
    return null;
  }
}

/**
 * Verifies a signed user token and extracts the user ID from it
 * @param signedUserToken The JWT token to verify
 * @returns The user ID (subject) from the token, or null if invalid
 */
async function verifySignedUserToken(signedUserToken: string): Promise<string | null> {
  try {
    // 1. Parse the PEM public key into a jsrsasign key object
    const publicKeyObj = KEYUTIL.getKey(userTokenPublicKey) as RSAKey;
    // 2. Verify JWT signature + claims (issuer, exp, iat) with 2-min tolerance
    const isValid = KJUR.jws.JWS.verifyJWT(signedUserToken, publicKeyObj, {
      alg: ["RS256"],
      iss: ["https://prod.augmentos.cloud"],
      verifyAt: KJUR.jws.IntDate.get("now"),
      gracePeriod: 120,
    });
    if (!isValid) return null;

    // 3. Decode payload and return the subject (user ID)
    const parsed = KJUR.jws.JWS.parse(signedUserToken);
    return (parsed.payloadObj as { sub: string }).sub || null;
  } catch (e) {
    console.error("[verifySignedUserToken] Error verifying token:", e);
    return null;
  }
}

/**
 * Verifies a frontend token by comparing it to a secure hash of the API key
 * @param frontendToken The token to verify (should be a hash of the API key)
 * @param apiKey The API key to hash and compare against
 * @param userId Optional user ID that may be embedded in the token format
 * @returns The user ID if the token is valid, or null if invalid
 */
function verifyFrontendToken(frontendToken: string, apiKey: string): string | null {
  try {
    // Check if the token contains a user ID and hash separated by a colon
    const tokenParts = frontendToken.split(':');

    if (tokenParts.length === 2) {
      // Format: userId:hash
      const [tokenUserId, tokenHash] = tokenParts;

      // Align the hashing algorithm with server-side `hashWithApiKey`
      // 1. Hash the API key first (server only stores the hashed version)
      const hashedApiKey = crypto.createHash('sha256').update(apiKey).digest('hex');
      // 2. Create the expected hash using userId + hashedApiKey (same order & update calls)
      const expectedHash = crypto.createHash('sha256')
        .update(tokenUserId)
        .update(hashedApiKey)
        .digest('hex');

      if (tokenHash === expectedHash) {
        return tokenUserId;
      }
    } else {
      throw new Error("Invalid frontend token format");
    }

    return null;
  } catch (error) {
    console.error("Frontend token verification failed:", error);
    return null;
  }
}

function validateCloudApiUrlChecksum(checksum: string, cloudApiUrl: string, apiKey: string): boolean {
  const hashedApiKey = crypto.createHash('sha256').update(apiKey).digest('hex');
  const expectedChecksum = crypto.createHash('sha256').update(cloudApiUrl)
    .update(hashedApiKey)
    .digest('hex');

  return expectedChecksum === checksum;
}
/**
 * Express middleware for automatically handling the token exchange.
 * Assumes API key and Cloud URL are available (e.g., via environment variables).
 * Adds `req.authUserId` if successful.
 *
 * @param options Configuration options.
 * @param options.cloudApiUrl The base URL of the MentraOS Cloud API.
 * @param options.apiKey Your App's secret API key.
 * @param options.tokenQueryParam The name of the query parameter containing the token (default: 'aos_temp_token').
 * @param options.cookieName The name of the cookie to store the session token (default: 'aos_session').
 * @param options.cookieSecret Secret key used to sign the session cookie. MUST be provided and kept secure.
 * @param options.cookieOptions Options for the session cookie (default: { httpOnly: true, secure: process.env.NODE_ENV === 'production' }).
 */
export function createAuthMiddleware(options: {
  apiKey: string;
  packageName: string;
  cookieName?: string;
  cookieSecret: string;
  cookieOptions?: {
    httpOnly?: boolean;
    secure?: boolean;
    maxAge?: number;
    sameSite?: boolean | 'lax' | 'strict' | 'none';
    path?: string;
  };
}) {
  const {
    apiKey,
    packageName,
    cookieName = 'aos_session',
    cookieSecret,
    cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days by default
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/'
    }
  } = options;

  if (!apiKey) {
    throw new Error("API Key are required for the auth middleware.");
  }

  if (!cookieSecret || typeof cookieSecret !== 'string' || cookieSecret.length < 8) {
    throw new Error("A strong cookieSecret (at least 8 characters) is required for secure session management.");
  }

  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    // First check for temporary token in the query string
    const tempToken = req.query['aos_temp_token'] as string;
    const frontendToken = req.headers.authorization?.replace('Bearer ', '') as string || req.query['aos_frontend_token'] as string;
    const signedUserToken = req.query['aos_signed_user_token'] as string;

    // first check for signed user token
    if (signedUserToken) {
      const userId = await verifySignedUserToken(signedUserToken);
      if (userId) {
        // Set the user ID on the request
        req.authUserId = userId;

        // Create a signed session token and store it in a cookie
        const signedSession = signSession(userId, cookieSecret);
        res.cookie(cookieName, signedSession, cookieOptions);

        console.log('[auth.middleware] User ID verified from signed user token: ', userId);
        return next();
      } else {
        console.log('[auth.middleware] Signed user token invalid');
      }
    }
    // If temporary token exists, authenticate with it
    if (tempToken) {
      try {
        let cloudApiUrl = `https://prod.augmentos.cloud`;
        const cloudApiUrlFromQuery = req.query['cloudApiUrl'] as string;
        if (cloudApiUrlFromQuery) {
          const cloudApiUrlChecksum = req.query['cloudApiUrlChecksum'] as string;

          if (validateCloudApiUrlChecksum(cloudApiUrlChecksum, cloudApiUrlFromQuery, apiKey)) {
            console.log(`Cloud API is being routed to alternate url at request of the server: ${cloudApiUrlFromQuery}`);
            cloudApiUrl = cloudApiUrlFromQuery;
          } else {
            console.error(`Server requested alternate cloud url of ${cloudApiUrlFromQuery} but the checksum is invalid (checksum: ${cloudApiUrlChecksum}).  Using default cloud url of ${cloudApiUrl} instead.`);
          }
        }

        const { userId } = await exchangeToken(cloudApiUrl, tempToken, apiKey, packageName);

        // Set the user ID on the request
        req.authUserId = userId;

        // Create a signed session token and store it in a cookie
        const signedSession = signSession(userId, cookieSecret);
        res.cookie(cookieName, signedSession, cookieOptions);

        console.log('[auth.middleware] User ID verified from temporary token: ', userId);

        return next();
      } catch (error) {
        console.error("Webview token exchange failed:", error);
        // Temporary token is invalid
      }
    }

    if (frontendToken) {
      // Check for user ID in headers if not embedded in token
      const userId = verifyFrontendToken(frontendToken, apiKey);

      if (userId) {
        req.authUserId = userId;
        // Create a signed session token and store it in a cookie
        const signedSession = signSession(userId, cookieSecret);
        res.cookie(cookieName, signedSession, cookieOptions);
        console.log('[auth.middleware] User ID verified from frontend user token: ', userId);
        return next();
      } else {
        console.log('[auth.middleware] Frontend token invalid');
      }
    }

    // No valid temporary token, check for existing session cookie
    const sessionCookie = req.cookies?.[cookieName];

    if (sessionCookie) {
      try {
        // Verify the signed session cookie and extract the user ID
        const userId = verifySession(sessionCookie, cookieSecret, cookieOptions.maxAge);
        console.log(`User ID verified from session cookie: ${userId}`);
        if (userId) {
          req.authUserId = userId;
          return next();
        }

        // Invalid or expired session, clear the cookie
        res.clearCookie(cookieName, { path: cookieOptions.path });
      } catch (error) {
        console.error("Invalid session cookie:", error);
        // Clear the invalid cookie
        res.clearCookie(cookieName, { path: cookieOptions.path });
      }
    }

    // No valid authentication method found, proceed without setting req.authUserId
    next();
  };
}