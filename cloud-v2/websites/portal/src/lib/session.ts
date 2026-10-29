/**
 * Workspace portal sign-in and sign-out, through Core's routes on this origin.
 *
 * Sign-in starts at `/api/portal/auth/login` with a relative `return_to` (the
 * current path and query, so report and test-run deep links survive the round
 * trip). A signed-out page goes there at once, with no button to press, unless
 * it is the person coming back from it still signed out (a browser that drops
 * the session cookie): then it shows its sign-in button, so it never loops.
 *
 * Sign-out is one step: Core ends the workspace portal session and answers the
 * URL that signs the person out of their Mentra account too, at Core's sign-in
 * server, which then sends the browser back to this site's root, the sign-in
 * page. The portal goes there at once. Only without that URL (or when the call
 * fails) does it show its own signed-out screen.
 */

import { INVITATION_PATH } from "./routes";

/**
 * The sign-in link, returning to `location`. The bare address with an invitation pending in this tab returns to the
 * invitation instead: that is where a full sign-out (Switch account, say) lands, and the invitation is what the person
 * signs in again for.
 */
export function loginHref(location: { pathname: string; search: string } = window.location, invitePending = false): string {
  const returnTo = invitePending && location.pathname === "/" && !location.search ? INVITATION_PATH : `${location.pathname}${location.search}`;
  return `/api/portal/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}

/** This tab's note of when it last sent the person to sign in. */
const SENT_TO_SIGN_IN_KEY = "mentra.portal.sentToSignIn";

/** How soon after being sent to sign in a signed-out page counts as the person coming back from it. */
const SIGN_IN_ROUND_TRIP_MS = 60_000;

/**
 * Whether this tab sent the person to sign in moments ago, read once as the page starts and then forgotten. Without
 * session storage it can't tell, and says yes: the page then shows its button rather than risk a loop.
 */
export function returningFromSignIn(storage: Storage | null, now = Date.now()): boolean {
  if (!storage) return true;
  try {
    const sentAt = Number(storage.getItem(SENT_TO_SIGN_IN_KEY));
    storage.removeItem(SENT_TO_SIGN_IN_KEY);
    return sentAt > 0 && now - sentAt < SIGN_IN_ROUND_TRIP_MS;
  } catch {
    return true;
  }
}

/**
 * Sends the person straight to sign in at `url` (`go`, `location.replace` by default, so Back skips the empty
 * signed-out page), noting it in this tab first. False, without going, where it can't be noted.
 */
export function sendToSignIn(
  url: string,
  storage: Storage | null,
  { now = Date.now(), go = (to: string) => window.location.replace(to) }: { now?: number; go?: (url: string) => void } = {},
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SENT_TO_SIGN_IN_KEY, String(now));
  } catch {
    return false;
  }
  go(url);
  return true;
}

export async function signOutOfEnterprisePortal(fetchImpl: typeof fetch = fetch): Promise<{ signOutUrl: string | null }> {
  try {
    const response = await fetchImpl("/api/portal/auth/logout", {
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
 * Sign out of the workspace portal and the Mentra account. With Core's sign-out URL the tab goes there (`leave`,
 * `location.replace` by default, so Back never returns to a signed-in page) and the answer is `"leaving"`: the page
 * stays as it is until the browser has left. Without one the answer is `"signed-out"`, and the portal shows its own
 * signed-out screen.
 */
export async function signOut({
  fetchImpl = fetch,
  leave = url => window.location.replace(url),
}: { fetchImpl?: typeof fetch; leave?: (url: string) => void } = {}): Promise<"leaving" | "signed-out"> {
  const { signOutUrl } = await signOutOfEnterprisePortal(fetchImpl);
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
