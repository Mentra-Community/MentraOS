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
  can,
  effectiveRole,
  errorMessage,
  ROLE_LABELS,
  WorkspaceApiError,
  WorkspaceAuditPanel,
  WorkspaceInviteDialog,
  WorkspaceMembersPanel,
  WorkspacePendingInvitationsPanel,
  WorkspaceSettingsPanel,
  workspaceDetailQuery,
  workspaceListQuery,
} from "@mentra/workspace-ui";
import { Loader2, ScrollText, Settings, UserPlus, Users, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { NavGroup } from "@/components/app-shell";
import { PortalShell } from "@/components/portal-shell";
import { Button } from "@/components/ui/button";
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

/** How the viewer appears in the switcher: their role, or "Organization Admin" when they are not a member. */
export function roleLabel(detail: WorkspaceDetail): string | null {
  const role = effectiveRole(detail);
  if (!role) return null;
  return detail.membership === null ? "Organization Admin" : ROLE_LABELS[role];
}

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
          <Button
            className="h-9 rounded-full bg-[#111217] px-4 text-white hover:bg-[#25262c]"
            onClick={() => setInviting(true)}
          >
            <UserPlus className="size-4" />
            Invite
          </Button>
        ) : null
      }
    >
      {!data ? (
        detail.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[14px] bg-[#fff3f1] px-4 py-3 text-sm text-[#a64235]">
            {errorMessage(detail.error)}
            <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" className="flex items-center gap-3 text-sm text-[#68746d]">
            <Loader2 className="size-4 animate-spin" /> Loading workspace
          </div>
        )
      ) : !active ? (
        // `/w/<id>`, or a section this viewer does not have: open the first one they do.
        <Redirect to={workspacePath(workspaceId, sections[0] ?? "settings")} />
      ) : active === "members" ? (
        <div className="space-y-6">
          <WorkspaceMembersPanel api={api} workspaceId={workspaceId} />
          <WorkspacePendingInvitationsPanel api={api} workspaceId={workspaceId} />
          <WorkspaceInviteDialog api={api} workspaceId={workspaceId} open={inviting} onClose={() => setInviting(false)} />
        </div>
      ) : active === "settings" ? (
        <WorkspaceSettingsPanel
          api={api}
          workspaceId={workspaceId}
          onDeleted={gone}
          onLeft={gone}
          deleteNotice={STORE_DELETE_NOTICE}
        />
      ) : (
        <WorkspaceAuditPanel api={api} workspaceId={workspaceId} />
      )}
    </PortalShell>
  );
}
