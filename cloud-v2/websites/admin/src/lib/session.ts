/**
 * Admin portal sign-in and sign-out, through Core's routes on this origin.
 *
 * Sign-in starts at `/api/admin/auth/login` with a relative `return_to` (the
 * current path and query, so report and test-run deep links survive the round
 * trip).
 *
 * Sign-out is one step: Core ends the admin portal session and answers the URL
 * that signs the person out of their Mentra account too, at Core's sign-in
 * server, which then sends the browser back to this site's root, the sign-in
 * page. The admin portal goes there at once. Only without that URL (or when
 * the call fails) does it show its own signed-out screen.
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

/**
 * Sign out of the admin portal and the Mentra account. With Core's sign-out URL the tab goes there (`leave`,
 * `location.replace` by default, so Back never returns to a signed-in page) and the answer is `"leaving"`: the page
 * stays as it is until the browser has left. Without one the answer is `"signed-out"`, and the admin portal shows its
 * own signed-out screen.
 */
export async function signOut({
  fetchImpl = fetch,
  leave = url => window.location.replace(url),
}: { fetchImpl?: typeof fetch; leave?: (url: string) => void } = {}): Promise<"leaving" | "signed-out"> {
  const { signOutUrl } = await signOutOfAdminPortal(fetchImpl);
  if (!signOutUrl) return "signed-out";
  leave(signOutUrl);
  return "leaving";
}

/** Only an absolute http(s) URL is followed. */
function safeSignOutUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
