/**
 * What the Licenses page and the personal Billing page share: the header actions ("Billing & invoices ↗" and "Buy a
 * license"), the sentence a page says in place of cards, and what happens after checkout (which purchase the page is
 * showing, polling for its license, and dismissing it).
 *
 * No sentence is written here; the words are `strings/licenses.ts`.
 */

import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BillingAction, CatalogEntry, KnownOwnerType, PurchaseStatus } from "@mentra/workspace-contract/portal-billing";
import { catalogForOwner } from "../../lib/license-join";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { HostedFeedback, type HostedAction } from "./hosted-action";
import { HostedPageButton } from "./parts";

/**
 * The page's header actions: "Billing & invoices ↗" (only where billing lists that action for the account) and "Buy a
 * license" (only where `onBuy` is given: there is something to buy, or to add seats to). Billing's refusal of the ↗
 * button, or the link for a tab the browser blocked, shows under them.
 *
 * They are drawn by the pages' header components (`WorkspaceLicensesHeaderActions`, `PersonalBillingHeaderActions`)
 * for the host to put in its title bar, not by the views.
 */
export function HeaderButtons({
  invoices,
  onBuy,
  hosted,
}: {
  /** The account's `billing_and_invoices` as billing listed it, or null. */
  invoices: BillingAction | null;
  /** Opens "Buy a license"; null where there is nothing to open it for. */
  onBuy: (() => void) | null;
  /** The header's hosted-page flow, which the ↗ button uses. */
  hosted: HostedAction;
}) {
  if (invoices === null && onBuy === null) return null;
  return (
    <div className="flex flex-col items-end gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {invoices !== null ? (
          <HostedPageButton
            variant="secondary"
            newTab={invoices.returns === false}
            pending={hosted.pending === invoices.kind}
            disabled={hosted.pending !== null}
            onClick={() => hosted.run({ action: invoices })}
          >
            {t.actions.label(invoices.kind, invoices.fallbackLabel)}
          </HostedPageButton>
        ) : null}
        {onBuy !== null ? (
          <Button type="button" onClick={onBuy}>
            <PlusIcon aria-hidden="true" />
            {t.page.buyALicense}
          </Button>
        ) : null}
      </div>
      <div className="max-w-sm empty:hidden">
        <HostedFeedback action={hosted} />
      </div>
    </div>
  );
}

/**
 * Whether billing offers `owner` something to do with the catalog: an entry sold to that owner type with an `offer`.
 * It is what makes buying copy, and "Buy a license", exist for a viewer at all.
 */
export function hasOffer(products: readonly CatalogEntry[], owner: KnownOwnerType): boolean {
  return catalogForOwner(products, owner).some((entry) => entry.offer !== undefined);
}

/** A sentence in place of cards, in the page's quiet type. */
export function PageNote({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-1 text-sm">{children}</p>;
}

/** A member's page with no seat: say so, and who gives seats out. */
export function NoSeat({ workspaceName }: { workspaceName: string }) {
  return (
    <Card role="status" className="items-center gap-2 px-6 py-14 text-center">
      <h2 className="text-lg leading-tight font-semibold">{t.page.noSeat.title(workspaceName)}</h2>
      <p className="text-muted-foreground max-w-md text-sm leading-6">{t.page.noSeat.body}</p>
    </Card>
  );
}

/** What the page is doing about the purchase its address names (`?purchase=`). */
export interface PurchaseFlow {
  /** Billing's answer for the purchase the page is showing (its banner, and the license just bought); null when there is none to show. */
  purchase: PurchaseStatus | null;
  /** The minute is up and the page has stopped reading: the banner says the seats can take a few minutes. */
  timedOut: boolean;
  /** The banner's Dismiss: it is hidden at once, and the host is told so that it takes `?purchase=` out of the address. */
  dismiss(): void;
}

/**
 * After checkout the page reads billing's status and Core's licenses together every `pollMs` (decision 18, 2 s) for up
 * to `timeoutMs` (a minute), and stops sooner when the purchase is `ready` and Core lists its license, when the person
 * dismisses it, or when the page goes away. Each read is the kind that doesn't cancel one still out, so a slow answer
 * is waited for, not restarted.
 *
 * The minute is counted here, from when the page has a purchase to follow, whatever it shows meanwhile: its reads may
 * be failing, with the page saying "unavailable" and no banner on screen, and the polling must still end. (A banner
 * that kept its own clock would start it only when it first appeared, and never at all behind an unavailable page.)
 * It says so with `timedOut`, which is also what the banner shows its "payment went through" state by.
 *
 * `answer` is `status.purchase`: null for an id billing doesn't know (or another owner's), which has no banner and
 * nothing to wait for; undefined while the status is loading or failed. `offered` is false for a viewer who isn't
 * asked for billing's status at all.
 */
export function usePurchaseFlow({
  purchaseId,
  offered,
  answer,
  listed,
  poll,
  pollMs,
  timeoutMs,
  onDone,
}: {
  purchaseId: string | null;
  offered: boolean;
  answer: PurchaseStatus | null | undefined;
  /** Core lists the purchase's license (a person's license is billing's alone, so there it is always true). */
  listed: boolean;
  poll(): void;
  pollMs: number;
  timeoutMs: number;
  onDone(): void;
}): PurchaseFlow {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  const showing = offered && purchaseId !== null && dismissed !== purchaseId ? purchaseId : null;
  const purchase = showing !== null ? (answer ?? null) : null;
  const ready = purchase?.status === "ready" && listed;
  const waiting = showing !== null && answer !== null && !ready;
  const timedOut = showing !== null && gaveUp === showing;
  const polling = waiting && !timedOut;

  const latest = useRef(poll);
  latest.current = poll;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => latest.current(), pollMs);
    return () => clearInterval(timer);
  }, [polling, pollMs]);

  // The deadline: it starts with the purchase and ends with the wait (ready, dismissed, unmounted).
  useEffect(() => {
    if (!waiting || showing === null) return;
    const timer = setTimeout(() => setGaveUp(showing), timeoutMs);
    return () => clearTimeout(timer);
  }, [waiting, showing, timeoutMs]);

  return {
    purchase,
    timedOut,
    dismiss: () => {
      setDismissed(showing);
      onDone();
    },
  };
}
