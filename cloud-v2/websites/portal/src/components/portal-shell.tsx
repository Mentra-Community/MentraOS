import { useQuery } from "@tanstack/react-query";
import {
  AppShell,
  CenteredLayout,
  Count,
  WorkspaceLabel,
  workspaceListQuery,
  type ExternalNavItem,
  type NavGroup,
  type SwitcherCurrent,
} from "@mentra/workspace-ui";
import { CodeXml, Mail } from "lucide-react";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { safeLocalStorage } from "@/lib/api";
import { Link } from "@/lib/navigation";
import { portalWorkspaceApi, usePortal } from "@/lib/portal";
import { currentWorkspace, forgetWorkspace, INVITATION_PATH, recallWorkspace, rememberWorkspace } from "@/lib/routes";

/**
 * Under the workspace: a link to `/invitation` while the person has invitations to answer ("2 pending
 * invitations"), and nothing otherwise. The invitations themselves, with Accept and Decline, are on that page.
 */
export function InvitationsLink() {
  const { invitations } = usePortal();
  const count = invitations?.length ?? 0;
  if (count === 0) return null;
  return (
    <Link
      href={INVITATION_PATH}
      className="bg-info text-info-foreground hover:bg-hover flex items-center gap-2.5 rounded-full px-4 py-2 text-sm font-semibold"
    >
      <Mail className="size-4 shrink-0" />
      <span className="flex-1">{count === 1 ? "Pending invitation" : "Pending invitations"}</span>
      <Count>{count}</Count>
    </Link>
  );
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

/**
 * The sidebar's links out of the portal: this environment's Developer Console, where there is one. The sidebar
 * shows none of them: the Developer Console link is hidden.
 */
export function portalLinks(developerConsoleUrl: string | null): ExternalNavItem[] {
  if (!developerConsoleUrl) return [];
  return [{ key: "developer-console", label: "Developer Console", icon: CodeXml, href: developerConsoleUrl }];
}

/**
 * The shared `AppShell` as the portal's: named Mentra Portal, on MentraOS, with the portal's History-API
 * `Link`, the person's one workspace (name and role) at the top of the sidebar, and a link to their invitations
 * under it. A person belongs to one workspace: there is nothing to switch to and no way to create another from
 * here.
 */
export function PortalShell({
  current,
  nav,
  navLabel,
  activeKey,
  title,
  description,
  headerAction,
  children,
}: {
  current: SwitcherCurrent | null;
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
  const invitations = <InvitationsLink />;

  return (
    <AppShell
      brandTitle="Mentra Portal"
      brandSubtitle="MentraOS"
      linkComponent={Link}
      switcher={
        current ? (
          <WorkspaceLabel current={current} invitations={invitations} />
        ) : (
          // No workspace (billing, a missing page): just the invitations, when there are any.
          invitations
        )
      }
      nav={nav}
      navLabel={navLabel}
      active={item => item.key === activeKey}
      title={title}
      description={description}
      headerAction={headerAction}
      userEmail={portal.userEmail}
      userName={portal.userName}
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
    <CenteredLayout userEmail={portal.userEmail} userName={portal.userName} onSignOut={portal.signOut} signingOut={portal.signingOut}>
      {children}
    </CenteredLayout>
  );
}
