import {
  AppShell,
  CenteredLayout,
  Count,
  licenseStrings,
  WorkspaceLabel,
  type ExternalNavItem,
  type NavGroup,
  type NavItem,
  type SwitcherCurrent,
} from "@mentra/workspace-ui";
import { CodeXml, CreditCard, Mail } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "@/lib/navigation";
import { usePortal } from "@/lib/portal";
import { ACCOUNT_BILLING_PATH, INVITATION_PATH } from "@/lib/routes";

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
 * `Link`, the person's one workspace (name and role) at the top of the sidebar, a link to their invitations
 * under it, and the links out of the portal. A person belongs to one workspace: there is nothing to switch
 * to and no way to create another from here.
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
      links={portalLinks(portal.developerConsoleUrl)}
      accountItems={accountItems(portal.modules.billing)}
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
