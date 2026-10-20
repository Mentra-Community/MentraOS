import { useQuery } from "@tanstack/react-query";
import { CreateWorkspaceDialog, ROLE_LABELS, workspaceListQuery } from "@mentra/workspace-ui";
import { CodeXml, CreditCard } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AppShell, type NavGroup, type NavItem } from "@/components/app-shell";
import { SwitcherInvitationActions } from "@/components/pending-invitation";
import { WorkspaceSwitcher, type SwitcherInvitation, type SwitcherWorkspace } from "@/components/workspace-switcher";
import type { PendingInvitation } from "@/lib/invitations";
import { navigate } from "@/lib/navigation";
import { creationNotice, portalWorkspaceApi, usePortal } from "@/lib/portal";
import { ACCOUNT_BILLING_PATH, workspacePath, type WorkspaceSection } from "@/lib/routes";

/**
 * The person's valid invitations as switcher entries, with Accept and Dismiss: the one this tab's link
 * holds and those addressed to their verified email, each once (lib/invitations). Nothing while they are
 * being looked up, and never a link that is no longer valid.
 */
export function useSwitcherInvitations(): SwitcherInvitation[] {
  const { invitations } = usePortal();
  return (invitations ?? []).map(switcherInvitation);
}

export function switcherInvitation(invitation: PendingInvitation): SwitcherInvitation {
  const { preview } = invitation;
  return {
    key: preview.invitationId,
    label: `Join ${preview.workspaceName}`,
    detail: invitation.forOtherAccount
      ? `For ${preview.email}`
      : [ROLE_LABELS[preview.role], preview.invitedByEmail ? `from ${preview.invitedByEmail}` : null].filter(Boolean).join(" · "),
    actions: <SwitcherInvitationActions invitation={invitation} />,
  };
}

/** The sidebar's links out of the portal: this environment's Developer Console, where there is one. */
export function portalLinks(developerConsoleUrl: string | null): NavItem[] {
  if (!developerConsoleUrl) return [];
  return [{ key: "developer-console", label: "Developer Console", icon: CodeXml, href: developerConsoleUrl }];
}

/** The account menu's pages: the person's own Billing, where the billing module is offered to them. */
export function accountItems(billing: boolean): NavItem[] {
  if (!billing) return [];
  return [{ key: "billing", label: "Billing", icon: CreditCard, href: ACCOUNT_BILLING_PATH }];
}

/**
 * `AppShell` with the workspace switcher wired to the person's workspaces, this tab's invitation and the
 * create-workspace dialog, and the links out of the portal. A new workspace opens as soon as it exists.
 */
export function PortalShell({
  current,
  section,
  nav,
  navLabel,
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
  /** The navigation's name for assistive technology; "Workspace" unless it is not a workspace's. */
  navLabel?: string;
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
      navLabel={navLabel}
      activeKey={activeKey}
      links={portalLinks(portal.developerConsoleUrl)}
      accountItems={accountItems(portal.modules.billing)}
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
