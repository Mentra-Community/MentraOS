/**
 * The person's own Billing page: `/account/billing`.
 *
 * It is not about a workspace. The sidebar is the personal layout: Your account, with Billing under it, and
 * a way back to one of the person's workspaces if they have one. A person in no workspace gets the page all
 * the same, with no workspace navigation. The billing module is mounted with the person's scope, which is
 * their own personal licenses, and the page is offered only where the person is offered billing.
 */

import { useQuery } from "@tanstack/react-query";
import { workspaceListQuery, type NavGroup } from "@mentra/workspace-ui";
import { ArrowLeft, CreditCard } from "lucide-react";
import type { ReactElement } from "react";
import { PortalModuleHost } from "@/components/portal-module-host";
import { PortalShell } from "@/components/portal-shell";
import { safeLocalStorage, type PortalMe } from "@/lib/api";
import { portalWorkspaceApi } from "@/lib/portal";
import { ACCOUNT_BILLING_PATH, homeWorkspace, recallWorkspace, workspacePath } from "@/lib/routes";

/** The billing module for the person's own account, or nothing where the person is not offered billing. */
export function accountBillingPart(me: PortalMe): ReactElement | null {
  if (!me.modules.billing) return null;
  return <PortalModuleHost module="billing" me={me} scope={{ kind: "person" }} />;
}

/** The personal sidebar: Your account with Billing, then the way back to `workspace` when the person has one. */
export function accountNav(workspace: { workspaceId: string; name: string } | null): NavGroup[] {
  return [
    {
      key: "account",
      label: "Your account",
      items: [{ key: "billing", label: "Billing", icon: CreditCard, href: ACCOUNT_BILLING_PATH }],
    },
    {
      key: "workspace",
      items: workspace
        ? [{ key: "workspace", label: `Back to ${workspace.name}`, icon: ArrowLeft, href: workspacePath(workspace.workspaceId) }]
        : [],
    },
  ];
}

export function AccountBillingScreen({ me }: { me: PortalMe }) {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  // The workspace `/` would open: the last-used one while it is still theirs, else the first.
  const homeId = list.data ? homeWorkspace(list.data, recallWorkspace(safeLocalStorage())) : null;
  const home = list.data?.find(item => item.workspaceId === homeId) ?? null;

  return (
    <PortalShell
      current={null}
      nav={accountNav(home)}
      navLabel="Account"
      activeKey="billing"
      title="Billing"
      description="Licenses you buy for yourself, apart from any workspace's."
    >
      {accountBillingPart(me)}
    </PortalShell>
  );
}
