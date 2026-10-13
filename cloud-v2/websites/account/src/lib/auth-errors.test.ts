import { describe, expect, test } from "bun:test";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { isAuthSessionError } from "./auth-errors";

describe("isAuthSessionError", () => {
  test("recognizes a stored session Supabase no longer accepts, and nothing else", () => {
    expect(isAuthSessionError(new AuthSessionMissingError())).toBe(true);
    expect(isAuthSessionError(new AuthApiError("expired", 401, undefined))).toBe(true);
    expect(isAuthSessionError(new AuthApiError("forbidden", 403, undefined))).toBe(true);
    for (const code of ["session_not_found", "bad_jwt", "refresh_token_not_found", "user_not_found"]) {
      expect(isAuthSessionError(new AuthApiError("dead", 400, code))).toBe(true);
    }

    expect(isAuthSessionError(new AuthApiError("expired request", 400, "validation_failed"))).toBe(false);
    expect(isAuthSessionError(new AuthApiError("missing", 404, undefined))).toBe(false);
    expect(isAuthSessionError(new AuthRetryableFetchError("offline", 0))).toBe(false);
    expect(isAuthSessionError(new Error("session_not_found"))).toBe(false);
    expect(isAuthSessionError(null)).toBe(false);
  });
});
