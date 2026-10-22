/**
 * One workspace in the workspace portal: `/w/<workspaceId>/<section>`, framed by the sidebar.
 *
 * The sections are the shared Core workspace screens (`@mentra/workspace-ui`): Members (the member list
 * with the pending invitations under it, and Invite in the header), Settings, and Licenses
 * (pages/licenses). The sidebar offers only the sections the viewer's capabilities open, and Licenses only
 * where there is something to show: the person manages billing, or the workspace has licenses (a member sees
 * their own seats, never billing). A Private Cloud has neither. Every request is still checked by Core. A
 * workspace that does not exist, or that the viewer may not see, is one "not found" page.
 *
 * Members shows each member's licenses where billing's catalog can be read, and only shows them: licenses are
 * assigned from the Licenses page. A row's "…" menu changes a role or removes the member.
 */

import { useQuery } from "@tanstack/react-query";
import type { LicenseView, WorkspaceCapability, WorkspaceDetail } from "@mentra/workspace-contract";
import {
  actsAsOrganizationAdmin,
  Button,
  can,
  billingCatalogQuery,
  billingStatusQuery,
  effectiveRole,
  errorMessage,
  invitationsQuery,
  licensesQuery,
  licenseStrings,
  membersQuery,
  ROLE_LABELS,
  Spinner,
  WorkspaceApiError,
  WorkspaceInviteDialog,
  WorkspaceMembersPanel,
  WorkspacePendingInvitationsPanel,
  WorkspaceSettingsPanel,
  workspaceDetailQuery,
  workspaceListQuery,
  workspaceScope,
  type MembersLicenses,
  type NavGroup,
} from "@mentra/workspace-ui";
import { Boxes, CreditCard, Glasses, LayoutDashboard, Settings, ShieldCheck, UserPlus, Users, UsersRound, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { PortalShell } from "@/components/portal-shell";
import { safeLocalStorage, type PortalMe } from "@/lib/api";
import { navigate, Redirect, useSearch } from "@/lib/navigation";
import { portalBillingApi, portalNavigateOut, portalWorkspaceApi, STORE_DELETE_NOTICE } from "@/lib/portal";
import { fleetItemOf, fleetPath, forgetWorkspace, rememberWorkspace, workspacePath, type FleetItem, type WorkspaceSection } from "@/lib/routes";
import { FleetScreen } from "./fleet";
import { billingOffered, LicensesHeaderActions, LicensesScreen } from "./licenses";
import { NotFoundMessage } from "./not-found";

type SectionMeta = {
  label: string;
  icon: LucideIcon;
  /** The capability that opens it; null for everyone in the workspace (leaving is in Settings). */
  needs: WorkspaceCapability | null;
  /** The line under the title; none for Licenses, whose title stands alone. */
  description(workspaceName: string): string | undefined;
};

const SECTIONS: Record<WorkspaceSection, SectionMeta> = {
  members: {
    label: "Members",
    icon: Users,
    needs: "workspace.members.read",
    description: name => `Manage who has access to ${name} and what they can do.`,
  },
  settings: {
    label: "Settings",
    icon: Settings,
    needs: null,
    description: name => `The name, ID and membership of ${name}.`,
  },
  licenses: {
    label: licenseStrings.nav.licenses,
    icon: CreditCard,
    // Open to everyone in the workspace, but offered only where there is something to show (see `licensesPartShown`).
    needs: null,
    description: () => undefined,
  },
  fleet: {
    label: "Fleet Management",
    icon: LayoutDashboard,
    // Offered only where Fleet is installed (see `visibleSections`); `fleet.read` also covers an Organization Admin.
    needs: "fleet.read",
    description: name => `The people, devices and miniapps of ${name}.`,
  },
};

/** The Fleet Management group's items, in sidebar order. */
const FLEET_NAV: ReadonlyArray<{ item: FleetItem; label: string; icon: LucideIcon }> = [
  { item: "overview", label: "Overview", icon: LayoutDashboard },
  { item: "people", label: "People", icon: UsersRound },
  { item: "devices", label: "Devices", icon: Glasses },
  { item: "miniapps", label: "Miniapps", icon: Boxes },
];

/** The Fleet item an address is on (its first `?fleet=` segment): a person's page is still People. */
export function fleetNavItem(search: string): { item: FleetItem; label: string } {
  const item = fleetItemOf(search);
  return FLEET_NAV.find(entry => entry.item === item) ?? FLEET_NAV[0]!;
}

/** The sidebar key of a Fleet item. */
export function fleetNavKey(item: FleetItem): string {
  return `fleet-${item}`;
}

/**
 * The sidebar, in groups. A group with nothing the viewer may open renders nothing, label included.
 * Fleet Management has its own group, behind `fleet.read` and Fleet being installed.
 */
export const NAV_GROUPS: ReadonlyArray<{ key: string; label?: string; sections: readonly WorkspaceSection[] }> = [
  { key: "workspace", sections: ["members", "settings", "licenses"] },
  { key: "fleet", label: "Fleet Management", sections: ["fleet"] },
];

/**
 * Whether the workspace's Licenses section is offered: `billing` (the person is offered the billing module
 * and holds `workspace.billing.manage`, see `billingOffered`), or the workspace has licenses to show them (an
 * Admin's every license, a member's own seats). A Private Cloud has neither, and shows nothing.
 */
export function licensesPartShown(billing: boolean, licenses: readonly LicenseView[] | undefined): boolean {
  return billing || (licenses?.length ?? 0) > 0;
}

/**
 * The sections the viewer's capabilities in this workspace open, in sidebar order. `licenses` says whether
 * Licenses is offered (see {@link licensesPartShown}).
 */
export function visibleSections(
  detail: Pick<WorkspaceDetail, "capabilities"> | undefined,
  options: { licenses?: boolean; fleet?: boolean } = {},
): WorkspaceSection[] {
  return NAV_GROUPS.flatMap(group => group.sections).filter(section => {
    if (section === "licenses") return options.licenses === true;
    if (section === "fleet") return options.fleet === true && can(detail, "fleet.read");
    const needs = SECTIONS[section].needs;
    return needs === null || can(detail, needs);
  });
}

/** The sidebar for this workspace and viewer. */
export function workspaceNav(workspaceId: string, sections: readonly WorkspaceSection[]): NavGroup[] {
  return NAV_GROUPS.map(group => ({
    key: group.key,
    label: group.label,
    items: group.sections
      .filter(section => sections.includes(section))
      .flatMap(section =>
        section === "fleet"
          ? FLEET_NAV.map(entry => ({ key: fleetNavKey(entry.item), label: entry.label, icon: entry.icon, href: fleetPath(workspaceId, entry.item) }))
          : [{
        key: section,
        label: SECTIONS[section].label,
        icon: SECTIONS[section].icon,
        href: workspacePath(workspaceId, section),
      }]),
  }));
}

/**
 * How the viewer appears in the switcher: their membership's role, as the member list shows it, with
 * "Organization Admin" when that is where their powers here come from ("Member · Organization Admin"),
 * or just "Organization Admin" when they are not a member at all.
 */
export function roleLabel(detail: WorkspaceDetail): string | null {
  const elevated = actsAsOrganizationAdmin(detail);
  if (!detail.membership) return elevated || effectiveRole(detail) ? "Organization Admin" : null;
  const role = ROLE_LABELS[detail.membership.role];
  return elevated ? `${role} · Organization Admin` : role;
}

/** Why the viewer can manage a workspace their own role would not let them, on the pages where it shows. */
export const ORGANIZATION_ADMIN_NOTE = "You can manage this workspace because you're an Organization Admin.";

/** Core answers 404 for a workspace that does not exist (or was deleted) and 403 for one the viewer is not in. */
export function isNoAccess(error: unknown): boolean {
  return error instanceof WorkspaceApiError && (error.status === 404 || error.status === 403);
}

/**
 * The Members list's licenses source (`WorkspaceMembersPanel`'s `licenses`): billing's catalog, which names and draws the
 * licenses a member holds. The list only shows them, so billing's status, the billing client and the portal's ways out
 * are not part of it. Nothing is asked until the list can use it: the viewer sees every license
 * (`workspace.licenses.read`) in a workspace that holds one. None where billing's catalog can't be read (a Private
 * Cloud), so the list is the admin portal's.
 */
export function useMembersLicenses({
  me,
  workspaceId,
  detail,
  licenses,
  enabled,
}: {
  me: PortalMe;
  workspaceId: string;
  detail: WorkspaceDetail | undefined;
  licenses: readonly LicenseView[] | undefined;
  /** The Members section is open. */
  enabled: boolean;
}): MembersLicenses | undefined {
  const scope = useMemo(() => workspaceScope(workspaceId), [workspaceId]);
  const wanted = enabled && me.modules.billingCatalog && can(detail, "workspace.licenses.read") && (licenses ?? []).some(license => !license.endedAt);
  const catalog = useQuery({ ...billingCatalogQuery(portalBillingApi, scope), enabled: wanted });

  return useMemo(
    // The one place the source is built.
    () => (me.modules.billingCatalog ? { catalog: catalog.data?.products } : undefined),
    [me.modules.billingCatalog, catalog.data],
  );
}

export function WorkspaceScreen({
  workspaceId,
  section,
  me,
}: {
  workspaceId: string;
  section: WorkspaceSection | null;
  me: PortalMe;
}) {
  const api = portalWorkspaceApi;
  const detail = useQuery(workspaceDetailQuery(api, workspaceId));
  const list = useQuery(workspaceListQuery(api));
  const licenses = useQuery(licensesQuery(api, workspaceId));
  const [inviting, setInviting] = useState(false);

  const data = detail.data;
  // Billing is for whoever manages it (Admins and Owners): a member sees the licenses they hold a seat in, no more.
  const billing = billingOffered(me, data);
  // A licenses address whose list failed to load still opens the page, which says so and offers to try again,
  // rather than sending the person elsewhere over a dropped connection.
  const licensesFailed = section === "licenses" && licenses.isError && licenses.data === undefined;
  const sections = data
    ? visibleSections(data, {
        licenses: licensesPartShown(billing, licenses.data) || licensesFailed,
        fleet: me.fleet?.installed === true,
      })
    : [];
  const search = useSearch();
  const active = section && sections.includes(section) ? section : null;
  // The address is the licenses page and the list has not answered yet: wait for it instead of leaving.
  const waitingForLicenses = data !== undefined && section === "licenses" && active === null && licenses.isPending;
  // The Members list shows each member's licenses.
  const membersLicenses = useMembersLicenses({ me, workspaceId, detail: data, licenses: licenses.data, enabled: active === "members" });

  useEffect(() => {
    if (data) rememberWorkspace(safeLocalStorage(), workspaceId);
  }, [data, workspaceId]);

  if (!data && detail.isError && isNoAccess(detail.error)) {
    return (
      <PortalShell current={null} nav={[]} activeKey={null}>
        <NotFoundMessage kind="workspace" />
      </PortalShell>
    );
  }

  // While the workspace loads, the switcher shows what the list already knows about it.
  const listed = list.data?.find(item => item.workspaceId === workspaceId);
  const name = data?.name ?? listed?.name ?? "Workspace";
  const current = {
    workspaceId,
    name,
    roleLabel: data ? roleLabel(data) : listed ? ROLE_LABELS[listed.membership.role] : null,
  };
  // An address for a section this viewer is not offered redirects at once; it does not borrow that section's title.
  const redirecting = data !== undefined && active === null && !waitingForLicenses;
  const shown = redirecting ? null : (active ?? section);
  const meta = shown ? SECTIONS[shown] : null;
  // Fleet's title is the item the viewer is on (Overview, People, ...), with no line under it: the module draws each page's own heading.
  const fleetItem = shown === "fleet" ? fleetNavItem(search) : undefined;

  function gone() {
    forgetWorkspace(safeLocalStorage(), workspaceId);
    navigate("/", { replace: true });
  }

  return (
    <PortalShell
      current={current}
      section={active ?? undefined}
      nav={workspaceNav(workspaceId, sections)}
      activeKey={active === "fleet" ? fleetNavKey(fleetItemOf(search)) : active}
      title={fleetItem?.label ?? meta?.label ?? name}
      description={fleetItem ? undefined : meta?.description(name)}
      headerAction={
        active === "members" && can(data, "workspace.members.manage") ? (
          <Button onClick={() => setInviting(true)}>
            <UserPlus className="size-4" />
            Invite
          </Button>
        ) : active === "licenses" && data ? (
          <LicensesHeaderActions workspaceId={workspaceId} me={me} detail={data} />
        ) : null
      }
    >
      {!data ? (
        detail.isError ? (
          <div role="alert" className="rounded-notice bg-error text-error-foreground flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            {errorMessage(detail.error)}
            <Button variant="secondary" size="sm" onClick={() => void detail.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" className="text-muted-foreground flex items-center gap-2.5 text-sm">
            <Spinner /> Loading workspace
          </div>
        )
      ) : waitingForLicenses ? (
        <div role="status" className="text-muted-foreground flex items-center gap-2.5 text-sm">
          <Spinner /> Loading licenses
        </div>
      ) : !active ? (
        // `/w/<id>`, or a section this viewer does not have: open the first one they do. The query stays, so a
        // deep link to a Fleet screen the viewer may not open lands somewhere real without losing the rest.
        <Redirect to={`${workspacePath(workspaceId, sections[0] ?? "settings")}${search}`} />
      ) : active === "members" ? (
        <div className="space-y-6">
          {actsAsOrganizationAdmin(data) ? <OrganizationAdminNote /> : null}
          <MembersTabs workspaceId={workspaceId} detail={data} licenses={membersLicenses} locale={portalBillingApi.locale} />
          <WorkspaceInviteDialog api={api} workspaceId={workspaceId} open={inviting} onClose={() => setInviting(false)} />
        </div>
      ) : active === "settings" ? (
        <div className="space-y-6">
          {actsAsOrganizationAdmin(data) && can(data, "workspace.settings.manage") ? <OrganizationAdminNote /> : null}
          <WorkspaceSettingsPanel
            api={api}
            workspaceId={workspaceId}
            onDeleted={gone}
            onLeft={gone}
            deleteNotice={STORE_DELETE_NOTICE}
          />
        </div>
      ) : active === "licenses" ? (
        <LicensesScreen workspaceId={workspaceId} me={me} detail={data} />
      ) : (
        <FleetScreen workspaceId={workspaceId} />
      )}
    </PortalShell>
  );
}

export type MembersTab = "members" | "invited";

/** "Members <n>" and "Invited <n>": the people in the workspace, and the invitations sent but not accepted. */
export function MembersTabs({
  workspaceId,
  detail,
  licenses,
  locale,
  initialTab = "members",
}: {
  workspaceId: string;
  detail: WorkspaceDetail;
  /** The Members list's licenses source, as `WorkspaceMembersPanel` takes it. */
  licenses?: MembersLicenses;
  locale?: string;
  initialTab?: MembersTab;
}) {
  const api = portalWorkspaceApi;
  const [tab, setTab] = useState<MembersTab>(initialTab);
  const mayManage = can(detail, "workspace.members.manage");
  const members = useQuery({ ...membersQuery(api, workspaceId), enabled: can(detail, "workspace.members.read") });
  const invited = useQuery({ ...invitationsQuery(api, workspaceId), enabled: mayManage });
  // Only someone who manages members sees who was invited; everyone else just has the member list.
  const tabs: Array<[MembersTab, string, number | undefined]> = [["members", "Members", members.data?.length]];
  if (mayManage) tabs.push(["invited", "Invited", invited.data?.length]);
  const shown = mayManage ? tab : "members";
  return (
    <div className="space-y-4">
      {tabs.length > 1 ? (
        <div role="tablist" aria-label="Members" className="bg-surface flex w-fit items-center gap-1 rounded-full border p-1">
          {tabs.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={shown === key}
              onClick={() => setTab(key)}
              className={`h-9 cursor-pointer whitespace-nowrap rounded-full px-4 text-sm font-semibold ${
                shown === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              {count === undefined ? null : <span className="text-muted-foreground ml-2">{count}</span>}
            </button>
          ))}
        </div>
      ) : null}
      {shown === "members" ? (
        <WorkspaceMembersPanel api={api} workspaceId={workspaceId} licenses={licenses} locale={locale} />
      ) : invited.data?.length === 0 ? (
        <p role="status" className="text-muted-foreground text-sm">
          No invitations are waiting. Invite someone to add them here.
        </p>
      ) : (
        // Resend and Revoke are on each row's menu.
        <WorkspacePendingInvitationsPanel api={api} workspaceId={workspaceId} />
      )}
    </div>
  );
}

function OrganizationAdminNote() {
  return (
    <p role="note" className="rounded-notice bg-info text-info-foreground flex items-start gap-2.5 px-4 py-3 text-sm">
      <ShieldCheck className="mt-0.5 size-4 shrink-0" />
      {ORGANIZATION_ADMIN_NOTE}
    </p>
  );
}
