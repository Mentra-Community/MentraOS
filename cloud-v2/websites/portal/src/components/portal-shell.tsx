import { useQuery } from "@tanstack/react-query";
import {
  CreateWorkspaceDialog,
  invitationPreviewQuery,
  ROLE_LABELS,
  workspaceListQuery,
  type InvitationPreview,
} from "@mentra/workspace-ui";
import { useState, type ReactNode } from "react";
import { AppShell, type NavGroup } from "@/components/app-shell";
import { WorkspaceSwitcher, type SwitcherInvitation, type SwitcherWorkspace } from "@/components/workspace-switcher";
import { navigate } from "@/lib/navigation";
import { creationNotice, portalWorkspaceApi, usePortal } from "@/lib/portal";
import { INVITATION_PATH, workspacePath, type WorkspaceSection } from "@/lib/routes";

/** The pending invitation of this tab as a switcher entry: looked up by its token, which is never shown. */
export function useSwitcherInvitations(): SwitcherInvitation[] {
  const { inviteToken } = usePortal();
  const preview = useQuery({ ...invitationPreviewQuery(portalWorkspaceApi, inviteToken ?? ""), enabled: inviteToken !== null });
  if (!inviteToken) return [];
  return [switcherInvitation(preview.data, preview.isError)];
}

export function switcherInvitation(preview: InvitationPreview | undefined, failed: boolean): SwitcherInvitation {
  return {
    key: "link",
    label: preview ? `Join ${preview.workspaceName}` : "Invitation",
    detail: preview ? `As ${ROLE_LABELS[preview.role]}` : failed ? "No longer valid" : null,
    href: INVITATION_PATH,
  };
}

/**
 * `AppShell` with the workspace switcher wired to the person's workspaces, this tab's invitation and the
 * create-workspace dialog. A new workspace opens as soon as it exists.
 */
export function PortalShell({
  current,
  section,
  nav,
  activeKey,
  title,
  description,
  headerAction,
  children,
}: {
  current: Omit<SwitcherWorkspace, "href"> | null;
  /** The section open now: switching workspaces keeps it when the other workspace has it. */
  section?: WorkspaceSection;
  nav: readonly NavGroup[];
  activeKey: string | null;
  title?: string;
  description?: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const portal = usePortal();
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const invitations = useSwitcherInvitations();
  const [creating, setCreating] = useState(false);

  const workspaces: SwitcherWorkspace[] | undefined = list.data?.map(item => ({
    workspaceId: item.workspaceId,
    name: item.name,
    roleLabel: ROLE_LABELS[item.membership.role],
    href: workspacePath(item.workspaceId, section),
  }));

  return (
    <AppShell
      switcher={
        <WorkspaceSwitcher
          current={current ? { ...current, href: workspacePath(current.workspaceId, section) } : null}
          workspaces={workspaces}
          invitations={invitations}
          canCreate={portal.creation.allowed}
          createNotice={creationNotice(portal.creation)}
          onCreate={() => setCreating(true)}
          listFailed={list.isError}
          onRetry={() => void list.refetch()}
        />
      }
      nav={nav}
      activeKey={activeKey}
      title={title}
      description={description}
      headerAction={headerAction}
      userEmail={portal.userEmail}
      onSignOut={portal.signOut}
      signingOut={portal.signingOut}
    >
      {children}
      <CreateWorkspaceDialog
        api={portalWorkspaceApi}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={created => navigate(workspacePath(created.workspaceId))}
      />
    </AppShell>
  );
}
