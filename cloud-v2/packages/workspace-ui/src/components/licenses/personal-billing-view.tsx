/**
 * The personal Billing page (`/account/billing`), composed from the same pieces as the Licenses page: billing's
 * catalog and status for the person's own account, joined into one card per license. It belongs to the account, not
 * to a workspace, so it has no Core read at all: a person's licenses are billing's alone, and a card has no seats.
 *
 * It needs a `QueryClientProvider` above it, like every screen of this package: it reads billing through TanStack
 * Query, and refreshes there what a purchase or a hosted page changes. The host shows it only to someone offered
 * billing, so both reads are always wanted. It draws the page's content only: the title ("Billing") and the
 * description (`licenseStrings.personal`) belong to the portal's frame, and "Billing & invoices ↗" and "Buy a
 * license" are drawn here in a line above the cards.
 *
 * - With nothing yet: "Buy a license for yourself", the products a person can buy, each with its price. Buy goes
 *   straight to payment, with no seats step.
 * - With licenses: one card each (status, Renews or Ends, cost and a "…" menu), the same amber notice and deadline
 *   as a workspace's for a failed payment, and, while there is something left to buy (a product sold to people
 *   that billing will sell), "Buy a license".
 * - Back from checkout: the banner ("Payment received", then "<product> is ready"), polled like the workspace's.
 * - Billing can't be read, or an answer doesn't match the contract: "Billing is unavailable", with Retry.
 *
 * Cards stay mounted through every refetch (see `WorkspaceLicensesView`): keyed by license id, never swapped for a
 * loading state once the page has loaded.
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { BillingApi } from "../../billing-api";
import { ACCOUNT_SCOPE } from "../../billing-scope";
import { catalogForOwner, joinLicenses, listedAction } from "../../lib/license-join";
import { billingCatalogQuery, billingStatusQuery } from "../../queries";
import { licenseStrings as t } from "../../strings/licenses";
import { Loading, Restricted } from "../common";
import { LicensesUnavailable, PURCHASE_POLL_MS, PURCHASE_TIMEOUT_MS, PurchaseBanner, TestModeBanner } from "./banners";
import { canBuy, CatalogDialog, CatalogGrid } from "./catalog";
import { useHostedAction, type NavigateOut } from "./hosted-action";
import { LicenseCard } from "./license-card";
import { LicensesToolbar, usePurchaseFlow } from "./page-parts";

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
  /** How long the banner waits for the purchase to be ready, in ms; `PURCHASE_TIMEOUT_MS` (a minute) unless set. */
  timeoutMs?: number;
}

export function PersonalBillingView({
  billing,
  purchaseId = null,
  onPurchaseDone,
  navigateOut,
  pollMs = PURCHASE_POLL_MS,
  timeoutMs = PURCHASE_TIMEOUT_MS,
}: PersonalBillingViewProps) {
  const catalog = useQuery(billingCatalogQuery(billing, ACCOUNT_SCOPE));
  // It keeps its last answer while it is read under another key, so nothing swaps out the cards when `?purchase=` goes.
  const status = useQuery({ ...billingStatusQuery(billing, ACCOUNT_SCOPE, purchaseId), placeholderData: keepPreviousData });
  const hosted = useHostedAction({ billing, scope: ACCOUNT_SCOPE, navigateOut });
  const [buying, setBuying] = useState(false);
  const flow = usePurchaseFlow({
    purchaseId,
    offered: true,
    answer: status.data?.purchase,
    // A person's license is billing's alone: there is no Core list to wait for.
    listed: true,
    poll: () => void status.refetch({ cancelRefetch: false }),
    pollMs,
    onDone: onPurchaseDone,
  });

  const unavailable = (
    <LicensesUnavailable
      personal
      onRetry={() => {
        void catalog.refetch();
        void status.refetch();
      }}
      retrying={(catalog.isFetching && catalog.data === undefined) || (status.isFetching && status.data === undefined)}
    />
  );
  const results = [catalog, status];
  if (results.some((result) => result.data === undefined && result.isError)) return unavailable;
  if (results.some((result) => result.data === undefined)) return <Loading>{t.personal.loading}</Loading>;
  const products = catalog.data!.products;
  const current = status.data!;
  const locale = billing.locale;

  const cards = joinLicenses({ licenses: [], billing: current.licenses, catalog: products, purchase: flow.purchase, locale });
  // Billing offers a person something when a product sold to people has an `offer`; "Buy a license" is for what is left to buy.
  const forPeople = catalogForOwner(products, "person");
  const offered = forPeople.some((entry) => entry.offer !== undefined);
  const somethingToBuy = forPeople.some(canBuy);
  const showCatalog = offered && cards.length === 0;
  const purchase = flow.purchase;
  const productName = purchase ? (products.find((entry) => entry.product === purchase.product)?.name ?? purchase.product) : "";

  return (
    <div className="space-y-5">
      {current.testMode ? <TestModeBanner testMode={current.testMode} /> : null}
      {purchase ? (
        <PurchaseBanner purchase={purchase} productName={productName} scope="person" listed onDismiss={flow.dismiss} onTimeout={flow.giveUp} timeoutMs={timeoutMs} />
      ) : null}
      {cards.length > 0 ? (
        <LicensesToolbar
          total={null}
          locale={locale}
          invoices={listedAction(current, "billing_and_invoices")}
          onBuy={somethingToBuy ? () => setBuying(true) : null}
          hosted={hosted}
        />
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
      {somethingToBuy && cards.length > 0 ? (
        <CatalogDialog
          open={buying}
          onClose={() => setBuying(false)}
          products={products}
          licenses={current.licenses}
          scope={ACCOUNT_SCOPE}
          billing={billing}
          navigateOut={navigateOut}
        />
      ) : null}
    </div>
  );
}
