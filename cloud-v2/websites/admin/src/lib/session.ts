/**
 * Admin portal sign-in and sign-out, through Core's routes on this origin.
 *
 * Sign-in starts at `/api/admin/auth/login` with a relative `return_to` (the
 * current path and query, so report and test-run deep links survive the round
 * trip). Sign-out ends the admin portal session and returns the identity
 * provider's sign-out URL, which the signed-out screen offers as a link.
 */

export function loginHref(location: { pathname: string; search: string } = window.location): string {
  return `/api/admin/auth/login?return_to=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
}

export async function signOutOfAdminPortal(fetchImpl: typeof fetch = fetch): Promise<{ signOutUrl: string | null }> {
  try {
    const response = await fetchImpl("/api/admin/auth/logout", {
      method: "POST",
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    if (!response.ok) return { signOutUrl: null };
    const body = (await response.json()) as { signOutUrl?: unknown };
    return { signOutUrl: safeSignOutUrl(body.signOutUrl) };
  } catch {
    return { signOutUrl: null };
  }
}

/** Only an absolute http(s) URL is offered as a link. */
function safeSignOutUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
