/**
 * Licenses in one workspace: `/w/<workspaceId>/licenses`.
 *
 * The page is `WorkspaceLicensesView` (`@mentra/workspace-ui`): one card per license with its seats, dates, cost and
 * billing actions, the page total, and buying, as far as the viewer's role and what the portal offers them allow.
 * Its header buttons ("Billing & invoices ↗", "Buy a product") are `WorkspaceLicensesHeaderActions`, which the
 * workspace page puts in the title bar; both are given the same props, so billing is asked once.
 *
 * The portal wires the view to what it owns: Core's workspace API, billing's client in the portal's locale, `me`
 * (which says whether billing's catalog can be read, and whether this viewer is offered billing), the
 * `?purchase=` of a return from checkout, and the two ways out to a hosted page. The view and its header stay
 * mounted while a request for a hosted page is out. The portal draws everything from billing's data and links out for
 * anything that needs a payment page.
 */

import { useQueryClient } from "@tanstack/react-query";
import type { WorkspaceDetail } from "@mentra/workspace-contract";
import {
  can,
  WorkspaceLicensesHeaderActions,
  WorkspaceLicensesView,
  type WorkspaceLicensesHeaderActionsProps,
} from "@mentra/workspace-ui";
import type { PortalMe } from "@/lib/api";
import { setQueryParam, useSearch } from "@/lib/navigation";
import { PORTAL_ME_KEY, portalBillingApi, portalNavigateOut, portalWorkspaceApi } from "@/lib/portal";

/** Whether the viewer is offered the workspace's billing: billing is ready for them and their role may manage it (`workspace.billing.manage`: Admins and Owners). */
export function billingOffered(me: PortalMe, detail: Pick<WorkspaceDetail, "capabilities"> | undefined): boolean {
  return me.modules.billing && can(detail, "workspace.billing.manage");
}

/** The `?purchase=` a checkout returned with, from the address's query string; null when there is none. */
export function purchaseParam(search: string): string | null {
  return new URLSearchParams(search).get("purchase") || null;
}

/**
 * What the view and its header actions are given. The catalog is readable wherever billing is ready (`me.modules.billingCatalog`),
 * which names the licenses for anyone who may see them; money, dates, actions and buying are for whoever is offered billing.
 */
export function licensesPageProps(
  me: PortalMe,
  workspaceId: string,
  detail: Pick<WorkspaceDetail, "capabilities"> | undefined,
  purchaseId: string | null,
): WorkspaceLicensesHeaderActionsProps {
  return {
    api: portalWorkspaceApi,
    billing: portalBillingApi,
    workspaceId,
    offer: { catalog: me.modules.billingCatalog, manage: billingOffered(me, detail) },
    purchaseId,
    navigateOut: portalNavigateOut,
  };
}

interface LicensesProps {
  workspaceId: string;
  me: PortalMe;
  detail: WorkspaceDetail;
}

/** The page's content. */
export function LicensesScreen({ workspaceId, me, detail }: LicensesProps) {
  const purchaseId = purchaseParam(useSearch());
  const client = useQueryClient();
  return (
    <WorkspaceLicensesView
      {...licensesPageProps(me, workspaceId, detail, purchaseId)}
      // The banner was dismissed: the address loses `?purchase=` in place, so Back does not return to the banner.
      onPurchaseDone={() => setQueryParam("purchase", null, { replace: true })}
      // Retry also asks who the person is again: a page opened before billing was ready (`billingCatalog` false, with
      // licenses to name) can only recover when `me` says it is.
      onRetry={() => void client.invalidateQueries({ queryKey: PORTAL_ME_KEY })}
    />
  );
}

/** The page's header buttons, for the title bar. They draw nothing where there is nothing to act on. */
export function LicensesHeaderActions({ workspaceId, me, detail }: LicensesProps) {
  const purchaseId = purchaseParam(useSearch());
  return <WorkspaceLicensesHeaderActions {...licensesPageProps(me, workspaceId, detail, purchaseId)} />;
}
