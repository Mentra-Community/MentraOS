import { describe, expect, test } from "bun:test";
import { AuthApiError } from "@supabase/supabase-js";
import { createFakeAuth, SIGNED_IN } from "../test-support/fake-auth";
import { signOutLocally, signUpWithEmail, startSocialSignIn } from "./account-actions";

const ORIGIN = "https://account.example";

describe("account actions", () => {
  test("sign-up returns to the sign-in in progress, or to the root, and treats existing accounts like new ones", async () => {
    const auth = createFakeAuth({ session: null });
    const input = { email: "person@example.com", password: "correct horse", origin: ORIGIN };

    expect(await signUpWithEmail(auth, { ...input, interactionId: "uid-1234567890" })).toEqual({ kind: "check-email" });
    expect(await signUpWithEmail(auth, { ...input, interactionId: null })).toEqual({ kind: "check-email" });
    expect(auth.signUp.mock.calls.map(([credentials]) => credentials.options.emailRedirectTo)).toEqual([
      `${ORIGIN}/login?interaction=uid-1234567890`,
      `${ORIGIN}/`,
    ]);

    auth.signUp.mockImplementationOnce(async () => ({
      data: { session: null },
      error: new AuthApiError("User already registered", 422, "user_already_exists"),
    }));
    expect(await signUpWithEmail(auth, { ...input, interactionId: null })).toEqual({ kind: "check-email" });

    auth.signUp.mockImplementationOnce(async () => ({ data: { session: SIGNED_IN }, error: null }));
    expect(await signUpWithEmail(auth, { ...input, interactionId: null })).toEqual({ kind: "signed-in" });
  });

  test("Google asks for account selection on each sign-in, including a repeated attempt", async () => {
    const auth = createFakeAuth({ session: null });
    await startSocialSignIn(auth, "google", ORIGIN, "uid-1234567890");
    await startSocialSignIn(auth, "google", ORIGIN, "uid-second12345");
    expect(auth.signInWithOAuth.mock.calls.map(([credentials]) => credentials)).toEqual([
      {
        provider: "google",
        options: { redirectTo: `${ORIGIN}/login?interaction=uid-1234567890`, queryParams: { prompt: "select_account" } },
      },
      {
        provider: "google",
        options: { redirectTo: `${ORIGIN}/login?interaction=uid-second12345`, queryParams: { prompt: "select_account" } },
      },
    ]);
  });

  test("Apple returns to the same login without Google-specific options", async () => {
    const auth = createFakeAuth({ session: null });
    await startSocialSignIn(auth, "apple", ORIGIN, "uid-1234567890");
    expect(auth.signInWithOAuth.mock.calls[0]![0]).toEqual({
      provider: "apple",
      options: { redirectTo: `${ORIGIN}/login?interaction=uid-1234567890` },
    });
  });

  test("signing out only ever uses the local scope", async () => {
    const auth = createFakeAuth();
    await signOutLocally(auth);
    expect(auth.signOut.mock.calls).toEqual([[{ scope: "local" }]]);
  });
});
