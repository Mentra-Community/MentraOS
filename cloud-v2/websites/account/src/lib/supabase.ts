import {
  createClient,
  type AuthChangeEvent,
  type AuthError,
  type OAuthAuthorizationDetails,
  type OAuthRedirect,
} from "@supabase/supabase-js";

export interface AccountSession {
  user: { email?: string };
}

export interface AuthCallResult {
  error: AuthError | null;
}

export type SocialProvider = "google" | "apple";

/**
 * The subset of `supabase.auth` the account site uses. Routes take this
 * interface so tests can pass fakes; the real client satisfies it (checked in
 * `createAccountAuthClient`).
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
  resetPasswordForEmail(email: string, options: { redirectTo: string }): Promise<AuthCallResult>;
  updateUser(attributes: { password: string }): Promise<AuthCallResult>;
  /**
   * Only the local scope is allowed here. The supabase-js default is the
   * global scope, which ends every session of the account. See
   * `signOutLocally` in `account-actions.ts`.
   */
  signOut(options: { scope: "local" }): Promise<AuthCallResult>;
  onAuthStateChange(callback: (event: AuthChangeEvent, session: AccountSession | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
  oauth: {
    getAuthorizationDetails(authorizationId: string): Promise<{
      data: OAuthAuthorizationDetails | OAuthRedirect | null;
      error: AuthError | null;
    }>;
    approveAuthorization(
      authorizationId: string,
      options: { skipBrowserRedirect: true },
    ): Promise<{ data: OAuthRedirect | null; error: AuthError | null }>;
    denyAuthorization(
      authorizationId: string,
      options: { skipBrowserRedirect: true },
    ): Promise<{ data: OAuthRedirect | null; error: AuthError | null }>;
  };
}

export function createAccountAuthClient(config: {
  supabaseUrl: string;
  supabaseAnonKey: string;
}): AccountAuthClient {
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  const auth: AccountAuthClient = client.auth;
  return auth;
}
