import type { OAuthAuthorizationDetails, OAuthRedirect } from "@supabase/supabase-js";
import { signOutLocally } from "./account-actions";
import { isAuthSessionError } from "./auth-errors";
import { isFirstPartyClient } from "./first-party";
import { isNavigableRedirect, readAuthorizationId } from "./links";
import type { AccountAuthClient } from "./supabase";

export interface ConsentDetails {
  clientName: string;
  redirectUri: string;
  scopes: string[];
  email: string;
}

export type AuthorizeState =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "sign-in"; authorizationId: string }
  | { kind: "consent"; authorizationId: string; consent: ConsentDetails }
  | { kind: "redirecting" }
  | { kind: "error" };

export type AuthorizeDecision = "allow" | "deny";

export interface AuthorizeDeps {
  auth: AccountAuthClient;
  firstPartyClientIds: ReadonlySet<string>;
  /** Navigates the page away. Only ever called with a Supabase `redirect_url`. */
  navigate: (url: string) => void;
}

const ERROR: AuthorizeState = { kind: "error" };
const REDIRECTING: AuthorizeState = { kind: "redirecting" };

/** The state before any Supabase call: `loading`, or `invalid` without a usable ID. */
export function initialAuthorizeState(search: string): AuthorizeState {
  return readAuthorizationId(search) ? { kind: "loading" } : { kind: "invalid" };
}

/**
 * Page entry point. Only `authorization_id` is read from the query string;
 * every other parameter (`redirect_url`, `redirect_uri`, `return_to`, …) is
 * ignored, so navigation can only go to a URL Supabase returns.
 */
export async function startAuthorization(deps: AuthorizeDeps, search: string): Promise<AuthorizeState> {
  const authorizationId = readAuthorizationId(search);
  return authorizationId ? await completeAuthorization(deps, authorizationId) : { kind: "invalid" };
}

/**
 * Runs the authorization for a signed-in person, or asks them to sign in.
 *
 * - Already consented: Supabase returns only `redirect_url`; go there.
 * - First-party client: approve without a consent screen.
 * - Any other client: show the consent screen.
 */
export async function completeAuthorization(
  deps: AuthorizeDeps,
  authorizationId: string,
): Promise<AuthorizeState> {
  try {
    const session = await deps.auth.getSession();
    if (session.error) return await handleFailure(deps, authorizationId, session.error);
    if (!session.data.session) return { kind: "sign-in", authorizationId };

    const { data, error } = await deps.auth.oauth.getAuthorizationDetails(authorizationId);
    if (error || !data) return await handleFailure(deps, authorizationId, error);

    if (!isConsentRequest(data)) return navigateTo(deps, data.redirect_url);

    if (isFirstPartyClient(deps.firstPartyClientIds, data.client?.id)) {
      const approval = await deps.auth.oauth.approveAuthorization(authorizationId, {
        skipBrowserRedirect: true,
      });
      return await followConsentResult(deps, authorizationId, approval);
    }

    return { kind: "consent", authorizationId, consent: toConsentDetails(data) };
  } catch (error) {
    return await handleFailure(deps, authorizationId, error);
  }
}

/** Allow or Deny on the consent screen. */
export async function decideAuthorization(
  deps: AuthorizeDeps,
  authorizationId: string,
  decision: AuthorizeDecision,
): Promise<AuthorizeState> {
  try {
    const result =
      decision === "allow"
        ? await deps.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
        : await deps.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
    return await followConsentResult(deps, authorizationId, result);
  } catch (error) {
    return await handleFailure(deps, authorizationId, error);
  }
}

/** "Use a different account" on the consent screen. */
export async function switchAccount(
  deps: AuthorizeDeps,
  authorizationId: string,
): Promise<AuthorizeState> {
  await signOutLocally(deps.auth);
  return { kind: "sign-in", authorizationId };
}

function isConsentRequest(
  data: OAuthAuthorizationDetails | OAuthRedirect,
): data is OAuthAuthorizationDetails {
  return "authorization_id" in data && typeof data.authorization_id === "string";
}

async function followConsentResult(
  deps: AuthorizeDeps,
  authorizationId: string,
  result: { data: OAuthRedirect | null; error: unknown },
): Promise<AuthorizeState> {
  if (result.error || !result.data) return await handleFailure(deps, authorizationId, result.error);
  return navigateTo(deps, result.data.redirect_url);
}

function navigateTo(deps: AuthorizeDeps, redirectUrl: unknown): AuthorizeState {
  if (!isNavigableRedirect(redirectUrl)) return ERROR;
  deps.navigate(redirectUrl);
  return REDIRECTING;
}

/**
 * A stored session that Supabase no longer accepts (for example after an
 * account-wide revocation) is not an error: drop it and ask the person to
 * sign in again for the same authorization request.
 */
async function handleFailure(
  deps: AuthorizeDeps,
  authorizationId: string,
  error: unknown,
): Promise<AuthorizeState> {
  if (isAuthSessionError(error)) {
    await signOutLocally(deps.auth);
    return { kind: "sign-in", authorizationId };
  }
  return ERROR;
}

function toConsentDetails(details: OAuthAuthorizationDetails): ConsentDetails {
  return {
    clientName: details.client?.name?.trim() || "This app",
    redirectUri: details.redirect_uri ?? "",
    scopes: (details.scope ?? "").split(/\s+/).filter(Boolean),
    email: details.user?.email ?? "",
  };
}
