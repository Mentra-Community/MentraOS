import { useQuery } from "@tanstack/react-query";
import {
  AppShell,
  CenteredLayout,
  licenseStrings,
  ROLE_LABELS,
  WorkspaceSwitcher,
  workspaceListQuery,
  type ExternalNavItem,
  type NavGroup,
  type NavItem,
  type SwitcherCurrent,
  type SwitcherInvitation,
  type SwitcherWorkspace,
} from "@mentra/workspace-ui";
import { CodeXml, CreditCard } from "lucide-react";
import type { ReactNode } from "react";
import { SwitcherInvitationActions } from "@/components/pending-invitation";
import type { PendingInvitation } from "@/lib/invitations";
import { Link } from "@/lib/navigation";
import { portalWorkspaceApi, usePortal } from "@/lib/portal";
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
export function portalLinks(developerConsoleUrl: string | null): ExternalNavItem[] {
  if (!developerConsoleUrl) return [];
  return [{ key: "developer-console", label: "Developer Console", icon: CodeXml, href: developerConsoleUrl }];
}

/** The account menu's pages: the person's own Billing, where billing is offered to them. */
export function accountItems(billing: boolean): NavItem[] {
  if (!billing) return [];
  return [{ key: "billing", label: licenseStrings.nav.billing, icon: CreditCard, href: ACCOUNT_BILLING_PATH }];
}

/**
 * The shared `AppShell` as the portal's: named Mentra Portal, on MentraOS, with the portal's History-API
 * `Link`, the workspace switcher wired to the person's workspace and this tab's invitation, and the links
 * out of the portal. There is no way to create a second workspace from here.
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
  current: SwitcherCurrent | null;
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

  const workspaces: SwitcherWorkspace[] | undefined = list.data?.map(item => ({
    workspaceId: item.workspaceId,
    name: item.name,
    roleLabel: ROLE_LABELS[item.membership.role],
    href: workspacePath(item.workspaceId, section),
  }));

  return (
    <AppShell
      brandTitle="Mentra Portal"
      brandSubtitle="MentraOS"
      linkComponent={Link}
      switcher={
        <WorkspaceSwitcher
          current={current}
          workspaces={workspaces}
          invitations={invitations}
          canCreate={false}
          createNotice={null}
          onCreate={() => {}}
          // A person belongs to one workspace, so the portal never offers a second. The first one is made on the
          // first-run screen (pages/welcome).
          hideCreate
          listFailed={list.isError}
          onRetry={() => void list.refetch()}
          linkComponent={Link}
        />
      }
      nav={nav}
      navLabel={navLabel}
      active={item => item.key === activeKey}
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
    </AppShell>
  );
}

/** The shared `CenteredLayout` with the portal's account: who is signed in, and Sign out. */
export function PortalCenteredLayout({ children }: { children: ReactNode }) {
  const portal = usePortal();
  return (
    <CenteredLayout userEmail={portal.userEmail} onSignOut={portal.signOut} signingOut={portal.signingOut}>
      {children}
    </CenteredLayout>
  );
}
