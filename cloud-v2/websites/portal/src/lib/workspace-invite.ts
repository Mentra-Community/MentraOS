/**
 * Workspace invitation links.
 *
 * Core mails an invitation as a link to this site, `/?workspaceInvite=<token>`
 * (Core's default invitation link template; `/invite/<token>` is read too). The
 * token is a secret: on load it moves from the address bar into this tab's
 * session storage, so it never travels in a sign-in `return_to`, a referrer or a
 * bookmark. It survives the sign-in round trip in the same tab, and is forgotten
 * once the invitation is accepted or dismissed, or a look-up finds it no longer
 * valid: a dead link is shown as such once, and never again.
 *
 * Invitations addressed to the person's verified email need no link (Core lists
 * them). Dismissing one is this browser's choice, not a refusal Core records: its
 * id is remembered here (`rememberDismissedInvitation`) and it is offered no
 * more, while the invitation itself stays pending and its link keeps working.
 */

const PARAM = "workspaceInvite";
const STORAGE_KEY = "mentra.workspaceInvite";
const MAX_TOKEN_LENGTH = 512;
const INVITE_PATH = /^\/invite\/([^/]+)\/?$/;

export interface InviteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function plausible(token: string | null | undefined): string | null {
  return token && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

/** The invitation token in an address, from `?workspaceInvite=` or an `/invite/<token>` path. Ambiguous means none. */
export function readWorkspaceInvite(search: string, pathname = "/"): string | null {
  const values = new URLSearchParams(search).getAll(PARAM);
  let fromPath: string | null = null;
  const match = INVITE_PATH.exec(pathname);
  if (match) {
    try {
      fromPath = plausible(decodeURIComponent(match[1]!));
    } catch {
      fromPath = null;
    }
  }
  if (values.length === 0) return fromPath;
  const fromQuery = values.length === 1 ? plausible(values[0]) : null;
  if (fromPath !== null && fromQuery !== fromPath) return null;
  return fromQuery;
}

/** `href` as a path, query and hash, without the invitation token. */
export function withoutWorkspaceInvite(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(PARAM);
  if (INVITE_PATH.test(url.pathname)) url.pathname = "/";
  return url.pathname + url.search + url.hash;
}

/**
 * The pending invitation for this tab. A token in the address is stored and removed from the address
 * (through `replaceUrl`); otherwise the one stored earlier, if any.
 */
export function takePendingInvite(
  location: { href: string; search: string; pathname: string },
  storage: InviteStorage | null,
  replaceUrl: (url: string) => void,
): string | null {
  const fromUrl = readWorkspaceInvite(location.search, location.pathname);
  const hasParam = new URLSearchParams(location.search).has(PARAM) || INVITE_PATH.test(location.pathname);
  if (hasParam) replaceUrl(withoutWorkspaceInvite(location.href));
  if (fromUrl) {
    try {
      storage?.setItem(STORAGE_KEY, fromUrl);
    } catch {
      // Storage refused (private mode): the invitation still works until this page reloads.
    }
    return fromUrl;
  }
  try {
    return plausible(storage?.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Forget this tab's pending invitation. */
export function forgetPendingInvite(storage: InviteStorage | null): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored, or storage unavailable.
  }
}

// --- Dismissed invitations ------------------------------------------------------

const DISMISSED_KEY = "mentra.dismissedInvitations";
/** The most dismissed ids kept: invitations expire in two weeks, so old ones only take space. */
const MAX_DISMISSED = 100;

/** The ids of the invitations dismissed in this browser. */
export function dismissedInvitations(storage: InviteStorage | null): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

/** Remember that `invitationId` was dismissed, newest last, keeping the most recent {@link MAX_DISMISSED}. */
export function rememberDismissedInvitation(storage: InviteStorage | null, invitationId: string): void {
  try {
    const ids = [...dismissedInvitations(storage)].filter(id => id !== invitationId);
    ids.push(invitationId);
    storage?.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-MAX_DISMISSED)));
  } catch {
    // Storage refused: the invitation is hidden until this page reloads.
  }
}
