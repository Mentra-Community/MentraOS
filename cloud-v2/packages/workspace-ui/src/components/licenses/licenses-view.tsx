/**
 * The workspace's Licenses page, composed from the pieces under `components/licenses/`: Core's licenses (who holds
 * each seat), billing's catalog (what each is called and looks like) and, for someone offered billing, billing's
 * status (what each costs and what can be done about it), joined into one card per license.
 *
 * It needs a `QueryClientProvider` above it, like every screen of this package: it reads through TanStack Query
 * (the workspace and its licenses and members through `api`, billing through `billing`), and what it refreshes
 * after a purchase or a seat change it refreshes in that cache. It draws the page's content only. The title and the
 * description (`licenseStrings.page`) belong to the portal's frame, and so do the header buttons ("Billing &
 * invoices ↗", "Buy licenses"): `WorkspaceLicensesHeaderActions` is the component for the frame's title bar. It
 * reads under the same keys as the view, owns the catalog dialog, and draws nothing where there is nothing to act on.
 *
 * What it shows follows the viewer, as the spec's table has it:
 * - an Admin or Owner who is offered billing (`offer.manage`): every license with its seats, dates, cost and
 *   billing actions; the page total; buying ("Buy licenses", or the catalog itself while there are no licenses);
 *   the test-mode banner; and, back from checkout, the purchase banner;
 * - an Admin or Owner who isn't offered it: every license with its seats and seat holders, and assigning and
 *   unassigning, and nothing from billing but the names: no money, no dates, no actions, no buying, no status request;
 * - anyone else (Members and Developers): only the licenses they hold a seat in, each as "Assigned to you", with no
 *   totals, money, other people or controls, and no request for billing's status or the members.
 *
 * It asks only for what the viewer's page needs. The catalog is asked for by whoever is offered billing (it names
 * licenses and sells products) and, once Core's list is in, by anyone with a license to name: a member with no seat
 * (and a manager not offered billing with no licenses) is never asked for it, unless a link asks to buy a product, when
 * the link's dialog names it (that read is optional: it can hold the page while it is out, but never makes it
 * unavailable). That page waits for Core's list first and a member's page makes its one extra round trip for the
 * catalog after it.
 *
 * A `?buy=<product>` link is answered by what the person needs (`decideLink`, in `buy-link.tsx`): a free license is
 * assigned to them, or billing's hosted page for one more (or for the product) opens, each with no click and with
 * `?buy=` already out of the address; otherwise a dialog says why not (they already have it, they should ask an Admin,
 * billing isn't offered, the workspace has it, or it isn't for sale). It is never a note above the cards. A
 * `?added=<licenseId>` is a return from the hosted page that added a license for the viewer: the page reads Core's
 * licenses until the viewer holds the product and then says so (`AddedBanner`).
 *
 * Which of these a viewer is, comes from Core's own answer for the workspace (their capabilities), and from the host's
 * `offer`: `catalog` is whether billing's catalog can be read (`me.modules.billingCatalog`) and `manage` whether this
 * viewer is offered billing for the workspace (billing ready and `workspace.billing.manage`). Where the catalog or
 * the status can't be read, or an answer doesn't match the contract, the page says "Licenses are unavailable" with
 * Retry rather than cards without names.
 *
 * Cards stay mounted through every refetch: they are keyed by license id, a read that is running or has failed
 * after the page loaded keeps what is on screen (no loading state replaces the cards), and billing's status keeps its
 * last answer while it is read under a key that differs only by `purchase` (when `?purchase=` goes), and never across
 * a change of workspace: a view that stays mounted when `workspaceId` changes shows a loading state until the new
 * workspace's status has answered, not the old one's billing. A card whose session request is out must
 * still be there when it answers, or its click would do nothing (a same-tab redirect is skipped for a card that
 * has gone).
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LicenseView, MemberView, WorkspaceDetail } from "@mentra/workspace-contract";
import type { BillingStatus, CatalogEntry } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "../../api";
import type { BillingApi } from "../../billing-api";
import { workspaceScope, type BillingScope } from "../../billing-scope";
import { holdsSeat, joinLicenses, listedAction } from "../../lib/license-join";
import { billingCatalogQuery, billingStatusQuery, licensesQuery, membersQuery, statusPlaceholder, workspaceDetailQuery } from "../../queries";
import { can } from "../../roles";
import { licenseStrings as t } from "../../strings/licenses";
import { Loading, Restricted } from "../common";
import { AddedBanner, LicensesSummary, LicensesUnavailable, PURCHASE_POLL_MS, PURCHASE_TIMEOUT_MS, PurchaseBanner, TestModeBanner } from "./banners";
import { decideLink, LinkDialog, type LinkOutcome } from "./buy-link";
import { BuyDialog, CatalogDialog, CatalogGrid, termsNow } from "./catalog";
import { useHostedAction, type NavigateOut } from "./hosted-action";
import { LicenseCard } from "./license-card";
import { HeaderButtons, hasOffer, NoSeat, PageNote, readFailed, readRetrying, readWaiting, usePurchaseFlow, type PurchaseFlow } from "./page-parts";

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
  /**
   * The `?buy=` product the address named, or none. Once the page's reads are in it acts once: it opens the Buy
   * dialog on the product where the viewer can buy it, and otherwise says why not. Nothing goes to checkout
   * until the person presses Continue to payment.
   */
  buyProduct?: string | null;
  /**
   * The page has acted on `buyProduct`: remove `?buy=` from the address. Called once per link. A host must pass it:
   * the link goes to a hosted page with no click, so a `?buy=` left in the address would send Back from there to the
   * same checkout again.
   */
  onBuyHandled?(): void;
  /**
   * The `?added=` license a return from the hosted page that added one license for the viewer came back with, or
   * none. The page reads Core's licenses until the viewer holds the product, and then says so.
   */
  addedLicenseId?: string | null;
  /** The added banner was dismissed: remove `?added=` from the address. */
  onAddedDone?(): void;
  /** The purchase banner was dismissed: remove `?purchase=` from the address. */
  onPurchaseDone(): void;
  /**
   * Retry was pressed on the unavailable page, after the view has read its own data again: a host re-reads what the
   * view takes as given (the portal's `me`, which says whether billing is ready and so whether `offer.catalog` can
   * turn true).
   */
  onRetry?(): void;
  /** How the browser leaves for a hosted page: `leavePortal` and `openPortalTab`, the portal's only ways out. */
  navigateOut: NavigateOut;
  /** How often to read after a purchase, in ms; `PURCHASE_POLL_MS` (2 s) unless a host or a test needs another pace. */
  pollMs?: number;
  /** How long the page keeps reading for a purchase's license, in ms; `PURCHASE_TIMEOUT_MS` (a minute) unless a host or a test needs another. */
  timeoutMs?: number;
}

/** What the page and its header read, as the viewer's page needs it, once every read that is wanted has answered. */
interface LicensesPageData {
  workspace: WorkspaceDetail;
  /** The viewer sees every license and every seat (`workspace.licenses.read`). */
  reads: boolean;
  /** Core's whole list, to tell whether the license a purchase made has arrived. */
  all: readonly LicenseView[];
  /** The licenses that are cards: Core's, not ended, and for a member only those they hold a seat in. */
  shown: readonly LicenseView[];
  members: readonly MemberView[];
  /** How many members the workspace has (imported members waiting for their first sign-in included): where buying starts. */
  memberCount: number | undefined;
  products: readonly CatalogEntry[];
  /** Billing's status: only for a viewer offered billing. */
  status: BillingStatus | null;
}

/**
 * Everything the Licenses page reads, and whether it can be drawn yet. The page and its header actions both call
 * this, with the same inputs: they read through the same query keys, so TanStack Query makes each request once
 * however many of them are mounted, and they agree on whether there is anything to show.
 *
 * - `loading` / `unavailable`: a read that is wanted has no answer yet, or has failed with none (a refetch that
 *   fails after an answer keeps the answer, and a read that failed with none stays failed while it is asked again,
 *   by Retry or the purchase poll: see `readFailed`). Nothing is wanted that the viewer's page doesn't need: a
 *   member's page asks for no status and no members, and a viewer with nothing to name and nothing to buy asks for
 *   no catalog.
 * - `ready`: `data` is what the page and the header draw from.
 */
function useLicensesPage(
  {
    api,
    billing,
    workspaceId,
    offer,
    purchaseId,
    buyProduct = null,
  }: Pick<WorkspaceLicensesViewProps, "api" | "billing" | "workspaceId" | "offer"> & { purchaseId: string | null; buyProduct?: string | null },
  /** False for a component that will draw nothing whatever it reads (the header, for someone not offered billing): it asks for nothing. */
  wanted = true,
) {
  const scope = useMemo(() => workspaceScope(workspaceId), [workspaceId]);
  const detail = useQuery({ ...workspaceDetailQuery(api, workspaceId), enabled: wanted });
  const licenses = useQuery({ ...licensesQuery(api, workspaceId), enabled: wanted });
  const reads = can(detail.data, "workspace.licenses.read");
  // What would be drawn as cards (once Core has said): it decides what must be read to name them. A member with no seat has none.
  const shown =
    detail.data && licenses.data
      ? reads
        ? licenses.data.filter((license) => !license.endedAt)
        : licenses.data.filter((license) => !license.endedAt && (license.seats?.length ?? 0) > 0)
      : null;
  // Only those who see every seat need the members (to name the holders and to choose whom to give a seat, and
  // for a viewer offered billing, to start a purchase at the member count).
  const members = useQuery({ ...membersQuery(api, workspaceId), enabled: wanted && reads });
  // The catalog names licenses and sells products: wanted by whoever is offered billing, and by anyone with a license to
  // name. A viewer with nothing to name and nothing to buy isn't asked for it (so it waits for Core's list to know).
  const needsCatalog = offer.manage || (shown !== null && shown.length > 0);
  // A link asking to buy, opened by someone who isn't offered billing (a Member or Developer, or a manager billing isn't
  // offered to): the dialog names the product, so the catalog is read for its name. Nothing else needs it, so it never
  // makes the page unavailable (a read that fails leaves the dialog saying "licenses" or the page's title); it may hold
  // the page while it is out. Once the link is handled the host removes `?buy=`, the read is no longer wanted, and what
  // it answered stays.
  const namesLink = buyProduct !== null && offer.catalog && detail.data !== undefined && !offer.manage;
  const catalog = useQuery({ ...billingCatalogQuery(billing, scope), enabled: wanted && offer.catalog && (needsCatalog || namesLink) });
  // Only a viewer offered billing is asked for the status (the route refuses anyone else). While it is read under a key
  // that differs only by `purchase` (`?purchase=` came or went) it keeps its last answer, so that nothing swaps out the
  // cards; it never keeps another workspace's (see `statusPlaceholder`).
  const statusOptions = billingStatusQuery(billing, scope, purchaseId);
  const status = useQuery({ ...statusOptions, enabled: wanted && offer.manage, placeholderData: statusPlaceholder<BillingStatus>(statusOptions.queryKey) });

  let state: "loading" | "unavailable" | "ready" = "ready";
  let data: LicensesPageData | null = null;
  if (readFailed(detail) || readFailed(licenses)) state = "unavailable";
  else if (readWaiting(detail) || readWaiting(licenses) || shown === null) state = "loading";
  else {
    const required = [...(needsCatalog && offer.catalog ? [catalog] : []), ...(offer.manage ? [status] : []), ...(reads && (shown.length > 0 || offer.manage) ? [members] : [])];
    if ((needsCatalog && !offer.catalog) || required.some(readFailed)) state = "unavailable";
    else if (required.some(readWaiting) || (namesLink && readWaiting(catalog))) state = "loading";
    else {
      data = {
        workspace: detail.data!,
        reads,
        all: licenses.data!,
        shown,
        members: members.data ?? [],
        memberCount: members.data?.length,
        products: catalog.data?.products ?? [],
        status: offer.manage ? (status.data ?? null) : null,
      };
    }
  }
  return { scope, state, data, canRead: reads, queries: { detail, licenses, members, catalog, status } };
}

export function WorkspaceLicensesView({
  api,
  billing,
  workspaceId,
  offer,
  purchaseId = null,
  buyProduct = null,
  onBuyHandled,
  addedLicenseId = null,
  onAddedDone,
  onPurchaseDone,
  onRetry,
  navigateOut,
  pollMs = PURCHASE_POLL_MS,
  timeoutMs = PURCHASE_TIMEOUT_MS,
}: WorkspaceLicensesViewProps) {
  const { scope, state, data, canRead, queries } = useLicensesPage({ api, billing, workspaceId, offer, purchaseId, buyProduct });
  const { detail, licenses, members, catalog, status } = queries;

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
    timeoutMs,
    onDone: onPurchaseDone,
  });
  const added = useAddedFlow({
    addedLicenseId,
    licenses: licenses.data,
    membershipId: detail.data?.membership?.membershipId ?? null,
    poll: () => {
      void licenses.refetch({ cancelRefetch: false });
      if (offer.manage) void status.refetch({ cancelRefetch: false });
    },
    pollMs,
    timeoutMs,
    onDone: () => onAddedDone?.(),
  });

  if (state === "loading") return <Loading>{t.page.loading}</Loading>;
  if (data === null) {
    const retry = () => {
      for (const result of [detail, licenses, ...(offer.catalog ? [catalog] : []), ...(offer.manage ? [status] : []), ...(canRead ? [members] : [])]) void result.refetch();
      onRetry?.();
    };
    const retrying = [detail, licenses, catalog, status, members].some(readRetrying);
    return <LicensesUnavailable onRetry={retry} retrying={retrying} />;
  }

  return (
    <LicensesBody
      api={api}
      billing={billing}
      scope={scope}
      navigateOut={navigateOut}
      data={data}
      manage={offer.manage}
      flow={flow}
      added={added}
      buyProduct={buyProduct}
      onBuyHandled={onBuyHandled}
    />
  );
}

interface LicensesBodyProps {
  api: WorkspaceApi;
  billing: BillingApi;
  scope: BillingScope;
  navigateOut: NavigateOut;
  data: LicensesPageData;
  /** The viewer is offered billing: `data.status` is billing's. */
  manage: boolean;
  flow: PurchaseFlow;
  added: AddedFlow;
  buyProduct: string | null;
  onBuyHandled?(): void;
}

/** What the page is doing about the license a return from the hosted page says was added (`?added=`). */
interface AddedFlow {
  /** The added license's product (its key), when Core lists the license; null while the page is not following a return. */
  product: string | null;
  /** The page is following a return that has not been dismissed. */
  showing: boolean;
  /** The viewer holds the product now. */
  held: boolean;
  /** The page has waited a minute for it and stopped reading. */
  timedOut: boolean;
  dismiss(): void;
}

/**
 * After the hosted page that adds one license for the viewer, the page reads Core's licenses every `pollMs` for up to
 * `timeoutMs` (as `usePurchaseFlow` does after checkout), until the viewer's membership holds a seat of the added
 * license's product, and shows nothing while it waits. The minute is counted from when the page has a return to follow,
 * and ends with the wait (held, dismissed, unmounted). Dismiss tells the host so that it removes `?added=`.
 */
function useAddedFlow({
  addedLicenseId,
  licenses,
  membershipId,
  poll,
  pollMs,
  timeoutMs,
  onDone,
}: {
  addedLicenseId: string | null;
  licenses: readonly LicenseView[] | undefined;
  membershipId: string | null;
  poll(): void;
  pollMs: number;
  timeoutMs: number;
  onDone(): void;
}): AddedFlow {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  const showing = addedLicenseId !== null && dismissed !== addedLicenseId ? addedLicenseId : null;
  const product = licenses?.find((license) => license.licenseId === addedLicenseId)?.product ?? null;
  const held =
    product !== null && membershipId !== null && (licenses ?? []).some((license) => license.product === product && !license.endedAt && holdsSeat(license, membershipId));
  const waiting = showing !== null && !held;
  const timedOut = showing !== null && gaveUp === showing;
  const polling = waiting && !timedOut;

  const latest = useRef(poll);
  latest.current = poll;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => latest.current(), pollMs);
    return () => clearInterval(timer);
  }, [polling, pollMs]);

  useEffect(() => {
    if (!waiting || showing === null) return;
    const timer = setTimeout(() => setGaveUp(showing), timeoutMs);
    return () => clearTimeout(timer);
  }, [waiting, showing, timeoutMs]);

  return {
    product,
    showing: showing !== null,
    held,
    timedOut,
    dismiss: () => {
      setDismissed(showing);
      onDone();
    },
  };
}

/**
 * What the page does with a `?buy=` product, once: the dialog that answers it (`outcome`, decided by `decideLink`). It
 * acts when the page's reads are in (it lives in the body, which only exists then) and tells the host with
 * `onBuyHandled`, which removes `?buy=` from the address; the same product is not acted on again however often the page
 * reads again. The outcome stays until the dialog is closed or another link replaces it.
 */
function useBuyLink({
  buyProduct,
  onBuyHandled,
  decide,
}: {
  buyProduct: string | null;
  onBuyHandled?(): void;
  decide(product: string): LinkOutcome;
}) {
  const [answer, setAnswer] = useState<{ outcome: LinkOutcome; serial: number } | null>(null);
  const serial = useRef(0);
  const done = useRef<string | null>(null);
  const latest = useRef({ decide, onBuyHandled });
  latest.current = { decide, onBuyHandled };
  useEffect(() => {
    if (buyProduct === null) {
      done.current = null;
      return;
    }
    if (done.current === buyProduct) return;
    done.current = buyProduct;
    // `?buy=` leaves the address first: an answer that goes to a hosted page is never one that Back returns to.
    latest.current.onBuyHandled?.();
    setAnswer({ outcome: latest.current.decide(buyProduct), serial: ++serial.current });
  }, [buyProduct]);
  // A dialog closing as it is replaced (the platform raises `close` as an open dialog turns shut) must not close the
  // one that replaced it: a close ends only the outcome it was drawn for.
  return {
    outcome: answer?.outcome ?? null,
    serial: answer?.serial ?? 0,
    close: (closing: LinkOutcome | null) => setAnswer((current) => (current !== null && current.outcome === closing ? null : current)),
  };
}

/** The page once everything it needs has been read. */
function LicensesBody({ api, billing, scope, navigateOut, data, manage, flow, added, buyProduct, onBuyHandled }: LicensesBodyProps) {
  const { workspace, reads, all, shown, members, memberCount, products, status } = data;
  const workspaceName = workspace.name;
  const canAssign = can(workspace, "workspace.licenses.assign");
  const locale = billing.locale;

  const cards = joinLicenses({ licenses: shown, billing: status?.licenses ?? null, catalog: products, purchase: flow.purchase, locale });

  // The link's table (`decideLink`): the dialog that answers it, or the Buy dialog, never a note.
  const link = useBuyLink({
    buyProduct,
    onBuyHandled,
    decide: (product) => decideLink({ product, workspace, licenses: all, members, products, status, manage, now: Date.now() }),
  });
  const linked = link.outcome;
  const linkDialog =
    linked !== null && linked.kind !== "choose" ? (
      <LinkDialog key={link.serial} outcome={linked} workspace={workspace} api={api} billing={billing} scope={scope} navigateOut={navigateOut} onClose={() => link.close(linked)} />
    ) : null;
  const addedBanner = added.showing ? (
    <AddedBanner
      productName={products.find((entry) => entry.product === added.product)?.name ?? added.product ?? ""}
      held={added.held}
      timedOut={added.timedOut}
      onDismiss={added.dismiss}
    />
  ) : null;

  // A member sees their own seats and nothing else.
  if (!reads) {
    return (
      <div className="space-y-5">
        {addedBanner}
        {cards.map((card) => (
          <LicenseCard key={card.licenseId} card={card} view="member" scope={scope} billing={billing} navigateOut={navigateOut} locale={locale} workspaceName={workspaceName} />
        ))}
        {cards.length > 0 ? <PageNote>{t.page.adminsGiveOutSeats(workspaceName)}</PageNote> : <NoSeat workspaceName={workspaceName} />}
        {linkDialog}
      </div>
    );
  }

  // Buying is for a viewer billing offers something to: an entry with an `offer`.
  const offered = manage && hasOffer(products);
  const showCatalog = offered && cards.length === 0;
  const purchase = flow.purchase;
  const productName = purchase ? (products.find((entry) => entry.product === purchase.product)?.name ?? purchase.product) : "";
  const bought = purchase?.licenseId != null ? all.find((license) => license.licenseId === purchase.licenseId) : undefined;
  const listed = bought !== undefined;
  // Billing hands the buyer one of the new licenses: the banner says so.
  const assigned = bought !== undefined && workspace.membership !== null && holdsSeat(bought, workspace.membership.membershipId);

  return (
    <div className="space-y-5">
      {addedBanner}
      {status?.testMode ? <TestModeBanner testMode={status.testMode} /> : null}
      {purchase ? (
        <PurchaseBanner purchase={purchase} productName={productName} listed={listed} assigned={assigned} timedOut={flow.timedOut} onDismiss={flow.dismiss} />
      ) : null}
      {manage && status && cards.length > 0 ? <LicensesSummary total={status.total} locale={locale} /> : null}
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
      {linkDialog}
      <BuyDialog
        open={linked?.kind === "choose"}
        product={linked?.kind === "choose" ? termsNow(linked.entry, products) : null}
        billing={billing}
        scope={scope}
        navigateOut={navigateOut}
        api={api}
        memberCount={memberCount}
        onClose={() => link.close(linked?.kind === "choose" ? linked : null)}
      />
    </div>
  );
}

export type WorkspaceLicensesHeaderActionsProps = Pick<WorkspaceLicensesViewProps, "api" | "billing" | "workspaceId" | "offer" | "purchaseId" | "navigateOut">;

/**
 * The Licenses page's header actions, for the host to put in its title bar beside the page's title, as the design
 * draws them: "Billing & invoices ↗" and "Buy licenses" (which opens the catalog as a dialog this component owns).
 * Mount it with the same props as the view (all but the callbacks and the pace): it reads through the same query keys, so
 * each request is made once however many of the two are mounted, and it agrees with the view on what there is to show.
 * Like the view it needs a `QueryClientProvider` above it.
 *
 * It draws nothing until everything it needs has been read, and then only for someone offered billing in a workspace
 * that has licenses: with none the page is the catalog, which has its own buying copy. "Billing & invoices" is there only
 * once billing lists `billing_and_invoices` for the account, and "Buy licenses" only where billing offers workspaces
 * something to buy or to add licenses to. Billing's refusal of the ↗ button shows under the buttons.
 */
export function WorkspaceLicensesHeaderActions({ api, billing, workspaceId, offer, purchaseId = null, navigateOut }: WorkspaceLicensesHeaderActionsProps) {
  const { scope, data } = useLicensesPage({ api, billing, workspaceId, offer, purchaseId }, offer.manage);
  const hosted = useHostedAction({ billing, scope, navigateOut, api });
  const [buying, setBuying] = useState(false);
  if (data === null || !offer.manage || !data.reads || data.status === null) return null;
  const { products, status, shown } = data;
  // The same cards the page draws: the buttons are for a workspace that has some.
  if (joinLicenses({ licenses: shown, billing: status.licenses, catalog: products }).length === 0) return null;
  const offered = hasOffer(products);
  return (
    <>
      <HeaderButtons invoices={listedAction(status, "billing_and_invoices")} onBuy={offered ? () => setBuying(true) : null} buyLabel={t.page.buyLicenses} hosted={hosted} />
      {offered ? (
        <CatalogDialog
          open={buying}
          onClose={() => setBuying(false)}
          products={products}
          licenses={status.licenses}
          scope={scope}
          billing={billing}
          navigateOut={navigateOut}
          api={api}
          memberCount={data.memberCount}
        />
      ) : null}
    </>
  );
}
