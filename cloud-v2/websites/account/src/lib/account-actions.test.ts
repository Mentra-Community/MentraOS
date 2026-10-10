import { describe, expect, test } from "bun:test";
import { AuthApiError } from "@supabase/supabase-js";
import { createFakeAuth, SIGNED_IN } from "../test-support/fake-auth";
import { requestPasswordReset, signUpWithEmail, updatePassword } from "./account-actions";

const ORIGIN = "https://account.example";

describe("sign-up and password reset", () => {
  test("sign-up returns to the authorization request when there is one, and treats existing accounts like new ones", async () => {
    const auth = createFakeAuth({ session: null });
    const input = { email: "person@example.com", password: "correct horse", origin: ORIGIN };

    expect(await signUpWithEmail(auth, { ...input, authorizationId: "auth-123" })).toEqual({ kind: "check-email" });
    expect(await signUpWithEmail(auth, { ...input, authorizationId: null })).toEqual({ kind: "check-email" });
    expect(auth.signUp.mock.calls.map(([credentials]) => credentials.options.emailRedirectTo)).toEqual([
      `${ORIGIN}/oauth/authorize?authorization_id=auth-123`,
      `${ORIGIN}/`,
    ]);

    auth.signUp.mockImplementationOnce(async () => ({
      data: { session: null },
      error: new AuthApiError("User already registered", 422, "user_already_exists"),
    }));
    expect(await signUpWithEmail(auth, { ...input, authorizationId: null })).toEqual({ kind: "check-email" });

    auth.signUp.mockImplementationOnce(async () => ({ data: { session: SIGNED_IN }, error: null }));
    expect(await signUpWithEmail(auth, { ...input, authorizationId: null })).toEqual({ kind: "signed-in" });
  });

  test("reset requests send people back to /reset and report the same result for any address", async () => {
    const auth = createFakeAuth({ session: null });

    expect(await requestPasswordReset(auth, { email: "nobody@example.com", origin: ORIGIN, authorizationId: null })).toEqual({
      ok: true,
    });
    expect(await requestPasswordReset(auth, { email: "a@example.com", origin: ORIGIN, authorizationId: "auth-123" })).toEqual({
      ok: true,
    });
    expect(auth.resetPasswordForEmail.mock.calls).toEqual([
      ["nobody@example.com", { redirectTo: `${ORIGIN}/reset` }],
      ["a@example.com", { redirectTo: `${ORIGIN}/reset?authorization_id=auth-123` }],
    ]);

    auth.updateUser.mockImplementationOnce(async () => ({ error: new AuthApiError("Auth session missing!", 401, undefined) }));
    expect(await updatePassword(auth, "new password")).toMatchObject({ ok: false, expired: true });
    expect(await updatePassword(auth, "new password")).toEqual({ ok: true });
  });
});
