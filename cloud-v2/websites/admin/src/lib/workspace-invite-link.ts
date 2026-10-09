// A workspace invitation link points at this site as `/?workspaceInvite=<token>`
// (Core's CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE). The Developer Console's form,
// `/invite/<token>`, is accepted too: the server redirects it to the query form (the built
// app's assets are relative, so it cannot load under `/invite/`), and the app reads either.
// Opening it lands on the Workspaces page with the accept screen. The token is a secret: it is
// read once into state, never logged, and removed from the address bar when the invitation is spent.
const PARAM = "workspaceInvite";
const MAX_TOKEN_LENGTH = 512;
const INVITE_PATH = /^\/invite\/([^/]+)\/?$/;
/** What Core and the Store mint: base64url. Only such a token is redirected by the server. */
const REDIRECTABLE_TOKEN = /^[A-Za-z0-9_-]+$/;

/** The token of an `/invite/<token>` path, or null when `pathname` is not exactly one. */
function readInvitePath(pathname: string): string | null {
  const match = INVITE_PATH.exec(pathname);
  if (!match) return null;
  let token: string;
  try {
    token = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return token && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

/**
 * The invitation token in this address, from `?workspaceInvite=` or an `/invite/<token>` path.
 * Both at once must name the same token; anything ambiguous is no invitation.
 */
export function readWorkspaceInvite(search: string, pathname = "/"): string | null {
  const values = new URLSearchParams(search).getAll(PARAM);
  const fromPath = readInvitePath(pathname);
  if (values.length === 0) return fromPath;
  const token = values[0];
  const fromQuery = values.length === 1 && token && token.length <= MAX_TOKEN_LENGTH ? token : null;
  if (fromPath !== null && fromQuery !== fromPath) return null;
  return fromQuery;
}

/**
 * Where the server sends an `/invite/<token>` request: `/?workspaceInvite=<token>` with the
 * rest of the query kept. Null for any other path, or a token that is not plain base64url.
 */
export function workspaceInviteRedirect(url: URL): string | null {
  const token = readInvitePath(url.pathname);
  if (!token || !REDIRECTABLE_TOKEN.test(token)) return null;
  const search = new URLSearchParams(url.search);
  search.set(PARAM, token);
  return `/?${search}`;
}

/** Remove the invitation from `url` in place: the query parameter, and an `/invite/<token>` path. */
export function removeWorkspaceInvite(url: URL): void {
  url.searchParams.delete(PARAM);
  if (INVITE_PATH.test(url.pathname)) url.pathname = "/";
}

/** `href` as a path, query and hash, without the invitation token. */
export function withoutWorkspaceInvite(href: string): string {
  const url = new URL(href);
  removeWorkspaceInvite(url);
  return url.pathname + url.search + url.hash;
}
