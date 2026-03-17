// src/app/webview/index.ts
import * as crypto from "crypto";

import axios from "axios";
import { Hono } from "hono";
import type { Context, Next, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { KEYUTIL, KJUR, RSAKey } from "jsrsasign";

import { AuthVariables, AuthenticatedRequest } from "../../types";
import { AppSession } from "../session";

const userTokenPublicKey =
  process.env.MENTRAOS_CLOUD_USER_TOKEN_PUBLIC_KEY ||
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Yt2RtNOdeKQxWMY0c84\nADpY1Jy58YWZhaEgP2A5tBwFUKgy/TH9gQLWZjQ3dQ/6XXO8qq0kluoYFqM7ZDRF\nzJ0E4Yi0WQncioLRcCx4q8pDmqY9vPKgv6PruJdFWca0l0s3gZ3BqSeWum/C23xK\nFPHPwi8gvRdc6ALrkcHeciM+7NykU8c0EY8PSitNL+Tchti95kGu+j6APr5vNewi\nzRpQGOdqaLWe+ahHmtj6KtUZjm8o6lan4f/o08C6litizguZXuw2Nn/Kd9fFI1xF\nIVNJYMy9jgGaOi71+LpGw+vIpwAawp/7IvULDppvY3DdX5nt05P1+jvVJXPxMKzD\nTQIDAQAB\n-----END PUBLIC KEY-----";

/**
 * Extracts the temporary token from a URL string.
 * @param url The URL string, typically window.location.href.
 * @returns The token string or null if not found.
 */
export function extractTempToken(url: string): string | null {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.searchParams.get("aos_temp_token");
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
  packageName: string,
): Promise<{ userId: string }> {
  const endpoint = `${cloudApiUrl}/api/auth/exchange-user-token`;
  console.log(`Exchanging token for user at ${endpoint}`);
  try {
    const response = await axios.post(
      endpoint,
      { aos_temp_token: tempToken, packageName: packageName },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        timeout: 10000, // 10 second timeout
      },
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
      const message = data?.error || error.message || "Unknown error during token exchange";
      console.error(`Token exchange failed with status ${status}: ${message}`);
      throw new Error(`Token exchange failed: ${message}`);
    } else {
      console.error("Unexpected error during token exchange:", error);
      throw new Error("An unexpected error occurred during token exchange.");
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
  const signature = crypto.createHmac("sha256", secret).update(data).digest("hex");

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
    const parts = token.split("|");
    if (parts.length !== 3) return null;

    const [userId, timestampStr, signature] = parts;
    const timestamp = parseInt(timestampStr, 10);

    // Check if token has expired
    if (maxAge && Date.now() - timestamp > maxAge) {
      console.log(
        `Session token expired: ${token}.  Parsed date is ${timestamp}, meaning age is ${Date.now() - timestamp}, but maxAge is ${maxAge}`,
      );
      return null;
    }

    // Verify signature
    const data = `${userId}|${timestamp}`;
    const expectedSignature = crypto.createHmac("sha256", secret).update(data).digest("hex");

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
    const tokenParts = frontendToken.split(":");

    if (tokenParts.length === 2) {
      // Format: userId:hash
      const [tokenUserId, tokenHash] = tokenParts;

      // Align the hashing algorithm with server-side `hashWithApiKey`
      // 1. Hash the API key first (server only stores the hashed version)
      const hashedApiKey = crypto.createHash("sha256").update(apiKey).digest("hex");
      // 2. Create the expected hash using userId + hashedApiKey (same order & update calls)
      const expectedHash = crypto.createHash("sha256").update(tokenUserId).update(hashedApiKey).digest("hex");

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
  const hashedApiKey = crypto.createHash("sha256").update(apiKey).digest("hex");
  const expectedChecksum = crypto.createHash("sha256").update(cloudApiUrl).update(hashedApiKey).digest("hex");

  return expectedChecksum === checksum;
}
/**
 * Hono middleware for automatically handling the token exchange.
 * Assumes API key and Cloud URL are available (e.g., via environment variables).
 * Sets context variables `authUserId` and `activeSession` if successful.
 *
 * @param options Configuration options.
 * @param options.apiKey Your App's secret API key.
 * @param options.packageName Your App's package name.
 * @param options.cookieName The name of the cookie to store the session token (default: 'aos_session').
 * @param options.cookieSecret Secret key used to sign the session cookie. MUST be provided and kept secure.
 * @param options.cookieOptions Options for the session cookie.
 */
export function createAuthMiddleware(options: {
  apiKey: string;
  packageName: string;
  cookieName?: string;
  cookieSecret: string;
  getAppSessionForUser?: (userId: string) => AppSession | null;
  cookieOptions?: {
    httpOnly?: boolean;
    secure?: boolean;
    maxAge?: number;
    sameSite?: "Lax" | "Strict" | "None";
    path?: string;
  };
}): MiddlewareHandler<{ Variables: AuthVariables }> {
  const {
    apiKey,
    packageName,
    // Default to packageName-session to match createMentraAuthRoutes.
    // "aos_session" was the old default — we fall back to it below for
    // backwards compatibility with 2.x apps that may have existing cookies.
    cookieName = `${packageName}-session`,
    cookieSecret,
    getAppSessionForUser,
    cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60, // 30 days in seconds for Hono
      sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
      path: "/",
    },
  } = options;

  // Legacy cookie name used by 2.x Express SDK and early Hono SDK versions.
  // We check this as a fallback and silently migrate the user to the new name.
  const legacyCookieName = "aos_session";

  if (!apiKey) {
    throw new Error("API Key is required for the auth middleware.");
  }

  if (!cookieSecret || typeof cookieSecret !== "string" || cookieSecret.length < 8) {
    throw new Error("A strong cookieSecret (at least 8 characters) is required for secure session management.");
  }

  return async (c: Context<{ Variables: AuthVariables }>, next: Next) => {
    // Helper to set auth and continue
    const setAuthAndContinue = async (userId: string) => {
      c.set("authUserId", userId);
      if (getAppSessionForUser) {
        const appSession = getAppSessionForUser(userId);
        c.set("activeSession", appSession);
      } else {
        c.set("activeSession", null);
      }

      // Create and set session cookie
      const signedSession = signSession(userId, cookieSecret);
      setCookie(c, cookieName, signedSession, cookieOptions as CookieOptions);
      await next();
    };

    // Get query params and headers
    const tempToken = c.req.query("aos_temp_token");
    const signedUserToken = c.req.query("aos_signed_user_token");
    const authHeader = c.req.header("authorization");
    const frontendToken = authHeader?.replace("Bearer ", "") || c.req.query("aos_frontend_token");

    // First check for signed user token
    if (signedUserToken) {
      const userId = await verifySignedUserToken(signedUserToken);
      if (userId) {
        console.log("[auth.middleware] User ID verified from signed user token:", userId);
        return setAuthAndContinue(userId);
      } else {
        console.log("[auth.middleware] Signed user token invalid");
      }
    }

    // If temporary token exists, authenticate with it
    if (tempToken) {
      try {
        let cloudApiUrl = `https://api.mentra.glass`;
        const cloudApiUrlFromQuery = c.req.query("cloudApiUrl");
        if (cloudApiUrlFromQuery) {
          const cloudApiUrlChecksum = c.req.query("cloudApiUrlChecksum");

          if (cloudApiUrlChecksum && validateCloudApiUrlChecksum(cloudApiUrlChecksum, cloudApiUrlFromQuery, apiKey)) {
            console.log(`Cloud API is being routed to alternate url at request of the server: ${cloudApiUrlFromQuery}`);
            cloudApiUrl = cloudApiUrlFromQuery;
          } else {
            console.error(
              `Server requested alternate cloud url of ${cloudApiUrlFromQuery} but the checksum is invalid. Using default cloud url.`,
            );
          }
        }

        const { userId } = await exchangeToken(cloudApiUrl, tempToken, apiKey, packageName);

        console.log("[auth.middleware] User ID verified from temporary token:", userId);
        return setAuthAndContinue(userId);
      } catch (error) {
        console.error("Webview token exchange failed:", error);
        // Continue to check other auth methods
      }
    }

    // Check frontend token
    if (frontendToken) {
      const userId = verifyFrontendToken(frontendToken, apiKey);

      if (userId) {
        console.log("[auth.middleware] User ID verified from frontend user token:", userId);
        return setAuthAndContinue(userId);
      } else {
        console.log("[auth.middleware] Frontend token invalid");
      }
    }

    // No valid temporary token, check for existing session cookie.
    // Check the current cookie name first, then fall back to the legacy
    // "aos_session" name used by 2.x apps and early Hono SDK versions.
    const sessionCookie =
      getCookie(c, cookieName) ?? (cookieName !== legacyCookieName ? getCookie(c, legacyCookieName) : undefined);

    if (sessionCookie) {
      try {
        // Verify the signed session cookie and extract the user ID
        // Convert maxAge from seconds to milliseconds for verifySession
        const userId = verifySession(
          sessionCookie,
          cookieSecret,
          cookieOptions.maxAge ? cookieOptions.maxAge * 1000 : undefined,
        );
        if (userId) {
          c.set("authUserId", userId);
          if (getAppSessionForUser) {
            const appSession = getAppSessionForUser(userId);
            c.set("activeSession", appSession);
          } else {
            c.set("activeSession", null);
          }
          // If the cookie was found under the legacy name, silently migrate
          // it to the current name so future requests use the new cookie.
          if (!getCookie(c, cookieName)) {
            setCookie(c, cookieName, sessionCookie, cookieOptions as CookieOptions);
            deleteCookie(c, legacyCookieName, { path: cookieOptions.path });
          }
          return next();
        }

        // Invalid or expired session, clear both cookie names
        deleteCookie(c, cookieName, { path: cookieOptions.path });
        deleteCookie(c, legacyCookieName, { path: cookieOptions.path });
      } catch (error) {
        console.error("Invalid session cookie:", error);
        // Clear the invalid cookie under both names
        deleteCookie(c, cookieName, { path: cookieOptions.path });
        deleteCookie(c, legacyCookieName, { path: cookieOptions.path });
      }
    }

    // No valid authentication method found, proceed without setting authUserId
    c.set("activeSession", null);
    await next();
  };
}

/**
 * Generates a frontend token for client-side authentication.
 * The token format is userId:hash where hash = sha256(userId + sha256(apiKey))
 * @param userId The user ID to embed in the token
 * @param apiKey The app's API key
 * @returns A frontend token string
 */
export function generateFrontendToken(userId: string, apiKey: string): string {
  const hashedApiKey = crypto.createHash("sha256").update(apiKey).digest("hex");
  const hash = crypto.createHash("sha256").update(userId).update(hashedApiKey).digest("hex");
  return `${userId}:${hash}`;
}

/**
 * Creates a Hono sub-app with authentication routes for frontend token exchange.
 * Mount this at /api/mentra/auth to enable frontend-initiated authentication.
 *
 * This is required for apps using Bun's fullstack dev server where the HTML
 * is served directly by Bun's routes (bypassing Hono middleware).
 *
 * @example
 * ```typescript
 * import { createMentraAuthRoutes } from "@mentra/sdk";
 *
 * const app = new MyAppServer({...});
 *
 * app.route("/api/mentra/auth", createMentraAuthRoutes({
 *   apiKey: API_KEY,
 *   packageName: PACKAGE_NAME,
 *   cookieSecret: COOKIE_SECRET,
 * }));
 * ```
 */
export function createMentraAuthRoutes(options: {
  apiKey: string;
  packageName: string;
  cookieSecret: string;
  cookieOptions?: {
    httpOnly?: boolean;
    secure?: boolean;
    maxAge?: number;
    sameSite?: "Lax" | "Strict" | "None";
    path?: string;
  };
}): Hono {
  const {
    apiKey,
    packageName,
    cookieSecret,
    cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60, // 30 days in seconds
      sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
      path: "/",
    },
  } = options;

  if (!apiKey) {
    throw new Error("API Key is required for Mentra auth routes.");
  }

  if (!cookieSecret || typeof cookieSecret !== "string" || cookieSecret.length < 8) {
    throw new Error("A strong cookieSecret (at least 8 characters) is required.");
  }

  const authRouter = new Hono();
  const cookieName = `${packageName}-session`; // Must match createAuthMiddleware

  /**
   * GET /init - Exchange aos_temp_token for session
   * Query params:
   *   - aos_temp_token: The temporary token from MentraOS Cloud
   *   - cloudApiUrl: (optional) Custom cloud API URL
   *   - cloudApiUrlChecksum: (optional) Checksum for custom cloud URL
   */
  authRouter.get("/init", async (c) => {
    const tempToken = c.req.query("aos_temp_token");
    const signedUserToken = c.req.query("aos_signed_user_token");

    // First try signed user token (JWT)
    if (signedUserToken) {
      const userId = await verifySignedUserToken(signedUserToken);
      if (userId) {
        const frontendToken = generateFrontendToken(userId, apiKey);
        const signedSession = signSession(userId, cookieSecret);
        setCookie(c, cookieName, signedSession, cookieOptions as CookieOptions);

        console.log("[mentra/auth/init] User authenticated via signed user token:", userId);
        return c.json({ success: true, userId, frontendToken });
      }
      return c.json({ success: false, error: "Invalid signed user token" }, 401);
    }

    // Try temp token exchange
    if (tempToken) {
      try {
        let cloudApiUrl = "https://api.mentra.glass";
        const cloudApiUrlFromQuery = c.req.query("cloudApiUrl");
        if (cloudApiUrlFromQuery) {
          const checksum = c.req.query("cloudApiUrlChecksum");
          if (checksum && validateCloudApiUrlChecksum(checksum, cloudApiUrlFromQuery, apiKey)) {
            cloudApiUrl = cloudApiUrlFromQuery;
          }
        }

        const { userId } = await exchangeToken(cloudApiUrl, tempToken, apiKey, packageName);
        const frontendToken = generateFrontendToken(userId, apiKey);
        const signedSession = signSession(userId, cookieSecret);
        setCookie(c, cookieName, signedSession, cookieOptions as CookieOptions);

        console.log("[mentra/auth/init] User authenticated via temp token:", userId);
        return c.json({ success: true, userId, frontendToken });
      } catch (error) {
        console.error("[mentra/auth/init] Token exchange failed:", error);
        return c.json({ success: false, error: "Token exchange failed" }, 401);
      }
    }

    return c.json({ success: false, error: "No token provided" }, 400);
  });

  return authRouter;
}
