/**
 * The workspace portal's addresses. Every workspace page carries its workspace:
 *
 *  - `/`                              your last-used workspace, else your first, else the first-run screen
 *  - `/invitation`                    the invitation this tab holds (from an invitation link)
 *  - `/w/<workspaceId>`               the workspace's first section you may open
 *  - `/w/<workspaceId>/<section>`     members, settings, audit or licenses
 *  - `/account/billing`               the person's own billing (when the billing module is offered to them)
 *  - `/enterprise[/environments|/access]`  the enterprise pages, by direct address only (see pages/enterprise)
 *
 * Anything else is "page not found". The address never carries an invitation token (lib/workspace-invite).
 */

export const WORKSPACE_SECTIONS = ["members", "settings", "audit", "licenses"] as const;
export type WorkspaceSection = (typeof WORKSPACE_SECTIONS)[number];

export const ENTERPRISE_PAGES = ["overview", "environments", "access"] as const;
export type EnterprisePage = (typeof ENTERPRISE_PAGES)[number];

export const INVITATION_PATH = "/invitation";

/** The person's own billing page: personal licenses, not a workspace's. */
export const ACCOUNT_BILLING_PATH = "/account/billing";

export type PortalRoute =
  | { kind: "home" }
  | { kind: "invitation" }
  /** `section` is null for `/w/<id>` or a section this portal does not have: open the first one instead. */
  | { kind: "workspace"; workspaceId: string; section: WorkspaceSection | null }
  | { kind: "enterprise"; page: EnterprisePage }
  | { kind: "account-billing" }
  | { kind: "not-found" };

function decode(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    return value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string): PortalRoute {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return { kind: "home" };
  const [first, second, third, ...rest] = segments;
  if (first === "invitation" && segments.length === 1) return { kind: "invitation" };
  if (first === "w" && second && rest.length === 0) {
    const workspaceId = decode(second);
    if (!workspaceId) return { kind: "not-found" };
    const section = WORKSPACE_SECTIONS.find(candidate => candidate === third) ?? null;
    return { kind: "workspace", workspaceId, section };
  }
  if (first === "account" && second === "billing" && !third) return { kind: "account-billing" };
  if (first === "enterprise" && !third) {
    if (!second) return { kind: "enterprise", page: "overview" };
    if (second === "environments" || second === "access") return { kind: "enterprise", page: second };
  }
  return { kind: "not-found" };
}

export function workspacePath(workspaceId: string, section?: WorkspaceSection): string {
  return `/w/${encodeURIComponent(workspaceId)}${section ? `/${section}` : ""}`;
}

export function enterprisePath(page: EnterprisePage): string {
  return page === "overview" ? "/enterprise" : `/enterprise/${page}`;
}

/**
 * Where an address that carried an invitation lands once the token is taken out of it: the invitation
 * screen, keeping any other query parameters.
 */
export function invitationLanding(urlWithoutToken: string, origin = "http://portal.invalid"): string {
  const url = new URL(urlWithoutToken, origin);
  return `${INVITATION_PATH}${url.search}${url.hash}`;
}

// --- The last-used workspace ---------------------------------------------------
// A convenience for `/`, kept in this browser's localStorage. It is never an authority: the workspace
// it names must still be in the person's workspace list, and Core checks every request anyway.

const LAST_WORKSPACE_KEY = "mentra.portal.lastWorkspace";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function rememberWorkspace(storage: KeyValueStorage | null, workspaceId: string): void {
  try {
    storage?.setItem(LAST_WORKSPACE_KEY, workspaceId);
  } catch {
    // Storage refused (private mode, quota): `/` falls back to the first workspace.
  }
}

export function recallWorkspace(storage: KeyValueStorage | null): string | null {
  try {
    return storage?.getItem(LAST_WORKSPACE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Forget the last-used workspace if it is `workspaceId` (left or deleted). */
export function forgetWorkspace(storage: KeyValueStorage | null, workspaceId: string): void {
  try {
    if (storage?.getItem(LAST_WORKSPACE_KEY) === workspaceId) storage.removeItem(LAST_WORKSPACE_KEY);
  } catch {
    // Nothing to forget.
  }
}

/** The workspace `/` opens: the remembered one while it is still in the list, else the first; null for none. */
export function homeWorkspace(workspaces: ReadonlyArray<{ workspaceId: string }>, remembered: string | null): string | null {
  if (remembered && workspaces.some(workspace => workspace.workspaceId === remembered)) return remembered;
  return workspaces[0]?.workspaceId ?? null;
}
