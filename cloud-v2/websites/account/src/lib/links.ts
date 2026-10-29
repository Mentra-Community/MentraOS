/**
 * Interaction IDs of Core's sign-in server are opaque values from a
 * conservative character set. Only this one query value is ever read and
 * reused (in the page's own same-origin links), so it can never carry markup
 * or another URL.
 */
const INTERACTION_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;

/**
 * Reads `interaction` and nothing else from the query string. Any other
 * parameter, such as `redirect_url`, `redirect_uri` or `return_to`, is ignored.
 */
export function readInteractionId(search: string): string | null {
  const values = new URLSearchParams(search).getAll("interaction");
  if (values.length !== 1) return null;
  const [value] = values;
  return value !== undefined && INTERACTION_ID_PATTERN.test(value) ? value : null;
}

function withInteraction(path: string, interactionId: string | null | undefined): string {
  return interactionId ? `${path}?interaction=${encodeURIComponent(interactionId)}` : path;
}

export function loginPath(interactionId: string): string {
  return withInteraction("/login", interactionId);
}

export function loginUrl(origin: string, interactionId: string): string {
  return `${origin}${loginPath(interactionId)}`;
}

export function signUpPath(interactionId?: string | null): string {
  return withInteraction("/signup", interactionId);
}

export function resetPath(interactionId?: string | null): string {
  return withInteraction("/reset", interactionId);
}

/** The provider's end-session endpoint: signing out of the sign-in site. */
export const END_SESSION_PATH = "/oidc/session/end";

/**
 * Guards navigation to a redirect Core's sign-in server returned: only the
 * provider's own continuation on this origin (`/oidc/auth/...`), never
 * anything else, whatever the server or a query parameter says.
 */
export function isProviderContinuation(origin: string, value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return false;
  }
  return url.origin === origin && url.pathname.startsWith("/oidc/auth/");
}
