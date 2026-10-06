import type { OrganizationCapability, PrincipalResponse } from "@mentra/workspace-contract";

export type AdminPageKey = "incidents" | "test-runs" | "routine-catalog" | "system-health" | "workspaces" | "operator-keys";

/** What `GET /api/admin/me` answers: who is calling and what they may do here. Open to every signed-in person. */
export interface AdminMe {
  authenticated: true;
  user: { mentraUserId: string; email: string | null } | null;
  credential: { credentialId: string; label: string } | null;
  organization: { organizationId: string; capabilities: OrganizationCapability[] };
  workspaces: PrincipalResponse["workspaces"];
}

/** The pages in navigation order. The first one a principal can see is their default page. */
const PAGE_ORDER: readonly AdminPageKey[] = [
  "incidents",
  "test-runs",
  "routine-catalog",
  "system-health",
  "workspaces",
  "operator-keys",
];

/** The organization capability each page needs. Workspaces is separate: see `visiblePages`. */
const PAGE_CAPABILITY: Record<Exclude<AdminPageKey, "workspaces">, OrganizationCapability> = {
  incidents: "organization.incidents.read",
  "test-runs": "organization.testing.read",
  "routine-catalog": "organization.testing.read",
  "system-health": "organization.testing.read",
  "operator-keys": "organization.credentials.manage",
};

/**
 * The pages this principal may open. Workspaces is for anyone who belongs to a workspace and for
 * Organization Admins; a pending invitation link also opens it, because the person it was sent to is
 * in no workspace yet and the accept screen lives there. The server still checks every request.
 */
export function visiblePages(me: Pick<AdminMe, "organization" | "workspaces">, options: { pendingInvite?: boolean } = {}): AdminPageKey[] {
  const held = new Set<OrganizationCapability>(me.organization.capabilities);
  return PAGE_ORDER.filter(page =>
    page === "workspaces"
      ? me.workspaces.length > 0 || held.has("organization.workspaces.administer") || options.pendingInvite === true
      : held.has(PAGE_CAPABILITY[page]),
  );
}

/** The page to show: the requested one if it is visible, otherwise the default (first visible) one, if any. */
export function resolvePage(requested: AdminPageKey | null, visible: readonly AdminPageKey[]): AdminPageKey | null {
  return requested && visible.includes(requested) ? requested : (visible[0] ?? null);
}
