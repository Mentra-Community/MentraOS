import { isAuthApiError, isAuthError, isAuthSessionMissingError } from "@supabase/supabase-js";

/** Codes Supabase Auth returns when the stored session is no longer accepted. */
const SESSION_ERROR_CODES: ReadonlySet<string> = new Set([
  "session_not_found",
  "session_expired",
  "bad_jwt",
  "no_authorization",
  "refresh_token_not_found",
  "refresh_token_already_used",
  "user_not_found",
]);

/**
 * True when the error means this page's stored session is dead, for example
 * because the account's sessions were revoked elsewhere. Callers sign out
 * locally and show sign-in again instead of an error.
 */
export function isAuthSessionError(error: unknown): boolean {
  if (isAuthSessionMissingError(error)) return true;
  if (!isAuthError(error)) return false;
  if (typeof error.code === "string" && SESSION_ERROR_CODES.has(error.code)) return true;
  return isAuthApiError(error) && (error.status === 401 || error.status === 403);
}

export function authErrorCode(error: unknown): string | undefined {
  return isAuthError(error) && typeof error.code === "string" ? error.code : undefined;
}

export function isRateLimited(error: unknown): boolean {
  if (!isAuthError(error)) return false;
  return error.status === 429 || (authErrorCode(error) ?? "").startsWith("over_");
}
