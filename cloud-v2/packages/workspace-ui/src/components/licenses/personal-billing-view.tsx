/**
 * The personal Billing page (`/account/billing`), composed from the same pieces as the Licenses page: billing's
 * catalog and status for the person's own account, joined into one card per license. It belongs to the account, not
 * to a workspace, so it has no Core read at all: a person's licenses are billing's alone, and a card has no seats.
 *
 * It needs a `QueryClientProvider` above it, like every screen of this package: it reads billing through TanStack
 * Query, and refreshes there what a purchase or a hosted page changes. The host shows it only to someone offered
 * billing, so both reads are always wanted. It draws the page's content only: the title ("Billing") and the
 * description (`licenseStrings.personal`) belong to the portal's frame, and so do "Billing & invoices ↗" and "Buy a
 * license": `PersonalBillingHeaderActions` is the component for the frame's title bar. It reads under the same keys as
 * the view, owns the catalog dialog, and draws nothing where there is nothing to act on.
 *
 * - With nothing yet: "Buy a license for yourself", the products a person can buy, each with its price. Buy goes
 *   straight to payment, with no seats step.
 * - With licenses: one card each (status, Renews or Ends, cost and a "…" menu), and the same amber notice and
 *   deadline as a workspace's for a failed payment.
 * - Back from checkout: the banner ("Payment received", then "<product> is ready"), polled like the workspace's.
 * - Billing can't be read, or an answer doesn't match the contract: "Billing is unavailable", with Retry.
 *
 * Cards stay mounted through every refetch (see `WorkspaceLicensesView`): keyed by license id, never swapped for a
 * loading state once the page has loaded.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { BillingApi } from "../../billing-api";
import { ACCOUNT_SCOPE } from "../../billing-scope";
import { catalogForOwner, joinLicenses, listedAction } from "../../lib/license-join";
import type { BillingStatus } from "@mentra/workspace-contract/portal-billing";
import { billingCatalogQuery, billingStatusQuery, statusPlaceholder } from "../../queries";
import { licenseStrings as t } from "../../strings/licenses";
import { Loading, Restricted } from "../common";
import { LicensesUnavailable, PURCHASE_POLL_MS, PURCHASE_TIMEOUT_MS, PurchaseBanner, TestModeBanner } from "./banners";
import { canBuy, CatalogDialog, CatalogGrid } from "./catalog";
import { useHostedAction, type NavigateOut } from "./hosted-action";
import { LicenseCard } from "./license-card";
import { HeaderButtons, hasOffer, usePurchaseFlow } from "./page-parts";

export interface PersonalBillingViewProps {
  /** The billing client: the catalog, the status, and the checkout and hosted-page sessions the ↗ buttons ask for. */
  billing: BillingApi;
  /** The `?purchase=` a checkout came back with, or none. */
  purchaseId?: string | null;
  /** The purchase banner was dismissed: remove `?purchase=` from the address. */
  onPurchaseDone(): void;
  /** How the browser leaves for a hosted page: `leavePortal` and `openPortalTab`, the portal's only ways out. */
  navigateOut: NavigateOut;
  /** How often to read after a purchase, in ms; `PURCHASE_POLL_MS` (2 s) unless a host or a test needs another pace. */
  pollMs?: number;
  /** How long the page keeps reading for a purchase to be ready, in ms; `PURCHASE_TIMEOUT_MS` (a minute) unless a host or a test needs another. */
  timeoutMs?: number;
}

/** What the personal page and its header read: billing's catalog and status for the person's own account. */
function usePersonalBilling(billing: BillingApi, purchaseId: string | null) {
  const catalog = useQuery(billingCatalogQuery(billing, ACCOUNT_SCOPE));
  // While it is read under a key that differs only by `purchase` it keeps its last answer, so nothing swaps out the cards
  // when `?purchase=` goes (never another owner's or locale's: see `statusPlaceholder`).
  const statusOptions = billingStatusQuery(billing, ACCOUNT_SCOPE, purchaseId);
  const status = useQuery({ ...statusOptions, placeholderData: statusPlaceholder<BillingStatus>(statusOptions.queryKey) });
  const failed = [catalog, status].some((result) => result.data === undefined && result.isError);
  const waiting = !failed && [catalog, status].some((result) => result.data === undefined);
  const ready = catalog.data !== undefined && status.data !== undefined ? { products: catalog.data.products, status: status.data } : null;
  return { catalog, status, state: failed ? ("unavailable" as const) : waiting ? ("loading" as const) : ("ready" as const), data: ready };
}

export function PersonalBillingView({
  billing,
  purchaseId = null,
  onPurchaseDone,
  navigateOut,
  pollMs = PURCHASE_POLL_MS,
  timeoutMs = PURCHASE_TIMEOUT_MS,
}: PersonalBillingViewProps) {
  const { catalog, status, state, data } = usePersonalBilling(billing, purchaseId);
  const flow = usePurchaseFlow({
    purchaseId,
    offered: true,
    answer: status.data?.purchase,
    // A person's license is billing's alone: there is no Core list to wait for.
    listed: true,
    poll: () => void status.refetch({ cancelRefetch: false }),
    pollMs,
    timeoutMs,
    onDone: onPurchaseDone,
  });

  if (state === "loading") return <Loading>{t.personal.loading}</Loading>;
  if (state === "unavailable" || data === null) {
    return (
      <LicensesUnavailable
        personal
        onRetry={() => {
          void catalog.refetch();
          void status.refetch();
        }}
        retrying={(catalog.isFetching && catalog.data === undefined) || (status.isFetching && status.data === undefined)}
      />
    );
  }
  const { products, status: current } = data;
  const locale = billing.locale;

  const cards = joinLicenses({ licenses: [], billing: current.licenses, catalog: products, purchase: flow.purchase, locale });
  const showCatalog = hasOffer(products, "person") && cards.length === 0;
  const purchase = flow.purchase;
  const productName = purchase ? (products.find((entry) => entry.product === purchase.product)?.name ?? purchase.product) : "";

  return (
    <div className="space-y-5">
      {current.testMode ? <TestModeBanner testMode={current.testMode} /> : null}
      {purchase ? (
        <PurchaseBanner purchase={purchase} productName={productName} scope="person" listed timedOut={flow.timedOut} onDismiss={flow.dismiss} />
      ) : null}
      {cards.map((card) => (
        <LicenseCard
          key={card.licenseId}
          card={card}
          view="person"
          scope={ACCOUNT_SCOPE}
          billing={billing}
          navigateOut={navigateOut}
          locale={locale}
          highlight={card.justBought}
        />
      ))}
      {showCatalog ? (
        <CatalogGrid products={products} licenses={current.licenses} scope={ACCOUNT_SCOPE} billing={billing} navigateOut={navigateOut} />
      ) : null}
      {cards.length === 0 && !showCatalog ? <Restricted>{t.personal.nothingToBuy}</Restricted> : null}
    </div>
  );
}

export type PersonalBillingHeaderActionsProps = Pick<PersonalBillingViewProps, "billing" | "purchaseId" | "navigateOut">;

/**
 * The personal Billing page's header actions, for the host to put in its title bar beside the page's title: "Billing &
 * invoices ↗" and "Buy a license" (which opens the person's catalog as a dialog this component owns). Mount it with the
 * same `billing` and `purchaseId` as the view: it reads through the same query keys, so each request is made once
 * however many of the two are mounted. Like the view it needs a `QueryClientProvider` above it.
 *
 * It draws nothing until billing has been read, and then only for a person who holds a license: with none the page is
 * the catalog, which has its own buying copy. "Billing & invoices" is there only once billing lists
 * `billing_and_invoices` for the account, and "Buy a license" only while something is left to buy:
 * `catalogForOwner(products, "person").some(canBuy)`. Billing's refusal of the ↗ button shows under the buttons.
 */
export function PersonalBillingHeaderActions({ billing, purchaseId = null, navigateOut }: PersonalBillingHeaderActionsProps) {
  const { data } = usePersonalBilling(billing, purchaseId);
  const hosted = useHostedAction({ billing, scope: ACCOUNT_SCOPE, navigateOut });
  const [buying, setBuying] = useState(false);
  if (data === null) return null;
  const { products, status } = data;
  // The same cards the page draws: the buttons are for a person who holds a license.
  if (joinLicenses({ licenses: [], billing: status.licenses, catalog: products }).length === 0) return null;
  const somethingToBuy = catalogForOwner(products, "person").some(canBuy);
  return (
    <>
      <HeaderButtons invoices={listedAction(status, "billing_and_invoices")} onBuy={somethingToBuy ? () => setBuying(true) : null} hosted={hosted} />
      {somethingToBuy ? (
        <CatalogDialog
          open={buying}
          onClose={() => setBuying(false)}
          products={products}
          licenses={status.licenses}
          scope={ACCOUNT_SCOPE}
          billing={billing}
          navigateOut={navigateOut}
        />
      ) : null}
    </>
  );
}
