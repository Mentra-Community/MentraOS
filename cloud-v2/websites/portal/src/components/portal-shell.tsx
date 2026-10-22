import { useQuery } from "@tanstack/react-query";
import {
  AppShell,
  CenteredLayout,
  CreateWorkspaceDialog,
  ROLE_LABELS,
  WorkspaceSwitcher,
  workspaceListQuery,
  type ExternalNavItem,
  type NavGroup,
  type SwitcherCurrent,
  type SwitcherInvitation,
  type SwitcherWorkspace,
} from "@mentra/workspace-ui";
import { CodeXml } from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { SwitcherInvitationActions } from "@/components/pending-invitation";
import { safeLocalStorage } from "@/lib/api";
import type { PendingInvitation } from "@/lib/invitations";
import { Link, navigate } from "@/lib/navigation";
import { creationNotice, portalWorkspaceApi, usePortal } from "@/lib/portal";
import { currentWorkspace, forgetWorkspace, recallWorkspace, rememberWorkspace, sectionHref, type WorkspaceSection } from "@/lib/routes";

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

/**
 * The last workspace this tab opened from the person's list. It is read from the browser's storage once, when the
 * tab starts, and from then on changes only when this tab remembers or forgets one itself, so another tab's pick
 * never moves this one (the bare address means the same workspace for as long as this tab is open).
 */
export interface TabWorkspace {
  remembered: string | null;
  remember(workspaceId: string): void;
  forget(workspaceId: string): void;
}

const TabWorkspaceContext = createContext<TabWorkspace | null>(null);

export function TabWorkspaceProvider({ children }: { children: ReactNode }) {
  const [remembered, setRemembered] = useState(() => recallWorkspace(safeLocalStorage()));
  const value = useMemo<TabWorkspace>(
    () => ({
      remembered,
      remember(workspaceId) {
        rememberWorkspace(safeLocalStorage(), workspaceId);
        setRemembered(workspaceId);
      },
      forget(workspaceId) {
        forgetWorkspace(safeLocalStorage(), workspaceId);
        setRemembered(current => (current === workspaceId ? null : current));
      },
    }),
    [remembered],
  );
  return <TabWorkspaceContext.Provider value={value}>{children}</TabWorkspaceContext.Provider>;
}

/** This tab's {@link TabWorkspace}. Outside a `TabWorkspaceProvider` it is the storage as of the first render. */
export function useTabWorkspace(): TabWorkspace {
  const tab = useContext(TabWorkspaceContext);
  const [initial] = useState(() => recallWorkspace(safeLocalStorage()));
  return (
    tab ?? {
      remembered: initial,
      remember: workspaceId => rememberWorkspace(safeLocalStorage(), workspaceId),
      forget: workspaceId => forgetWorkspace(safeLocalStorage(), workspaceId),
    }
  );
}

/**
 * The workspace the bare address (`/members`, without `?workspace=`) opens for this person: the last one this tab opened
 * from their list while it is still there, else their first. Null while the list loads, and for a person in none.
 */
export function useBareWorkspaceId(): string | null {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const { remembered } = useTabWorkspace();
  return list.data ? currentWorkspace({ param: null, remembered, workspaces: list.data }) : null;
}

/** The sidebar's links out of the portal: this environment's Developer Console, where there is one. */
export function portalLinks(developerConsoleUrl: string | null): ExternalNavItem[] {
  if (!developerConsoleUrl) return [];
  return [{ key: "developer-console", label: "Developer Console", icon: CodeXml, href: developerConsoleUrl }];
}

/**
 * The shared `AppShell` as the portal's: named Mentra Portal, on MentraOS, with the portal's History-API
 * `Link`, the workspace switcher wired to the person's workspaces, this tab's invitation and the
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
  const bareWorkspaceId = useBareWorkspaceId();
  const [creating, setCreating] = useState(false);

  const workspaces: SwitcherWorkspace[] | undefined = list.data?.map(item => ({
    workspaceId: item.workspaceId,
    name: item.name,
    roleLabel: ROLE_LABELS[item.membership.role],
    href: sectionHref(section ?? null, item.workspaceId, bareWorkspaceId),
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
          canCreate={portal.creation.allowed}
          createNotice={creationNotice(portal.creation)}
          onCreate={() => setCreating(true)}
          listFailed={list.isError}
          onRetry={() => void list.refetch()}
          linkComponent={Link}
        />
      }
      nav={nav}
      navLabel={navLabel}
      active={item => item.key === activeKey}
      links={portalLinks(portal.developerConsoleUrl)}
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
        onCreated={created => navigate(sectionHref(null, created.workspaceId, null))}
      />
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
