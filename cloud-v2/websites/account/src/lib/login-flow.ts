import { signOutLocally } from "./account-actions";
import { isAuthSessionError } from "./auth-errors";
import type { InteractionApi } from "./interaction-api";
import { readInteractionId } from "./links";
import { MESSAGES } from "./messages";
import type { AccountAuthClient } from "./supabase";

/**
 * The login route of Core's sign-in server (`/login?interaction=…`).
 *
 * The person signs in to their Mentra account (Supabase) on this page; the
 * page then hands the session's access token to the provider's sign-in step
 * (`POST /interaction/:uid/supabase`) and follows the continuation Core
 * returns. Core ends that Supabase session, and the page forgets it, so the
 * page holds no Supabase session afterwards; single sign-on is the provider's
 * own session.
 */
export type LoginState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "sign-in"; interactionId: string; clientName: string; error: string | null }
  | { kind: "redirecting" }
  | { kind: "error" };

export interface LoginDeps {
  auth: AccountAuthClient;
  api: InteractionApi;
  /** Navigates the page away. Only ever called with the provider's continuation, or this site's consent route. */
  navigate: (url: string) => void;
}

export function initialLoginState(search: string): LoginState {
  return readInteractionId(search) ? { kind: "loading" } : { kind: "invalid" };
}

/**
 * Page entry point. Only `interaction` is read from the query string; every
 * other parameter is ignored. A Supabase session already on the page (back
 * from Google or Apple, or from an email confirmation link) is handed off at
 * once.
 */
export async function startLogin(deps: LoginDeps, search: string): Promise<LoginState> {
  const interactionId = readInteractionId(search);
  if (!interactionId) return { kind: "invalid" };
  const details = await deps.api.details(interactionId);
  if (details.kind === "expired") return { kind: "expired" };
  if (details.kind === "error") return { kind: "error" };
  if (details.prompt === "consent") {
    deps.navigate(`/consent?interaction=${encodeURIComponent(interactionId)}`);
    return { kind: "redirecting" };
  }
  const signIn: LoginState = { kind: "sign-in", interactionId, clientName: details.clientName, error: null };
  try {
    const { data, error } = await deps.auth.getSession();
    if (error) {
      // A stored session Supabase no longer accepts is not an error: forget it and ask again.
      if (isAuthSessionError(error)) await signOutLocally(deps.auth);
      return signIn;
    }
    if (!data.session) return signIn;
    return await handOff(deps, interactionId, details.clientName, data.session.access_token);
  } catch {
    return signIn;
  }
}

/** After a password sign-in (or a sign-up that signs in at once): hand the new session off. */
export async function continueAfterSignIn(deps: LoginDeps, interactionId: string, clientName: string): Promise<LoginState> {
  try {
    const { data } = await deps.auth.getSession();
    if (!data.session) return { kind: "sign-in", interactionId, clientName, error: MESSAGES.signInFailed };
    return await handOff(deps, interactionId, clientName, data.session.access_token);
  } catch {
    return { kind: "sign-in", interactionId, clientName, error: MESSAGES.signInFailed };
  }
}

async function handOff(deps: LoginDeps, interactionId: string, clientName: string, accessToken: string): Promise<LoginState> {
  const result = await deps.api.handOff(interactionId, accessToken);
  // Whatever the outcome, the page keeps no Supabase session: Core ended it on success, and a refused one is useless.
  await signOutLocally(deps.auth);
  switch (result.kind) {
    case "continue":
      deps.navigate(result.url);
      return { kind: "redirecting" };
    case "refused":
      return { kind: "sign-in", interactionId, clientName, error: MESSAGES.signInRefused };
    case "rate-limited":
      return { kind: "sign-in", interactionId, clientName, error: MESSAGES.rateLimited };
    case "expired":
      return { kind: "expired" };
    case "error":
      return { kind: "error" };
  }
}
