// react-sdk/src/lib/authCore.ts
import { KEYUTIL, KJUR, RSAKey } from "jsrsasign"; // Assuming jsrsasign is available

// This should be the MentraOS Cloud's public key for verifying aos_signed_user_token
const userTokenPublicKeyPEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Yt2RtNOdeKQxWMY0c84
ADpY1Jy58YWZhaEgP2A5tBwFUKgy/TH9gQLWZjQ3dQ/6XXO8qq0kluoYFqM7ZDRF
zJ0E4Yi0WQncioLRcCx4q8pDmqY9vPKgv6PruJdFWca0l0s3gZ3BqSeWum/C23xK
FPHPwi8gvRdc6ALrkcHeciM+7NykU8c0EY8PSitNL+Tchti95kGu+j6APr5vNewi
zRpQGOdqaLWe+ahHmtj6KtUZjm8o6lan4f/o08C6litizguZXuw2Nn/Kd9fFI1xF
IVNJYMy9jgGaOi71+LpGw+vIpwAawp/7IvULDppvY3DdX5nt05P1+jvVJXPxMKzD
TQIDAQAB
-----END PUBLIC KEY-----`;

const USER_ID_KEY = "mentraos_userId";
const FRONTEND_TOKEN_KEY = "mentraos_frontendToken";

interface SignedUserTokenPayload {
  sub: string; // This is the userId
  frontendToken: string; // This is the token for App backend
  iss?: string;
  exp?: number;
  iat?: number;
  // other claims...
}

/**
 * Interface for parsed JWT payload with required fields for expiration checking
 */
interface ParsedJWTPayload {
  exp?: number;
  [key: string]: any;
}

export interface AuthState {
  userId: string | null;
  frontendToken: string | null; // This is the JWT to be sent to the App backend
}

/**
 * Verifies and parses a signed user token using the MentraOS Cloud public key
 * @param signedUserToken - The JWT token to verify and parse
 * @returns Promise that resolves to the parsed payload or null if invalid
 */
async function verifyAndParseToken(signedUserToken: string): Promise<SignedUserTokenPayload | null> {
  try {
    const publicKeyObj = KEYUTIL.getKey(userTokenPublicKeyPEM) as RSAKey;

    // verifyJWT will check signature, nbf, exp.
    // It will also check 'iss' if provided in the options.
    const isValid = KJUR.jws.JWS.verifyJWT(signedUserToken, publicKeyObj, {
      alg: ["RS256"], // Specify expected algorithms
      iss: ["https://prod.augmentos.cloud"], // Specify expected issuer
      // jsrsasign's verifyJWT checks 'nbf' and 'exp' by default.
      // Grace period for clock skew
      gracePeriod: 120, // 2 minutes in seconds
    });

    if (!isValid) {
      // Parse the token to get header and payload for debugging
      const parsedJWT = KJUR.jws.JWS.parse(signedUserToken);
      if (parsedJWT) {
        console.warn("Token validation failed. Header:", parsedJWT.headerObj, "Payload:", parsedJWT.payloadObj);

        // Check expiration manually for more detailed logging if needed
        const payload = parsedJWT.payloadObj as ParsedJWTPayload;
        if (payload && payload.exp) {
          const now = KJUR.jws.IntDate.get("now");
          if (payload.exp < now - 120) {
            // Check with grace period
            console.warn(`Token expired at ${new Date(payload.exp * 1000).toISOString()}`);
          }
        }
      }
      return null;
    }

    const parsedJWT = KJUR.jws.JWS.parse(signedUserToken);
    if (!parsedJWT || !parsedJWT.payloadObj) {
      console.error("Failed to parse JWT payload.");
      return null;
    }
    const payload = parsedJWT.payloadObj as SignedUserTokenPayload;

    if (!payload.sub || !payload.frontendToken) {
      console.error("Parsed payload missing sub (userId) or frontendToken.");
      return null;
    }
    return payload;
  } catch (e) {
    console.error("[verifyAndParseToken] Error verifying token:", e);
    return null;
  }
}

/**
 * Exchanges a temp token with the backend to get session cookie
 * @param tempToken - The aos_temp_token from URL
 * @param signedUserToken - Optional aos_signed_user_token (JWT) for fallback auth
 * @returns Promise that resolves to auth state or null on failure
 */
async function exchangeTempToken(tempToken: string, signedUserToken?: string): Promise<AuthState | null> {
  try {
    // Build the exchange URL with all necessary params from the current URL
    const params = new URLSearchParams(window.location.search);
    const cloudApiUrl = params.get("cloudApiUrl");
    const cloudApiUrlChecksum = params.get("cloudApiUrlChecksum");

    const exchangeParams = new URLSearchParams({ aos_temp_token: tempToken });
    // IMPORTANT: Also send the signed user token so backend can set cookie from JWT
    if (signedUserToken) exchangeParams.set("aos_signed_user_token", signedUserToken);
    if (cloudApiUrl) exchangeParams.set("cloudApiUrl", cloudApiUrl);
    if (cloudApiUrlChecksum) exchangeParams.set("cloudApiUrlChecksum", cloudApiUrlChecksum);

    console.log("[exchangeTempToken] Calling /api/mentra/auth/init with params:", Array.from(exchangeParams.keys()));

    const response = await fetch(`/api/mentra/auth/init?${exchangeParams.toString()}`, {
      method: "GET",
      credentials: "include", // Include cookies to receive Set-Cookie
    });

    if (!response.ok) {
      console.error("[exchangeTempToken] Backend returned error:", response.status);
      return null;
    }

    const data = await response.json();
    console.log("[exchangeTempToken] Response:", { success: data.success, userId: data.userId });
    if (data.success && data.userId && data.frontendToken) {
      return { userId: data.userId, frontendToken: data.frontendToken };
    }

    console.error("[exchangeTempToken] Invalid response:", data);
    return null;
  } catch (error) {
    console.error("[exchangeTempToken] Network error:", error);
    return null;
  }
}

/**
 * Initializes authentication by checking for tokens in URL parameters or localStorage
 * Priority:
 * 1. aos_signed_user_token in URL -> verify client-side (JWT)
 * 2. aos_temp_token in URL -> exchange via backend
 * 3. localStorage fallback
 * @returns Promise that resolves to the current authentication state
 */
export async function initializeAuth(): Promise<AuthState> {
  console.log("[initializeAuth] 🔍 Starting auth initialization...");
  const params = new URLSearchParams(window.location.search);

  console.log("[initializeAuth] 📋 URL params:", {
    hasSignedUserToken: params.has("aos_signed_user_token"),
    hasTempToken: params.has("aos_temp_token"),
    allParams: Array.from(params.keys()),
  });

  // Priority 1: Check for signed user token (JWT) in URL
  const signedUserToken = params.get("aos_signed_user_token");
  if (signedUserToken) {
    console.log("[initializeAuth] ✅ Found aos_signed_user_token, verifying...");
    const payload = await verifyAndParseToken(signedUserToken); // Renamed from userId to payload for clarity
    if (payload) {
      console.log("[initializeAuth] ✅ JWT verified successfully for user:", payload.sub);

      // If we also have a temp token, exchange it for session cookie
      // Also pass the signedUserToken so backend can use it if temp token fails
      const tempToken = params.get("aos_temp_token");
      if (tempToken) {
        console.log("[initializeAuth] 🔄 Also found aos_temp_token, exchanging for session...");
        await exchangeTempToken(tempToken, signedUserToken); // Pass JWT for fallback
      }

      // Extract frontendToken from JWT payload
      // The payload is already parsed by verifyAndParseToken, so we can use it directly
      const frontendToken = payload.frontendToken;
      const userId = payload.sub; // Get userId from payload

      if (frontendToken && userId) {
        console.log("[initializeAuth] 💾 Storing tokens and cleaning URL...");
        localStorage.setItem(USER_ID_KEY, userId);
        localStorage.setItem(FRONTEND_TOKEN_KEY, frontendToken);

        // Clean URL
        params.delete("aos_signed_user_token");
        params.delete("aos_temp_token"); // Also delete temp token if it was present and handled
        params.delete("cloudApiUrl"); // Also delete cloudApiUrl if it was present
        params.delete("cloudApiUrlChecksum"); // Also delete cloudApiUrlChecksum if it was present
        const newSearch = params.toString();
        const newUrl = newSearch ? `${window.location.pathname}?${newSearch}` : window.location.pathname;
        window.history.replaceState({}, "", newUrl);

        console.log("[initializeAuth] ✅ Auth complete via signed user token");
        return { userId, frontendToken };
      }
    }
    console.warn("[initializeAuth] ⚠️ JWT verification failed");
    // If verification failed, clear any stored auth and return null state
    clearStoredAuth();
    return { userId: null, frontendToken: null };
  }

  // Priority 2: Check for temp token (needs backend exchange)
  const tempToken = params.get("aos_temp_token");
  if (tempToken) {
    console.log("[initializeAuth] 🔄 Found aos_temp_token, exchanging with backend...");
    const auth = await exchangeTempToken(tempToken);
    if (auth) {
      console.log("[initializeAuth] ✅ Temp token exchange successful for user:", auth.userId);
      localStorage.setItem(USER_ID_KEY, auth.userId!);
      localStorage.setItem(FRONTEND_TOKEN_KEY, auth.frontendToken!);

      // Clean URL
      params.delete("aos_temp_token");
      params.delete("cloudApiUrl"); // Also delete cloudApiUrl if it was present
      params.delete("cloudApiUrlChecksum"); // Also delete cloudApiUrlChecksum if it was present
      const newSearch = params.toString();
      const newUrl = newSearch ? `${window.location.pathname}?${newSearch}` : window.location.pathname;
      window.history.replaceState({}, "", newUrl);

      console.log("[initializeAuth] ✅ Auth complete via temp token");
      return auth;
    }
    console.warn("[initializeAuth] ⚠️ Temp token exchange failed");
    // If exchange failed, clear any stored auth and return null state
    clearStoredAuth();
    return { userId: null, frontendToken: null };
  }

  // Priority 3: Try to load from localStorage
  console.log("[initializeAuth] 📦 Checking localStorage...");
  const storedUserId = localStorage.getItem(USER_ID_KEY);
  const storedFrontendToken = localStorage.getItem(FRONTEND_TOKEN_KEY);

  if (storedUserId && storedFrontendToken) {
    return { userId: storedUserId, frontendToken: storedFrontendToken };
  }

  return { userId: null, frontendToken: null };
}

export function getStoredAuth(): AuthState {
  const userId = localStorage.getItem(USER_ID_KEY);
  const frontendToken = localStorage.getItem(FRONTEND_TOKEN_KEY);
  return { userId, frontendToken };
}

export function clearStoredAuth(): void {
  localStorage.removeItem(USER_ID_KEY);
  localStorage.removeItem(FRONTEND_TOKEN_KEY);
}
