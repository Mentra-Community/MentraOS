import { authErrorCode, isRateLimited } from "./auth-errors";
import { loginUrl } from "./links";
import { MESSAGES } from "./messages";
import type { AccountAuthClient, SocialProvider } from "./supabase";

export type ActionResult = { ok: true } | { ok: false; message: string };

const ok: ActionResult = { ok: true };

function fail(message: string): ActionResult {
  return { ok: false, message };
}

/**
 * Forgets the page's Supabase session.
 *
 * Never call `signOut()` without `{scope: "local"}`. The supabase-js default
 * is the global scope, which revokes every Supabase session of the account,
 * including the Mentra App's.
 */
export async function signOutLocally(auth: AccountAuthClient): Promise<void> {
  try {
    await auth.signOut({ scope: "local" });
  } catch {
    // The page shows the signed-out state either way.
  }
}

export async function signInWithEmail(
  auth: AccountAuthClient,
  email: string,
  password: string,
): Promise<ActionResult> {
  try {
    const { error } = await auth.signInWithPassword({ email, password });
    if (!error) return ok;
    if (isRateLimited(error)) return fail(MESSAGES.rateLimited);
    const code = authErrorCode(error);
    if (code === "email_not_confirmed") return fail(MESSAGES.emailNotConfirmed);
    if (code === "invalid_credentials" || error.status === 400) return fail(MESSAGES.invalidCredentials);
    return fail(MESSAGES.signInFailed);
  } catch {
    return fail(MESSAGES.signInFailed);
  }
}

/**
 * Sends the person to Google or Apple. They come back to the login route of
 * the same sign-in, where supabase-js exchanges the PKCE code.
 */
export async function startSocialSignIn(
  auth: AccountAuthClient,
  provider: SocialProvider,
  origin: string,
  interactionId: string,
): Promise<ActionResult> {
  const failure = fail(provider === "google" ? MESSAGES.googleFailed : MESSAGES.appleFailed);
  try {
    const { error } = await auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: loginUrl(origin, interactionId),
        ...(provider === "google" ? { queryParams: { prompt: "select_account" } } : {}),
      },
    });
    return error ? failure : ok;
  } catch {
    return failure;
  }
}

export type SignUpResult =
  | { kind: "check-email" }
  | { kind: "signed-in" }
  | { kind: "error"; message: string };

/**
 * Creates an account. An address that already has an account gets the same
 * "check your email" result as a new one. The confirmation link returns to
 * the sign-in in progress, or to the site's root, which shows its outcome.
 */
export async function signUpWithEmail(
  auth: AccountAuthClient,
  input: { email: string; password: string; origin: string; interactionId: string | null },
): Promise<SignUpResult> {
  const emailRedirectTo = input.interactionId ? loginUrl(input.origin, input.interactionId) : `${input.origin}/`;
  try {
    const { data, error } = await auth.signUp({
      email: input.email,
      password: input.password,
      options: { emailRedirectTo },
    });
    if (!error) {
      // Projects without email confirmation (local stacks) sign in at once.
      return data?.session ? { kind: "signed-in" } : { kind: "check-email" };
    }
    const code = authErrorCode(error);
    if (code === "user_already_exists" || code === "email_exists") return { kind: "check-email" };
    if (code === "weak_password") return { kind: "error", message: MESSAGES.weakPassword };
    if (isRateLimited(error)) return { kind: "error", message: MESSAGES.rateLimited };
    return { kind: "error", message: MESSAGES.signUpFailed };
  } catch {
    return { kind: "error", message: MESSAGES.signUpFailed };
  }
}
