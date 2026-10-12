import { authErrorCode, isAuthSessionError, isRateLimited } from "./auth-errors";
import { authorizeUrl } from "./links";
import { MESSAGES } from "./messages";
import type { AccountAuthClient, SocialProvider } from "./supabase";

export type ActionResult = { ok: true } | { ok: false; message: string };

const ok: ActionResult = { ok: true };

function fail(message: string): ActionResult {
  return { ok: false, message };
}

/**
 * Ends this site's session only.
 *
 * Never call `signOut()` without `{scope: "local"}`. The supabase-js default
 * is the global scope, which revokes every session of the account: the admin
 * portal, the enterprise portal, the Developer Console and the CLI would all
 * be signed out too.
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
 * Sends the person to Google or Apple. They come back to the same
 * authorization request, where the PKCE code is exchanged by supabase-js.
 */
export async function startSocialSignIn(
  auth: AccountAuthClient,
  provider: SocialProvider,
  origin: string,
  authorizationId: string,
): Promise<ActionResult> {
  const failure = fail(provider === "google" ? MESSAGES.googleFailed : MESSAGES.appleFailed);
  try {
    const { error } = await auth.signInWithOAuth({
      provider,
      options: { redirectTo: authorizeUrl(origin, authorizationId) },
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
 * "check your email" result as a new one.
 */
export async function signUpWithEmail(
  auth: AccountAuthClient,
  input: { email: string; password: string; origin: string; authorizationId: string | null },
): Promise<SignUpResult> {
  const emailRedirectTo = input.authorizationId
    ? authorizeUrl(input.origin, input.authorizationId)
    : `${input.origin}/`;
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

/** Always reports the same result whether or not the address has an account. */
export async function requestPasswordReset(
  auth: AccountAuthClient,
  input: { email: string; origin: string; authorizationId: string | null },
): Promise<ActionResult> {
  const redirectTo = input.authorizationId
    ? `${input.origin}/reset?authorization_id=${encodeURIComponent(input.authorizationId)}`
    : `${input.origin}/reset`;
  try {
    const { error } = await auth.resetPasswordForEmail(input.email, { redirectTo });
    if (!error) return ok;
    return fail(isRateLimited(error) ? MESSAGES.rateLimited : MESSAGES.resetFailed);
  } catch {
    return fail(MESSAGES.resetFailed);
  }
}

export type UpdatePasswordResult = ActionResult & { expired?: boolean };

export async function updatePassword(
  auth: AccountAuthClient,
  password: string,
): Promise<UpdatePasswordResult> {
  try {
    const { error } = await auth.updateUser({ password });
    if (!error) return ok;
    if (isAuthSessionError(error)) return { ok: false, message: MESSAGES.resetExpired, expired: true };
    const code = authErrorCode(error);
    if (code === "weak_password") return fail(MESSAGES.weakPassword);
    if (code === "same_password") return fail(MESSAGES.samePassword);
    if (code === "reauthentication_needed") {
      return { ok: false, message: MESSAGES.resetExpired, expired: true };
    }
    if (isRateLimited(error)) return fail(MESSAGES.rateLimited);
    return fail(MESSAGES.updatePasswordFailed);
  } catch {
    return fail(MESSAGES.updatePasswordFailed);
  }
}
