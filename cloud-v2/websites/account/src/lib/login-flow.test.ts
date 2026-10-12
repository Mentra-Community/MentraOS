import { describe, expect, mock, test } from "bun:test";
import { AuthApiError } from "@supabase/supabase-js";
import { CONTINUATION, createFakeAuth, createFakeInteractions, SIGNED_IN } from "../test-support/fake-auth";
import { continueAfterSignIn, initialLoginState, startLogin } from "./login-flow";
import { MESSAGES } from "./messages";

const SEARCH = "?interaction=uid-1234567890";

function deps(options: Parameters<typeof createFakeInteractions>[0] = {}, session: typeof SIGNED_IN | null = null) {
  return { auth: createFakeAuth({ session }), api: createFakeInteractions(options), navigate: mock((_url: string) => undefined) };
}

describe("the login route", () => {
  test("reads only `interaction` from the query; anything else is ignored", async () => {
    expect(initialLoginState("")).toEqual({ kind: "invalid" });
    expect(initialLoginState("?interaction=<script>")).toEqual({ kind: "invalid" });
    expect(initialLoginState("?interaction=a&interaction=b")).toEqual({ kind: "invalid" });
    const d = deps();
    const state = await startLogin(d, `${SEARCH}&redirect_url=https://evil.example&return_to=//evil.example`);
    expect(state).toEqual({ kind: "sign-in", interactionId: "uid-1234567890", clientName: "Mentra admin portal", error: null });
    expect(d.navigate).not.toHaveBeenCalled();
  });

  test("signed out: shows sign-in for the site the person came from", async () => {
    const d = deps();
    expect(await startLogin(d, SEARCH)).toMatchObject({ kind: "sign-in", clientName: "Mentra admin portal" });
    expect(d.api.handOff).not.toHaveBeenCalled();
  });

  test("a Supabase session on the page (back from Google or Apple) is handed off at once, then forgotten (L13)", async () => {
    const d = deps({}, SIGNED_IN);
    expect(await startLogin(d, SEARCH)).toEqual({ kind: "redirecting" });
    expect(d.api.handOff.mock.calls).toEqual([["uid-1234567890", SIGNED_IN.access_token]]);
    expect(d.navigate.mock.calls).toEqual([[CONTINUATION]]);
    expect(d.auth.signOut.mock.calls).toEqual([[{ scope: "local" }]]);
    expect(d.auth.current()).toBeNull();
  });

  test("after a password sign-in the new session is handed off", async () => {
    const d = deps();
    await d.auth.signInWithPassword({ email: "a@example.com", password: "pw" });
    expect(await continueAfterSignIn(d, "uid-1234567890", "Mentra admin portal")).toEqual({ kind: "redirecting" });
    expect(d.navigate.mock.calls).toEqual([[CONTINUATION]]);
    expect(d.auth.current()).toBeNull();
  });

  test("a refused hand-off forgets the session and asks again with a fixed message", async () => {
    const d = deps({ handOff: { kind: "refused" } }, SIGNED_IN);
    expect(await startLogin(d, SEARCH)).toMatchObject({ kind: "sign-in", error: MESSAGES.signInRefused });
    expect(d.navigate).not.toHaveBeenCalled();
    expect(d.auth.current()).toBeNull();
  });

  test("a dead stored session is forgotten and sign-in is shown, never an error", async () => {
    const d = deps({}, SIGNED_IN);
    d.auth.getSession.mockImplementationOnce(async () => ({
      data: { session: null },
      error: new AuthApiError("session_not_found", 403, "session_not_found"),
    }));
    expect(await startLogin(d, SEARCH)).toMatchObject({ kind: "sign-in", error: null });
    expect(d.auth.signOut).toHaveBeenCalled();
  });

  test("an expired interaction, a rate limit and an outage show fixed states", async () => {
    expect(await startLogin(deps({ details: { kind: "expired" } }), SEARCH)).toEqual({ kind: "expired" });
    expect(await startLogin(deps({ details: { kind: "error" } }), SEARCH)).toEqual({ kind: "error" });
    expect(await startLogin(deps({ handOff: { kind: "rate-limited" } }, SIGNED_IN), SEARCH)).toMatchObject({
      kind: "sign-in",
      error: MESSAGES.rateLimited,
    });
    expect(await startLogin(deps({ handOff: { kind: "expired" } }, SIGNED_IN), SEARCH)).toEqual({ kind: "expired" });
  });

  test("an interaction waiting for consent goes to the consent route", async () => {
    const d = deps({ details: { kind: "ok", prompt: "consent", clientName: "Notes", scopes: ["openid"] } });
    expect(await startLogin(d, SEARCH)).toEqual({ kind: "redirecting" });
    expect(d.navigate.mock.calls).toEqual([["/consent?interaction=uid-1234567890"]]);
  });
});
