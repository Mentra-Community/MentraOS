/**
 * One workspace in the workspace portal: `/w/<workspaceId>/<section>`, framed by the sidebar.
 *
 * The sections are the shared Core workspace screens (`@mentra/workspace-ui`): Members (the member list
 * with the pending invitations under it, and Invite in the header), Settings and the Audit log. The
 * sidebar offers only the sections the viewer's capabilities open; every request is still checked by
 * Core. A workspace that does not exist, or that the viewer may not see, is one "not found" page.
 */

import { useQuery } from "@tanstack/react-query";
import type { WorkspaceCapability, WorkspaceDetail } from "@mentra/workspace-contract";
import {
  actsAsOrganizationAdmin,
  Button,
  can,
  effectiveRole,
  errorMessage,
  ROLE_LABELS,
  Spinner,
  WorkspaceApiError,
  WorkspaceAuditPanel,
  WorkspaceInviteDialog,
  WorkspaceMembersPanel,
  WorkspacePendingInvitationsPanel,
  WorkspaceSettingsPanel,
  workspaceDetailQuery,
  workspaceListQuery,
} from "@mentra/workspace-ui";
import { ScrollText, Settings, ShieldCheck, UserPlus, Users, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { NavGroup } from "@/components/app-shell";
import { PortalShell } from "@/components/portal-shell";
import { safeLocalStorage } from "@/lib/api";
import { navigate, Redirect } from "@/lib/navigation";
import { portalWorkspaceApi, STORE_DELETE_NOTICE } from "@/lib/portal";
import { forgetWorkspace, rememberWorkspace, workspacePath, type WorkspaceSection } from "@/lib/routes";
import { NotFoundMessage } from "./not-found";

type SectionMeta = {
  label: string;
  icon: LucideIcon;
  /** The capability that opens it; null for everyone in the workspace (leaving is in Settings). */
  needs: WorkspaceCapability | null;
  description(workspaceName: string): string;
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
  audit: {
    label: "Audit log",
    icon: ScrollText,
    needs: "workspace.audit.read",
    description: name => `Every change made in ${name}, newest first.`,
  },
};

/**
 * The sidebar, in groups. A group with nothing the viewer may open renders nothing, label included.
 * Fleet (devices and deployments, behind `fleet.read`) joins as its own group in a later phase.
 */
export const NAV_GROUPS: ReadonlyArray<{ key: string; label?: string; sections: readonly WorkspaceSection[] }> = [
  { key: "workspace", sections: ["members", "settings", "audit"] },
  { key: "fleet", label: "Fleet", sections: [] },
];

/** The sections the viewer's capabilities in this workspace open, in sidebar order. */
export function visibleSections(detail: Pick<WorkspaceDetail, "capabilities"> | undefined): WorkspaceSection[] {
  return NAV_GROUPS.flatMap(group => group.sections).filter(section => {
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
      .map(section => ({
        key: section,
        label: SECTIONS[section].label,
        icon: SECTIONS[section].icon,
        href: workspacePath(workspaceId, section),
      })),
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

export function WorkspaceScreen({ workspaceId, section }: { workspaceId: string; section: WorkspaceSection | null }) {
  const api = portalWorkspaceApi;
  const detail = useQuery(workspaceDetailQuery(api, workspaceId));
  const list = useQuery(workspaceListQuery(api));
  const [inviting, setInviting] = useState(false);

  const data = detail.data;
  const sections = data ? visibleSections(data) : [];
  const active = section && sections.includes(section) ? section : null;

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
  const shown = active ?? section;
  const meta = shown ? SECTIONS[shown] : null;

  function gone() {
    forgetWorkspace(safeLocalStorage(), workspaceId);
    navigate("/", { replace: true });
  }

  return (
    <PortalShell
      current={current}
      section={active ?? undefined}
      nav={workspaceNav(workspaceId, sections)}
      activeKey={active}
      title={meta?.label ?? name}
      description={meta?.description(name)}
      headerAction={
        active === "members" && can(data, "workspace.members.manage") ? (
          <Button onClick={() => setInviting(true)}>
            <UserPlus className="size-4" />
            Invite
          </Button>
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
      ) : !active ? (
        // `/w/<id>`, or a section this viewer does not have: open the first one they do.
        <Redirect to={workspacePath(workspaceId, sections[0] ?? "settings")} />
      ) : active === "members" ? (
        <div className="space-y-6">
          {actsAsOrganizationAdmin(data) ? <OrganizationAdminNote /> : null}
          <WorkspaceMembersPanel api={api} workspaceId={workspaceId} />
          <WorkspacePendingInvitationsPanel api={api} workspaceId={workspaceId} />
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
      ) : (
        <WorkspaceAuditPanel api={api} workspaceId={workspaceId} />
      )}
    </PortalShell>
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
