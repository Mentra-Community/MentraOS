// react-sdk/src/lib/authCore.ts
import { KEYUTIL, KJUR, RSAKey } from 'jsrsasign'; // Assuming jsrsasign is available

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

const USER_ID_KEY = 'mentraos_userId';
const FRONTEND_TOKEN_KEY = 'mentraos_frontendToken';

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
      alg: ['RS256'], // Specify expected algorithms
      iss: ['https://prod.augmentos.cloud'], // Specify expected issuer
      // jsrsasign's verifyJWT checks 'nbf' and 'exp' by default.
      // Grace period for clock skew
      gracePeriod: 120, // 2 minutes in seconds
    });

    if (!isValid) {
      // Parse the token to get header and payload for debugging
      const parsedJWT = KJUR.jws.JWS.parse(signedUserToken);
      if (parsedJWT) {
        console.warn('Token validation failed. Header:', parsedJWT.headerObj, 'Payload:', parsedJWT.payloadObj);

        // Check expiration manually for more detailed logging if needed
        const payload = parsedJWT.payloadObj as ParsedJWTPayload;
        if (payload && payload.exp) {
          const now = KJUR.jws.IntDate.get('now');
          if (payload.exp < now - 120) { // Check with grace period
            console.warn(`Token expired at ${new Date(payload.exp * 1000).toISOString()}`);
          }
        }
      }
      return null;
    }

    const parsedJWT = KJUR.jws.JWS.parse(signedUserToken);
    if (!parsedJWT || !parsedJWT.payloadObj) {
      console.error('Failed to parse JWT payload.');
      return null;
    }
    const payload = parsedJWT.payloadObj as SignedUserTokenPayload;

    if (!payload.sub || !payload.frontendToken) {
      console.error('Parsed payload missing sub (userId) or frontendToken.');
      return null;
    }
    return payload;

  } catch (e) {
    console.error('[verifyAndParseToken] Error verifying token:', e);
    return null;
  }
}

/**
 * Initializes authentication by checking for tokens in URL parameters or localStorage
 * @returns Promise that resolves to the current authentication state
 */
export async function initializeAuth(): Promise<AuthState> {
  const params = new URLSearchParams(window.location.search);
  const tokenFromUrl = params.get('aos_signed_user_token');

  if (tokenFromUrl) {
    const payload = await verifyAndParseToken(tokenFromUrl);
    if (payload) {
      localStorage.setItem(USER_ID_KEY, payload.sub);
      localStorage.setItem(FRONTEND_TOKEN_KEY, payload.frontendToken);
      // Remove the token from URL to prevent it from being bookmarked or shared.
      params.delete('aos_signed_user_token');
      window.history.replaceState({}, document.title, `${window.location.pathname}?${params.toString()}`);
      return { userId: payload.sub, frontendToken: payload.frontendToken };
    } else {
      // Token from URL was invalid, clear any stored ones
      clearStoredAuth();
      return { userId: null, frontendToken: null };
    }
  }

  // If no token in URL, try to load from localStorage
  const storedUserId = localStorage.getItem(USER_ID_KEY);
  const storedFrontendToken = localStorage.getItem(FRONTEND_TOKEN_KEY);

  if (storedUserId && storedFrontendToken) {
    // For SPAs, if the token was already verified and its parts stored,
    // we might trust these for the current session.
    // A full re-verification of a stored *signedUserToken* would be more secure
    // but adds complexity if the signed token isn't always re-provided.
    // The current approach: verify once from URL, then use stored parts.
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