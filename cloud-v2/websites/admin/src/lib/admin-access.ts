import type { OrganizationCapability, PrincipalResponse } from "@mentra/workspace-contract";

/** The admin portal's pages, in navigation order. */
export type AdminPageKey =
  | "incidents"
  | "fleet"
  | "test-runs"
  | "routine-catalog"
  | "system-health"
  | "workspaces"
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
   * Whether Fleet is installed on this Core, true for an install whose settings are unusable too (the Fleet page
   * then says Fleet is unavailable). Absent from a Core that predates Fleet, which reads as not installed.
   */
  fleet?: { installed: boolean };
}

/** The pages in navigation order. The first one a principal can see is their default page. */
export const PAGE_ORDER: readonly AdminPageKey[] = [
  "incidents",
  "fleet",
  "test-runs",
  "routine-catalog",
  "system-health",
  "workspaces",
  "operator-keys",
  "audit",
];

/** The organization capability each other page needs. */
const PAGE_CAPABILITY: Partial<Record<AdminPageKey, OrganizationCapability>> = {
  incidents: "organization.incidents.read",
  fleet: "organization.fleet.administer",
  "test-runs": "organization.testing.read",
  "routine-catalog": "organization.testing.read",
  "system-health": "organization.testing.read",
  workspaces: "organization.workspaces.administer",
  "operator-keys": "organization.credentials.manage",
};

/**
 * The pages this principal may open. There is no blanket admin gate: each page needs its own capability,
 * the audit log needs an Organization Admin who is a person, and the Fleet page also needs Fleet installed
 * on this Core. Core checks every request anyway; this only keeps the portal from offering what would be
 * refused.
 */
export function visiblePages(me: Pick<AdminMe, "organization" | "user" | "fleet">): AdminPageKey[] {
  const held = new Set<OrganizationCapability>(me.organization.capabilities);
  return PAGE_ORDER.filter(page => {
    // No capability opens the audit log, so no operator key sees it.
    if (page === "audit") return me.user?.isOrganizationAdmin === true;
    // Without Fleet on this Core there is nothing to open, whatever the principal holds.
    if (page === "fleet" && me.fleet?.installed !== true) return false;
    const needed = PAGE_CAPABILITY[page];
    return needed !== undefined && held.has(needed);
  });
}

/** The page to show: the requested one if it is visible, otherwise the default (first visible) one, if any. */
export function resolvePage(requested: AdminPageKey | null, visible: readonly AdminPageKey[]): AdminPageKey | null {
  return requested && visible.includes(requested) ? requested : (visible[0] ?? null);
}
