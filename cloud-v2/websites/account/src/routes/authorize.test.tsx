import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AuthApiError, AuthSessionMissingError } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import { signInWithEmail, startSocialSignIn } from "../lib/account-actions";
import {
  decideAuthorization,
  startAuthorization,
  type AuthorizeDeps,
  type AuthorizeState,
} from "../lib/authorize-flow";
import { parseFirstPartyClientIds } from "../lib/first-party";
import { MESSAGES } from "../lib/messages";
import { consentDetails, createFakeAuth } from "../test-support/fake-auth";
import { AuthorizeView } from "./authorize";

const ORIGIN = "https://account.example";
const ID = "auth-123";
const SEARCH = `?authorization_id=${ID}`;
const FIRST_PARTY = "first-party-client";
const APPROVED = "https://client.example/callback?code=approved";
const DENIED = "https://client.example/callback?error=access_denied";

type FakeAuth = ReturnType<typeof createFakeAuth>;

function setup(options: Parameters<typeof createFakeAuth>[0] = {}) {
  const auth = createFakeAuth(options);
  const navigated: string[] = [];
  const deps: AuthorizeDeps = {
    auth,
    firstPartyClientIds: parseFirstPartyClientIds(`other-client, ${FIRST_PARTY}`),
    navigate: (url) => navigated.push(url),
  };
  return { auth, deps, navigated };
}

function render(auth: FakeAuth, state: AuthorizeState): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    <AuthorizeView state={state} auth={auth} origin={ORIGIN} onSignedIn={noop} onDecision={noop} onSwitchAccount={noop} />,
  );
}

function returnsDetails(auth: FakeAuth, clientId: string) {
  auth.oauth.getAuthorizationDetails.mockImplementation(async () => ({
    data: consentDetails({ client: { id: clientId, name: "Example Notes", uri: "", logo_uri: "" } }),
    error: null,
  }));
}

const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
  spyOn(console, method).mockImplementation(() => undefined),
);

afterEach(() => {
  for (const spy of consoleSpies) spy.mockClear();
});

describe("/oauth/authorize", () => {
  test("signed out: renders sign-in and keeps the authorization_id in links and social redirects", async () => {
    const { auth, deps, navigated } = setup({ session: null });

    const state = await startAuthorization(deps, SEARCH);

    expect(state).toEqual({ kind: "sign-in", authorizationId: ID });
    expect(auth.oauth.getAuthorizationDetails).not.toHaveBeenCalled();
    expect(navigated).toEqual([]);

    const html = render(auth, state);
    expect(html).toContain("Sign in to your Mentra account");
    expect(html).toContain(`href="/signup?authorization_id=${ID}"`);
    expect(html).toContain(`href="/reset?authorization_id=${ID}"`);
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with Apple");
    expect(html).toMatch(/<label for="email">Email<\/label>/);
    expect(html).toMatch(/<label for="password">Password<\/label>/);

    expect(await startSocialSignIn(auth, "google", ORIGIN, ID)).toEqual({ ok: true });
    expect(await startSocialSignIn(auth, "apple", ORIGIN, ID)).toEqual({ ok: true });
    expect(auth.signInWithOAuth.mock.calls).toEqual([
      [{ provider: "google", options: { redirectTo: `${ORIGIN}/oauth/authorize?authorization_id=${ID}` } }],
      [{ provider: "apple", options: { redirectTo: `${ORIGIN}/oauth/authorize?authorization_id=${ID}` } }],
    ]);
  });

  test("signed in, first-party client: approves with no consent screen and goes to Supabase's redirect_url", async () => {
    const { auth, deps, navigated } = setup();
    returnsDetails(auth, FIRST_PARTY);

    const state = await startAuthorization(deps, SEARCH);

    expect(state).toEqual({ kind: "redirecting" });
    expect(auth.oauth.getAuthorizationDetails.mock.calls).toEqual([[ID]]);
    expect(auth.oauth.approveAuthorization.mock.calls).toEqual([[ID, { skipBrowserRedirect: true }]]);
    expect(auth.oauth.denyAuthorization).not.toHaveBeenCalled();
    expect(navigated).toEqual([APPROVED]);
    expect(render(auth, state)).not.toContain("Allow");
  });

  test("already consented: a response with only redirect_url navigates to it", async () => {
    const { auth, deps, navigated } = setup();
    const consented = "https://client.example/callback?code=already";
    auth.oauth.getAuthorizationDetails.mockImplementation(async () => ({ data: { redirect_url: consented }, error: null }));

    const state = await startAuthorization(deps, SEARCH);

    expect(state).toEqual({ kind: "redirecting" });
    expect(navigated).toEqual([consented]);
    expect(auth.oauth.approveAuthorization).not.toHaveBeenCalled();
  });

  test("a client not on the first-party list gets consent; Deny denies and Allow approves", async () => {
    const { auth, deps, navigated } = setup();
    returnsDetails(auth, "third-party-client");

    const state = await startAuthorization(deps, SEARCH);

    expect(state.kind).toBe("consent");
    expect(auth.oauth.approveAuthorization).not.toHaveBeenCalled();
    expect(navigated).toEqual([]);
    const html = render(auth, state);
    expect(html).toContain("Allow Example Notes to use your Mentra account?");
    expect(html).toContain("https://client.example/callback");
    expect(html).toContain("See your email address");
    expect(html).toContain(">Allow</button>");
    expect(html).toContain(">Deny</button>");

    expect(await decideAuthorization(deps, ID, "deny")).toEqual({ kind: "redirecting" });
    expect(auth.oauth.denyAuthorization.mock.calls).toEqual([[ID, { skipBrowserRedirect: true }]]);
    expect(auth.oauth.approveAuthorization).not.toHaveBeenCalled();
    expect(navigated).toEqual([DENIED]);

    expect(await decideAuthorization(deps, ID, "allow")).toEqual({ kind: "redirecting" });
    expect(auth.oauth.approveAuthorization.mock.calls).toEqual([[ID, { skipBrowserRedirect: true }]]);
    expect(navigated).toEqual([DENIED, APPROVED]);
  });

  test("redirect_url, redirect_uri and return_to in the query string are ignored", async () => {
    const evil = "https://evil.example/steal";
    const search = `?authorization_id=${ID}&redirect_url=${encodeURIComponent(evil)}&redirect_uri=${encodeURIComponent(evil)}&return_to=${encodeURIComponent(evil)}`;

    const signedIn = setup();
    returnsDetails(signedIn.auth, FIRST_PARTY);
    expect(await startAuthorization(signedIn.deps, search)).toEqual({ kind: "redirecting" });
    expect(signedIn.navigated).toEqual([APPROVED]);

    const signedOut = setup({ session: null });
    const state = await startAuthorization(signedOut.deps, search);
    expect(state).toEqual({ kind: "sign-in", authorizationId: ID });
    expect(signedOut.navigated).toEqual([]);
    expect(render(signedOut.auth, state)).not.toContain("evil.example");
  });

  test("another getAuthorizationDetails error shows fixed text without the authorization_id or Supabase's message", async () => {
    const { auth, deps, navigated } = setup();
    const supabaseMessage = `authorization ${ID} expired at 12:00`;
    auth.oauth.getAuthorizationDetails.mockImplementation(async () => ({
      data: null,
      error: new AuthApiError(supabaseMessage, 400, "validation_failed"),
    }));

    const state = await startAuthorization(deps, SEARCH);

    expect(state).toEqual({ kind: "error" });
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(navigated).toEqual([]);
    const html = render(auth, state);
    expect(html).toContain(MESSAGES.authorizeFailed);
    expect(html).not.toContain(ID);
    expect(html).not.toContain(supabaseMessage);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  test("a missing or malformed authorization_id shows the fixed invalid-link text", async () => {
    const { auth, deps } = setup();
    for (const search of ["", "?foo=bar", `?authorization_id=${encodeURIComponent('"><script>x</script>')}`]) {
      const state = await startAuthorization(deps, search);
      expect(state).toEqual({ kind: "invalid" });
      const html = render(auth, state);
      expect(html).toContain(MESSAGES.invalidLink);
      expect(html).not.toContain("script");
    }
    expect(auth.oauth.getAuthorizationDetails).not.toHaveBeenCalled();
  });

  test("a dead stored session (getAuthorizationDetails) signs out locally and shows sign-in for the same id, then completes", async () => {
    const { auth, deps, navigated } = setup();
    auth.oauth.getAuthorizationDetails.mockImplementationOnce(async () => ({
      data: null,
      error: new AuthApiError("Session from session_id claim in JWT does not exist", 403, "session_not_found"),
    }));

    const state = await startAuthorization(deps, SEARCH);

    expect(state).toEqual({ kind: "sign-in", authorizationId: ID });
    expect(auth.signOut.mock.calls).toEqual([[{ scope: "local" }]]);
    expect(navigated).toEqual([]);
    const html = render(auth, state);
    expect(html).toContain("Sign in to your Mentra account");
    expect(html).toContain(`href="/signup?authorization_id=${ID}"`);
    expect(html).not.toContain(MESSAGES.authorizeFailed);

    expect(await signInWithEmail(auth, "person@example.com", "correct horse")).toEqual({ ok: true });
    returnsDetails(auth, FIRST_PARTY);
    expect(await startAuthorization(deps, SEARCH)).toEqual({ kind: "redirecting" });
    expect(navigated).toEqual([APPROVED]);
  });

  test("a dead stored session (approveAuthorization) signs out locally and shows sign-in for the same id, then completes", async () => {
    const { auth, deps, navigated } = setup();
    returnsDetails(auth, FIRST_PARTY);
    auth.oauth.approveAuthorization.mockImplementationOnce(async () => ({ data: null, error: new AuthSessionMissingError() }));

    const state = await startAuthorization(deps, SEARCH);

    expect(state).toEqual({ kind: "sign-in", authorizationId: ID });
    expect(auth.signOut.mock.calls).toEqual([[{ scope: "local" }]]);
    expect(navigated).toEqual([]);
    expect(render(auth, state)).toContain("Sign in to your Mentra account");

    expect(await signInWithEmail(auth, "person@example.com", "correct horse")).toEqual({ ok: true });
    expect(await startAuthorization(deps, SEARCH)).toEqual({ kind: "redirecting" });
    expect(auth.oauth.approveAuthorization).toHaveBeenCalledTimes(2);
    expect(navigated).toEqual([APPROVED]);
  });

  test("an unsafe redirect_url from Supabase is not followed", async () => {
    const { auth, deps, navigated } = setup();
    auth.oauth.getAuthorizationDetails.mockImplementation(async () => ({
      data: { redirect_url: "javascript:alert(1)" },
      error: null,
    }));

    expect(await startAuthorization(deps, SEARCH)).toEqual({ kind: "error" });
    expect(navigated).toEqual([]);
  });
});
