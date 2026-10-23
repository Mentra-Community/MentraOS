import type { OrganizationCapability, PrincipalResponse } from "@mentra/workspace-contract";

/** The admin portal's pages, in navigation order. */
export type AdminPageKey =
  | "incidents"
  | "test-runs"
  | "routine-catalog"
  | "system-health"
  | "workspaces"
  | "licenses"
  | "operator-keys"
  | "audit";

/** What `GET /api/admin/me` answers: who is calling and what they may do here. Open to every signed-in person. */
export interface AdminMe {
  authenticated: true;
  user: { mentraUserId: string; email: string | null; emailVerified: boolean; isOrganizationAdmin: boolean } | null;
  credential: { credentialId: string; credentialKind: "workspace" | "organization"; label: string } | null;
  organization: { capabilities: OrganizationCapability[] };
  workspaces: PrincipalResponse["workspaces"];
  /**
   * Whether Fleet is installed on this Core, true for an install whose settings are unusable too. The Workspaces
   * page then links each workspace to its Fleet Management in the workspace portal; the admin portal has no Fleet
   * page of its own. Absent from a Core that predates Fleet, which reads as not installed.
   */
  fleet?: { installed: boolean };
  /**
   * Whether the Licenses page has anything to offer this caller: they may read licenses, and billing is configured
   * on this Core or any license exists. Absent from a Core that predates licenses, which reads as nothing to offer.
   */
  licenses?: { available: boolean };
}

/** The pages in navigation order. The first one a principal can see is their default page. */
export const PAGE_ORDER: readonly AdminPageKey[] = [
  "incidents",
  "test-runs",
  "routine-catalog",
  "system-health",
  "workspaces",
  "licenses",
  "operator-keys",
  "audit",
];

/** The organization capability each other page needs. */
const PAGE_CAPABILITY: Partial<Record<AdminPageKey, OrganizationCapability>> = {
  incidents: "organization.incidents.read",
  "test-runs": "organization.testing.read",
  "routine-catalog": "organization.testing.read",
  "system-health": "organization.testing.read",
  workspaces: "organization.workspaces.administer",
  licenses: "organization.licenses.read",
  "operator-keys": "organization.credentials.manage",
};

/**
 * The pages this principal may open. There is no blanket admin gate: each page needs its own capability,
 * the audit log needs an Organization Admin who is a person, and the Licenses page also needs billing or a license
 * on this Core. There is no Fleet page: Fleet Management is opened in the workspace portal from Workspaces. Core
 * checks every request anyway;
 * this only keeps the portal from offering what would be refused or empty.
 */
export function visiblePages(me: Pick<AdminMe, "organization" | "user" | "licenses">): AdminPageKey[] {
  const held = new Set<OrganizationCapability>(me.organization.capabilities);
  return PAGE_ORDER.filter(page => {
    // No capability opens the audit log, so no operator key sees it.
    if (page === "audit") return me.user?.isOrganizationAdmin === true;
    // With no billing and no license on this Core there is nothing to list.
    if (page === "licenses" && me.licenses?.available !== true) return false;
    const needed = PAGE_CAPABILITY[page];
    return needed !== undefined && held.has(needed);
  });
}

/** The page to show: the requested one if it is visible, otherwise the default (first visible) one, if any. */
export function resolvePage(requested: AdminPageKey | null, visible: readonly AdminPageKey[]): AdminPageKey | null {
  return requested && visible.includes(requested) ? requested : (visible[0] ?? null);
}
