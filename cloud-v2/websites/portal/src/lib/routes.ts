/**
 * The workspace portal's addresses. A person's own workspace is never in the address; another is named by
 * `?workspace=`:
 *
 *  - `/`                              the current workspace's first section you may open, else the first run
 *  - `/members`, `/settings`, `/licenses`, `/audit`   a section of the current workspace
 *  - `?workspace=ws_…`                on any of them: that workspace instead (an Organization Admin's way into a customer's)
 *  - `/invitation`                    the invitation this tab holds (from an invitation link)
 *  - `/enterprise[/environments|/access]`  the enterprise pages, by direct address only (see pages/enterprise)
 *  - `/w/<workspaceId>[/<section>]`   an older address; it redirects to the one above, keeping its query
 *
 * The current workspace is `?workspace=` when the address has one, else the last one opened from the person's own
 * list (while it is still there), else their first (`currentWorkspace`). The bare address of a workspace is the
 * one the address without `?workspace=` would open (`sectionHref`), so a person's own addresses stay short.
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
  | { kind: "section"; section: WorkspaceSection }
  /** An older `/w/<id>[/<section>]` address. `section` is null for `/w/<id>` or a section this portal does not have. */
  | { kind: "legacy-workspace"; workspaceId: string; section: WorkspaceSection | null }
  | { kind: "enterprise"; page: EnterprisePage }
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
  const section = WORKSPACE_SECTIONS.find(candidate => candidate === first);
  if (section && segments.length === 1) return { kind: "section", section };
  if (first === "w" && second && rest.length === 0) {
    const workspaceId = decode(second);
    if (!workspaceId) return { kind: "not-found" };
    const legacySection = WORKSPACE_SECTIONS.find(candidate => candidate === third) ?? null;
    return { kind: "legacy-workspace", workspaceId, section: legacySection };
  }
  if (first === "enterprise" && !third) {
    if (!second) return { kind: "enterprise", page: "overview" };
    if (second === "environments" || second === "access") return { kind: "enterprise", page: second };
  }
  return { kind: "not-found" };
}

/** The `?workspace=` of an address's query string (with or without its `?`); null when there is none. */
export function workspaceParam(search: string): string | null {
  return new URLSearchParams(search).get("workspace")?.trim() || null;
}

/**
 * The workspace an address is about: its `?workspace=` when it has one (Core decides whether the person may open
 * it), else the remembered workspace while it is in the person's own list, else their first, else none. A
 * remembered workspace the person is not in (left, deleted, or only ever reached as an Organization Admin) is
 * ignored: storage never names a workspace outside their list.
 */
export function currentWorkspace({
  param,
  remembered,
  workspaces,
}: {
  param: string | null;
  remembered: string | null;
  workspaces: ReadonlyArray<{ workspaceId: string }>;
}): string | null {
  if (param) return param;
  if (remembered && workspaces.some(workspace => workspace.workspaceId === remembered)) return remembered;
  return workspaces[0]?.workspaceId ?? null;
}

/**
 * The address of `section` (the current workspace's first one for null) in `workspaceId`. It carries
 * `?workspace=` exactly when `workspaceId` is not what the bare address opens (`bareWorkspaceId`, or none), so an
 * Organization Admin browsing a customer's workspace stays in it.
 */
export function sectionHref(section: WorkspaceSection | null, workspaceId: string, bareWorkspaceId: string | null): string {
  const path = section ? `/${section}` : "/";
  return workspaceId === bareWorkspaceId ? path : `${path}?workspace=${encodeURIComponent(workspaceId)}`;
}

/**
 * Where an older `/w/<id>[/<section>]` address goes, keeping every other query parameter: `/<section>?workspace=<id>`,
 * or `/?workspace=<id>` without a section (or with one this portal does not have). Null for any other address.
 */
export function legacyRedirect(pathname: string, search: string): string | null {
  const route = parseRoute(pathname);
  if (route.kind !== "legacy-workspace") return null;
  const query = new URLSearchParams();
  query.set("workspace", route.workspaceId);
  for (const [name, value] of new URLSearchParams(search)) if (name !== "workspace") query.append(name, value);
  return `${route.section ? `/${route.section}` : "/"}?${query.toString()}`;
}

/**
 * The address a workspace opens at after the person joins it from where they are: the same page and query,
 * now in `workspaceId`. A page that is not a workspace's (an enterprise page) opens the workspace's first section.
 */
export function joinedAddress(pathname: string, search: string, workspaceId: string): string {
  const kind = parseRoute(pathname).kind;
  const keeps = kind === "section" || kind === "home" || kind === "invitation";
  const query = new URLSearchParams();
  query.set("workspace", workspaceId);
  if (keeps) for (const [name, value] of new URLSearchParams(search)) if (name !== "workspace") query.append(name, value);
  return `${kind === "section" ? pathname : "/"}?${query.toString()}`;
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
// A convenience for the bare address, kept in this browser's localStorage. It is never an authority: the workspace
// it names must still be in the person's workspace list (`currentWorkspace`), and Core checks every request anyway.
// Only a workspace opened from that list is remembered.

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
    // Storage refused (private mode, quota): the bare address falls back to the first workspace.
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
