import { mock } from "bun:test";
import type { AuthChangeEvent, AuthError } from "@supabase/supabase-js";
import type { ContinueResult, DetailsResult, InteractionApi } from "../lib/interaction-api";
import type { AccountAuthClient, AccountSession, AuthCallResult } from "../lib/supabase";

export const SIGNED_IN: AccountSession = { access_token: "supabase-access-token", user: { email: "person@example.com" } };

/**
 * An in-memory stand-in for `supabase.auth`. Every method is a bun mock, so
 * tests can assert calls and replace behavior with `mockImplementation`.
 */
export function createFakeAuth(options: { session?: AccountSession | null } = {}) {
  let session: AccountSession | null = options.session === undefined ? SIGNED_IN : options.session;
  const listeners: Array<(event: AuthChangeEvent, session: AccountSession | null) => void> = [];
  const auth = {
    getSession: mock(async () => ({ data: { session }, error: null as AuthError | null })),
    signInWithPassword: mock(async (_credentials: { email: string; password: string }): Promise<AuthCallResult> => {
      session = SIGNED_IN;
      return { error: null };
    }),
    signInWithOAuth: mock(
      async (_credentials: Parameters<AccountAuthClient["signInWithOAuth"]>[0]): Promise<AuthCallResult> => ({
        error: null,
      }),
    ),
    signUp: mock(
      async (_credentials: { email: string; password: string; options: { emailRedirectTo: string } }) => ({
        data: { session: null as AccountSession | null },
        error: null as AuthError | null,
      }),
    ),
    signOut: mock(async (_options?: { scope?: "local" | "global" | "others" }): Promise<AuthCallResult> => {
      session = null;
      return { error: null };
    }),
    onAuthStateChange: mock((callback: (event: AuthChangeEvent, session: AccountSession | null) => void) => {
      listeners.push(callback);
      return { data: { subscription: { unsubscribe: () => undefined } } };
    }),
    /** Test helper: the page's current Supabase session. */
    current: () => session,
  };
  const typed: AccountAuthClient = auth;
  void typed;
  return auth;
}

export const CONTINUATION = "https://account.example/oidc/auth/resume-123";

/** A stand-in for Core's sign-in server on the page's origin. */
export function createFakeInteractions(
  overrides: { details?: DetailsResult; handOff?: ContinueResult; decide?: ContinueResult } = {},
) {
  const api = {
    details: mock(async (_interactionId: string): Promise<DetailsResult> =>
      overrides.details ?? { kind: "ok", prompt: "login", clientName: "Mentra admin portal", scopes: ["openid", "email"] },
    ),
    handOff: mock(async (_interactionId: string, _accessToken: string): Promise<ContinueResult> =>
      overrides.handOff ?? { kind: "continue", url: CONTINUATION },
    ),
    decide: mock(async (_interactionId: string, _decision: "allow" | "deny"): Promise<ContinueResult> =>
      overrides.decide ?? { kind: "continue", url: CONTINUATION },
    ),
  };
  const typed: InteractionApi = api;
  void typed;
  return api;
}
