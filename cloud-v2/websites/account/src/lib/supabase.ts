import { createClient, type AuthChangeEvent, type AuthError } from "@supabase/supabase-js";

export interface AccountSession {
  access_token: string;
  user: { email?: string };
}

export interface AuthCallResult {
  error: AuthError | null;
}

export type SocialProvider = "google" | "apple";

/**
 * The subset of `supabase.auth` the sign-in page uses. Routes take this
 * interface so tests can pass fakes; the real client satisfies it (checked in
 * `createAccountAuthClient`).
 *
 * The page signs the person in to Supabase only long enough to hand the access
 * token to Core's sign-in server. Core ends that Supabase session, and the
 * page clears it locally (`signOutLocally`), so the page keeps none.
 */
export interface AccountAuthClient {
  getSession(): Promise<{ data: { session: AccountSession | null }; error: AuthError | null }>;
  signInWithPassword(credentials: { email: string; password: string }): Promise<AuthCallResult>;
  signInWithOAuth(credentials: {
    provider: SocialProvider;
    options: { redirectTo: string };
  }): Promise<AuthCallResult>;
  signUp(credentials: {
    email: string;
    password: string;
    options: { emailRedirectTo: string };
  }): Promise<{ data: { session: AccountSession | null } | null; error: AuthError | null }>;
  /**
   * Only the local scope is allowed here. The supabase-js default is the
   * global scope, which ends every session of the account. See
   * `signOutLocally` in `account-actions.ts`.
   */
  signOut(options: { scope: "local" }): Promise<AuthCallResult>;
  onAuthStateChange(callback: (event: AuthChangeEvent, session: AccountSession | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
}

export function createAccountAuthClient(config: {
  supabaseUrl: string;
  supabaseAnonKey: string;
}): AccountAuthClient {
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      // PKCE for Google and Apple: the verifier waits in storage across the redirect.
      flowType: "pkce",
      persistSession: true,
      // The session lives only until the hand-off; it is never refreshed.
      autoRefreshToken: false,
      detectSessionInUrl: true,
    },
  });
  const auth: AccountAuthClient = client.auth;
  return auth;
}
