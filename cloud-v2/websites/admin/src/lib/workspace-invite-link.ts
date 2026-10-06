// A workspace invitation link points at this site as `/?workspaceInvite=<token>`
// (Core's CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE). Opening it lands on the Workspaces page
// with the accept screen. The token is a secret: it is read once into state, never logged, and
// removed from the address bar when the invitation is spent.
const PARAM = "workspaceInvite";
const MAX_TOKEN_LENGTH = 512;

export function readWorkspaceInvite(search: string): string | null {
  const values = new URLSearchParams(search).getAll(PARAM);
  const token = values[0];
  return values.length === 1 && token && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

/** `href` as a path, query and hash, without the invitation token. */
export function withoutWorkspaceInvite(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(PARAM);
  return url.pathname + url.search + url.hash;
}
