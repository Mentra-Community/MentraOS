import { mock } from "bun:test";
import type { AuthChangeEvent, AuthError, OAuthAuthorizationDetails, OAuthRedirect } from "@supabase/supabase-js";
import type { AccountAuthClient, AccountSession, AuthCallResult } from "../lib/supabase";

type DetailsResult = { data: OAuthAuthorizationDetails | OAuthRedirect | null; error: AuthError | null };
type ConsentResult = { data: OAuthRedirect | null; error: AuthError | null };

export const SIGNED_IN: AccountSession = { user: { email: "person@example.com" } };

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
      async (_credentials: { provider: "google" | "apple"; options: { redirectTo: string } }): Promise<AuthCallResult> => ({
        error: null,
      }),
    ),
    signUp: mock(
      async (_credentials: { email: string; password: string; options: { emailRedirectTo: string } }) => ({
        data: { session: null as AccountSession | null },
        error: null as AuthError | null,
      }),
    ),
    resetPasswordForEmail: mock(
      async (_email: string, _options: { redirectTo: string }): Promise<AuthCallResult> => ({ error: null }),
    ),
    updateUser: mock(async (_attributes: { password: string }): Promise<AuthCallResult> => ({ error: null })),
    signOut: mock(async (_options?: { scope?: "local" | "global" | "others" }): Promise<AuthCallResult> => {
      session = null;
      return { error: null };
    }),
    onAuthStateChange: mock((callback: (event: AuthChangeEvent, session: AccountSession | null) => void) => {
      listeners.push(callback);
      return { data: { subscription: { unsubscribe: () => undefined } } };
    }),
    oauth: {
      getAuthorizationDetails: mock(
        async (_authorizationId: string): Promise<DetailsResult> => ({ data: { redirect_url: "" }, error: null }),
      ),
      approveAuthorization: mock(
        async (_authorizationId: string, _options: { skipBrowserRedirect: true }): Promise<ConsentResult> => ({
          data: { redirect_url: "https://client.example/callback?code=approved" },
          error: null,
        }),
      ),
      denyAuthorization: mock(
        async (_authorizationId: string, _options: { skipBrowserRedirect: true }): Promise<ConsentResult> => ({
          data: { redirect_url: "https://client.example/callback?error=access_denied" },
          error: null,
        }),
      ),
    },
    /** Test helper: emit an auth event to every listener. */
    emit(event: AuthChangeEvent) {
      for (const listener of listeners) listener(event, session);
    },
  };

  const typed: AccountAuthClient = auth;
  void typed;
  return auth;
}

export function consentDetails(overrides: Partial<OAuthAuthorizationDetails> = {}): OAuthAuthorizationDetails {
  return {
    authorization_id: "auth-123",
    redirect_uri: "https://client.example/callback",
    client: { id: "third-party-client", name: "Example Notes", uri: "https://client.example", logo_uri: "" },
    user: { id: "user-1", email: "person@example.com" },
    scope: "openid email",
    ...overrides,
  };
}
