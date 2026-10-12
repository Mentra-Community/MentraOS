import type { OrganizationCapability, PrincipalResponse } from "@mentra/workspace-contract";

/** The admin portal's pages, in navigation order. */
export type AdminPageKey =
  | "home"
  | "review"
  | "preinstalled"
  | "audit"
  | "incidents"
  | "test-runs"
  | "routine-catalog"
  | "system-health"
  | "workspaces"
  | "operator-keys";

/** What `GET /api/admin/me` answers: who is calling and what they may do here. Open to every signed-in person. */
export interface AdminMe {
  authenticated: true;
  user: { mentraUserId: string; email: string | null; emailVerified: boolean; isOrganizationAdmin: boolean } | null;
  credential: { credentialId: string; credentialKind: "workspace" | "organization"; label: string } | null;
  organization: { capabilities: OrganizationCapability[] };
  workspaces: PrincipalResponse["workspaces"];
}

/** The pages in navigation order. The first one a principal can see is their default page. */
export const PAGE_ORDER: readonly AdminPageKey[] = [
  "home",
  "review",
  "preinstalled",
  "audit",
  "incidents",
  "test-runs",
  "routine-catalog",
  "system-health",
  "workspaces",
  "operator-keys",
];

/** Core's built-in Store: administered by Organization Admins in person, with no capability of its own. */
const BUILT_IN_STORE_PAGES: ReadonlySet<AdminPageKey> = new Set(["home", "review", "preinstalled", "audit"]);

/** The organization capability each other page needs. */
const PAGE_CAPABILITY: Partial<Record<AdminPageKey, OrganizationCapability>> = {
  incidents: "organization.incidents.read",
  "test-runs": "organization.testing.read",
  "routine-catalog": "organization.testing.read",
  "system-health": "organization.testing.read",
  workspaces: "organization.workspaces.administer",
  "operator-keys": "organization.credentials.manage",
};

/**
 * The pages this principal may open. There is no blanket admin gate: each page needs its own capability,
 * and the built-in Store's pages need an Organization Admin who is a person. Core checks every request
 * anyway; this only keeps the portal from offering what would be refused.
 */
export function visiblePages(me: Pick<AdminMe, "organization" | "user">): AdminPageKey[] {
  const held = new Set<OrganizationCapability>(me.organization.capabilities);
  return PAGE_ORDER.filter(page => {
    if (BUILT_IN_STORE_PAGES.has(page)) return me.user?.isOrganizationAdmin === true;
    const needed = PAGE_CAPABILITY[page];
    return needed !== undefined && held.has(needed);
  });
}

/** The page to show: the requested one if it is visible, otherwise the default (first visible) one, if any. */
export function resolvePage(requested: AdminPageKey | null, visible: readonly AdminPageKey[]): AdminPageKey | null {
  return requested && visible.includes(requested) ? requested : (visible[0] ?? null);
}
