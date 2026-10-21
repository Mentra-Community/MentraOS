/**
 * The workspace's Licenses page, composed from the pieces under `components/licenses/`: Core's licenses (who holds
 * each seat), billing's catalog (what each is called and looks like) and, for someone offered billing, billing's
 * status (what each costs and what can be done about it), joined into one card per license.
 *
 * It needs a `QueryClientProvider` above it, like every screen of this package: it reads through TanStack Query
 * (the workspace and its licenses and members through `api`, billing through `billing`), and what it refreshes
 * after a purchase or a seat change it refreshes in that cache. It draws the page's content only. The title and the
 * description (`licenseStrings.page`) belong to the portal's frame, and the header buttons ("Billing & invoices ↗",
 * "Buy a license") are drawn here, in a line above the cards, because which of them exist depends on what this
 * page has read.
 *
 * What it shows follows the viewer, as the spec's table has it:
 * - an Admin or Owner who is offered billing (`offer.manage`): every license with its seats, dates, cost and
 *   billing actions; the page total; buying ("Buy a license", or the catalog itself while there are no licenses);
 *   the test-mode banner; and, back from checkout, the purchase banner;
 * - an Admin or Owner who isn't offered it: every license with its seats and seat holders, and assigning and
 *   unassigning, and nothing from billing but the names: no money, no dates, no actions, no buying, no status request;
 * - anyone else (Members and Developers): only the licenses they hold a seat in, each as "You have a seat", with no
 *   totals, money, other people or controls, and no request for billing's status or the members.
 *
 * Which of these a viewer is, comes from Core's own answer for the workspace (their capabilities), and from the host's
 * `offer`: `catalog` is whether billing's catalog can be read (`me.modules.billingCatalog`) and `manage` whether this
 * viewer is offered billing for the workspace (billing ready and `workspace.billing.manage`). Where the catalog or
 * the status can't be read, or an answer doesn't match the contract, the page says "Licenses are unavailable" with
 * Retry rather than cards without names.
 *
 * Cards stay mounted through every refetch: they are keyed by license id, a read that is running or has failed
 * after the page loaded keeps what is on screen (no loading state replaces the cards), and billing's status keeps its
 * last answer while it is read under a new key (when `?purchase=` goes). A card whose session request is out must
 * still be there when it answers, or its click would do nothing (a same-tab redirect is skipped for a card that
 * has gone).
 */

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { LicenseView, MemberView } from "@mentra/workspace-contract";
import type { BillingStatus, CatalogEntry } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "../../api";
import type { BillingApi } from "../../billing-api";
import { workspaceScope, type BillingScope } from "../../billing-scope";
import { catalogForOwner, joinLicenses, listedAction } from "../../lib/license-join";
import { billingCatalogQuery, billingStatusQuery, licensesQuery, membersQuery, workspaceDetailQuery } from "../../queries";
import { can } from "../../roles";
import { licenseStrings as t } from "../../strings/licenses";
import { Loading, Restricted } from "../common";
import { LicensesUnavailable, PURCHASE_POLL_MS, PURCHASE_TIMEOUT_MS, PurchaseBanner, TestModeBanner } from "./banners";
import { CatalogDialog, CatalogGrid } from "./catalog";
import { useHostedAction, type NavigateOut } from "./hosted-action";
import { LicenseCard } from "./license-card";
import { LicensesToolbar, NoSeat, PageNote, usePurchaseFlow, type PurchaseFlow } from "./page-parts";

export interface WorkspaceLicensesViewProps {
  /** Core's workspace API: the workspace, its licenses and members, and the seat changes. */
  api: WorkspaceApi;
  /** The billing client: the catalog, the status, and the checkout and hosted-page sessions the ↗ buttons ask for. */
  billing: BillingApi;
  workspaceId: string;
  offer: {
    /** Billing's catalog can be read (`me.modules.billingCatalog`): licenses can be named. */
    catalog: boolean;
    /** The viewer is offered billing for this workspace: billing is ready and they hold `workspace.billing.manage`. */
    manage: boolean;
  };
  /** The `?purchase=` a checkout came back with, or none. */
  purchaseId?: string | null;
  /** The purchase banner was dismissed: remove `?purchase=` from the address. */
  onPurchaseDone(): void;
  /** How the browser leaves for a hosted page: `leavePortal` and `openPortalTab`, the portal's only ways out. */
  navigateOut: NavigateOut;
  /** How often to read after a purchase, in ms; `PURCHASE_POLL_MS` (2 s) unless a host or a test needs another pace. */
  pollMs?: number;
  /** How long the banner waits for the license to reach Core, in ms; `PURCHASE_TIMEOUT_MS` (a minute) unless set. */
  timeoutMs?: number;
}

/** Whether a read has no answer and has failed (a refetch that failed after an answer keeps the answer). */
const failed = (result: { data: unknown; isError: boolean }) => result.data === undefined && result.isError;
/** Whether a read that is wanted has no answer yet and hasn't failed. */
const waiting = (result: { data: unknown; isError: boolean }) => result.data === undefined && !result.isError;

export function WorkspaceLicensesView({
  api,
  billing,
  workspaceId,
  offer,
  purchaseId = null,
  onPurchaseDone,
  navigateOut,
  pollMs = PURCHASE_POLL_MS,
  timeoutMs = PURCHASE_TIMEOUT_MS,
}: WorkspaceLicensesViewProps) {
  const scope = useMemo(() => workspaceScope(workspaceId), [workspaceId]);
  const detail = useQuery(workspaceDetailQuery(api, workspaceId));
  const licenses = useQuery(licensesQuery(api, workspaceId));
  const reads = can(detail.data, "workspace.licenses.read");
  // Only those who see every seat need the members (to name the holders and to choose whom to give a seat).
  const members = useQuery({ ...membersQuery(api, workspaceId), enabled: reads });
  const catalog = useQuery({ ...billingCatalogQuery(billing, scope), enabled: offer.catalog });
  // Only a viewer offered billing is asked for the status (the route refuses anyone else). It keeps its last answer
  // while it is read under another key, so that nothing swaps out the cards when `?purchase=` goes.
  const status = useQuery({ ...billingStatusQuery(billing, scope, purchaseId), enabled: offer.manage, placeholderData: keepPreviousData });

  const answer = offer.manage ? status.data?.purchase : null;
  const flow = usePurchaseFlow({
    purchaseId,
    offered: offer.manage,
    answer,
    listed: answer?.licenseId != null && (licenses.data ?? []).some((license) => license.licenseId === answer.licenseId),
    poll: () => {
      // Without cancelling a read that is out: a slow answer is waited for, not restarted every two seconds.
      void status.refetch({ cancelRefetch: false });
      void licenses.refetch({ cancelRefetch: false });
    },
    pollMs,
    onDone: onPurchaseDone,
  });

  const retry = () => {
    for (const result of [detail, licenses, ...(offer.catalog ? [catalog] : []), ...(offer.manage ? [status] : []), ...(reads ? [members] : [])]) void result.refetch();
  };
  const retrying = [detail, licenses, catalog, status, members].some((result) => result.isFetching && result.data === undefined);
  const unavailable = <LicensesUnavailable onRetry={retry} retrying={retrying} />;

  if (failed(detail) || failed(licenses)) return unavailable;
  if (waiting(detail) || waiting(licenses)) return <Loading>{t.page.loading}</Loading>;
  const workspace = detail.data!;
  const all = licenses.data!;

  // What would be drawn as cards decides what must be read to name them: a member with no seat has none.
  const shown = reads ? all.filter((license) => !license.endedAt) : all.filter((license) => !license.endedAt && (license.seats?.length ?? 0) > 0);
  const needsCatalog = offer.manage || shown.length > 0;
  const required = [...(needsCatalog && offer.catalog ? [catalog] : []), ...(offer.manage ? [status] : []), ...(reads && shown.length > 0 ? [members] : [])];
  if ((needsCatalog && !offer.catalog) || required.some(failed)) return unavailable;
  if (required.some(waiting)) return <Loading>{t.page.loading}</Loading>;

  return (
    <LicensesBody
      api={api}
      billing={billing}
      scope={scope}
      navigateOut={navigateOut}
      workspaceName={workspace.name}
      reads={reads}
      canAssign={can(workspace, "workspace.licenses.assign")}
      manage={offer.manage}
      licenses={shown}
      members={members.data ?? []}
      memberCount={members.data?.length}
      products={catalog.data?.products ?? []}
      status={offer.manage ? (status.data ?? null) : null}
      flow={flow}
      timeoutMs={timeoutMs}
      listedInCore={all}
    />
  );
}

interface LicensesBodyProps {
  api: WorkspaceApi;
  billing: BillingApi;
  scope: BillingScope;
  navigateOut: NavigateOut;
  workspaceName: string;
  /** The viewer sees every license and every seat (`workspace.licenses.read`). */
  reads: boolean;
  /** The viewer gives out seats (`workspace.licenses.assign`). */
  canAssign: boolean;
  /** The viewer is offered billing: `status` is billing's. */
  manage: boolean;
  /** The licenses that are cards: Core's, not ended, and for a member only those they hold a seat in. */
  licenses: readonly LicenseView[];
  members: readonly MemberView[];
  /** How many members the workspace has, once the list has been read (the seats step says so). */
  memberCount: number | undefined;
  products: readonly CatalogEntry[];
  status: BillingStatus | null;
  flow: PurchaseFlow;
  timeoutMs: number;
  /** Core's whole list, to tell whether the license a purchase made has arrived. */
  listedInCore: readonly LicenseView[];
}

/** The page once everything it needs has been read. */
function LicensesBody({
  api,
  billing,
  scope,
  navigateOut,
  workspaceName,
  reads,
  canAssign,
  manage,
  licenses,
  members,
  memberCount,
  products,
  status,
  flow,
  timeoutMs,
  listedInCore,
}: LicensesBodyProps) {
  const locale = billing.locale;
  const hosted = useHostedAction({ billing, scope, navigateOut, api });
  const [buying, setBuying] = useState(false);

  const cards = joinLicenses({ licenses, billing: status?.licenses ?? null, catalog: products, purchase: flow.purchase, locale });

  // A member sees their own seats and nothing else.
  if (!reads) {
    if (cards.length === 0) return <NoSeat workspaceName={workspaceName} />;
    return (
      <div className="space-y-5">
        {cards.map((card) => (
          <LicenseCard key={card.licenseId} card={card} view="member" scope={scope} billing={billing} navigateOut={navigateOut} locale={locale} workspaceName={workspaceName} />
        ))}
        <PageNote>{t.page.adminsGiveOutSeats(workspaceName)}</PageNote>
      </div>
    );
  }

  // Buying is for a viewer billing offers something to: an entry for workspaces with an `offer`.
  const offered = manage && catalogForOwner(products, "workspace").some((entry) => entry.offer !== undefined);
  const showCatalog = offered && cards.length === 0;
  const purchase = flow.purchase;
  const productName = purchase ? (products.find((entry) => entry.product === purchase.product)?.name ?? purchase.product) : "";
  const listed = purchase?.licenseId != null && listedInCore.some((license) => license.licenseId === purchase.licenseId);

  return (
    <div className="space-y-5">
      {status?.testMode ? <TestModeBanner testMode={status.testMode} /> : null}
      {purchase ? (
        <PurchaseBanner purchase={purchase} productName={productName} listed={listed} onDismiss={flow.dismiss} onTimeout={flow.giveUp} timeoutMs={timeoutMs} />
      ) : null}
      {manage && status && cards.length > 0 ? (
        <LicensesToolbar
          total={status.total}
          locale={locale}
          invoices={listedAction(status, "billing_and_invoices")}
          onBuy={offered ? () => setBuying(true) : null}
          hosted={hosted}
        />
      ) : null}
      {cards.map((card) => (
        <LicenseCard
          key={card.licenseId}
          card={card}
          view="workspace"
          scope={scope}
          billing={billing}
          navigateOut={navigateOut}
          locale={locale}
          workspaceName={workspaceName}
          api={api}
          members={members}
          canAssign={canAssign}
          folded={cards.length > 1 && !card.justBought}
          highlight={card.justBought}
        />
      ))}
      {showCatalog ? (
        <CatalogGrid
          products={products}
          licenses={status?.licenses}
          scope={scope}
          billing={billing}
          navigateOut={navigateOut}
          api={api}
          memberCount={memberCount}
        />
      ) : null}
      {cards.length === 0 && !showCatalog ? <Restricted>{t.page.noLicenses}</Restricted> : null}
      {offered && cards.length > 0 ? (
        <CatalogDialog
          open={buying}
          onClose={() => setBuying(false)}
          products={products}
          licenses={status?.licenses}
          scope={scope}
          billing={billing}
          navigateOut={navigateOut}
          api={api}
          memberCount={memberCount}
        />
      ) : null}
    </div>
  );
}
