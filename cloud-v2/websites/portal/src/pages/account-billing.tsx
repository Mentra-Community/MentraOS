/**
 * The person's own Billing page: `/account/billing`.
 *
 * It is not about a workspace. The sidebar is the personal layout: Your account, with Billing under it, and
 * a way back to one of the person's workspaces if they have one. A person in no workspace gets the page all
 * the same, with no workspace navigation. The page is `PersonalBillingView` (`@mentra/workspace-ui`) over the
 * person's own licenses, with its header buttons in the title bar, and it is offered only where the person is
 * offered billing (the route in App.tsx).
 */

import { useQuery } from "@tanstack/react-query";
import { licenseStrings, PersonalBillingHeaderActions, PersonalBillingView, workspaceListQuery, type NavGroup } from "@mentra/workspace-ui";
import { ArrowLeft, CreditCard } from "lucide-react";
import { PortalShell, useBareWorkspaceId } from "@/components/portal-shell";
import { setQueryParam, useSearch } from "@/lib/navigation";
import { portalBillingApi, portalNavigateOut, portalWorkspaceApi } from "@/lib/portal";
import { ACCOUNT_BILLING_PATH } from "@/lib/routes";
import { purchaseParam } from "./licenses";

const t = licenseStrings;

/** The personal sidebar: Your account with Billing, then the way back to `workspace` when the person has one. */
export function accountNav(workspace: { workspaceId: string; name: string } | null): NavGroup[] {
  return [
    {
      key: "account",
      label: t.nav.yourAccount,
      items: [{ key: "billing", label: t.nav.billing, icon: CreditCard, href: ACCOUNT_BILLING_PATH }],
    },
    {
      key: "workspace",
      items: workspace
        ? [{ key: "workspace", label: t.nav.backTo(workspace.name), icon: ArrowLeft, href: "/" }]
        : [],
    },
  ];
}

export function AccountBillingScreen() {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  // The workspace `/` would open: the last-used one while it is still theirs, else the first.
  const homeId = useBareWorkspaceId();
  const home = list.data?.find(item => item.workspaceId === homeId) ?? null;
  // What the view and its header actions are both given, so that billing is asked once.
  const shared = { billing: portalBillingApi, purchaseId: purchaseParam(useSearch()), navigateOut: portalNavigateOut };

  return (
    <PortalShell
      current={null}
      nav={accountNav(home)}
      navLabel="Account"
      activeKey="billing"
      title={t.personal.title}
      description={t.personal.description}
      headerAction={<PersonalBillingHeaderActions {...shared} />}
    >
      <PersonalBillingView
        {...shared}
        // The banner was dismissed: the address loses `?purchase=` in place, so Back does not return to the banner.
        onPurchaseDone={() => setQueryParam("purchase", null, { replace: true })}
      />
    </PortalShell>
  );
}
