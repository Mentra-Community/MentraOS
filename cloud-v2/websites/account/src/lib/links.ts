/**
 * Supabase authorization IDs are opaque tokens. Only this conservative
 * character set is accepted, so the one query value the site reuses (in its
 * own same-origin links) can never carry markup or another URL.
 */
const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;

/**
 * Reads `authorization_id` and nothing else from the query string. Any other
 * parameter, such as `redirect_url`, `redirect_uri` or `return_to`, is ignored.
 */
export function readAuthorizationId(search: string): string | null {
  const values = new URLSearchParams(search).getAll("authorization_id");
  if (values.length !== 1) return null;
  const [value] = values;
  return value !== undefined && AUTHORIZATION_ID_PATTERN.test(value) ? value : null;
}

function withAuthorizationId(path: string, authorizationId: string | null | undefined): string {
  return authorizationId ? `${path}?authorization_id=${encodeURIComponent(authorizationId)}` : path;
}

export function authorizePath(authorizationId: string): string {
  return withAuthorizationId("/oauth/authorize", authorizationId);
}

export function authorizeUrl(origin: string, authorizationId: string): string {
  return `${origin}${authorizePath(authorizationId)}`;
}

export function signUpPath(authorizationId?: string | null): string {
  return withAuthorizationId("/signup", authorizationId);
}

export function resetPath(authorizationId?: string | null): string {
  return withAuthorizationId("/reset", authorizationId);
}

/**
 * Guards navigation to a `redirect_url` returned by Supabase. The URL must be
 * absolute and must not use a scheme that runs or embeds content.
 */
export function isNavigableRedirect(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return !["javascript:", "data:", "vbscript:", "blob:", "file:"].includes(url.protocol);
}
