/**
 * What the Licenses page and the personal Billing page share: the line above the cards (the total, "Billing &
 * invoices ↗" and "Buy a license"), the sentence a page says in place of cards, and what happens after checkout
 * (which purchase the page is showing, polling for its license, and dismissing it).
 *
 * No sentence is written here; the words are `strings/licenses.ts`.
 */

import { PlusIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BillingAction, BillingTotal, PurchaseStatus } from "@mentra/workspace-contract/portal-billing";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { HostedFeedback, type HostedAction } from "./hosted-action";
import { LicensesSummary } from "./banners";
import { HostedPageButton } from "./parts";

/**
 * The line above the cards: billing's total on the left where it sent one, and on the right "Billing & invoices ↗"
 * (only where billing lists that action for the account) and "Buy a license" (only where `onBuy` is given: there is
 * something to buy, or to add seats to). Billing's refusal of the ↗ button shows under the line.
 *
 * They are the page's own header actions, drawn inside the page's content: the portal's title bar belongs to the
 * portal, and which of these exist depends on what this page has read.
 */
export function LicensesToolbar({
  total,
  locale,
  invoices,
  onBuy,
  hosted,
}: {
  /** Billing's total for the owner; null where it sent none (or for a page that has no total). */
  total: BillingTotal | null;
  locale: string;
  /** The account's `billing_and_invoices` as billing listed it, or null. */
  invoices: BillingAction | null;
  /** Opens "Buy a license"; null where there is nothing to open it for. */
  onBuy: (() => void) | null;
  /** The page's hosted-page flow, which the ↗ button uses. */
  hosted: HostedAction;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <LicensesSummary total={total} locale={locale} />
        {invoices !== null || onBuy !== null ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
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
        ) : null}
      </div>
      <HostedFeedback action={hosted} />
    </div>
  );
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
  /** The banner's Dismiss: it is hidden at once, and the host is told so that it takes `?purchase=` out of the address. */
  dismiss(): void;
  /** The banner's minute is up: the page stops reading. */
  giveUp(): void;
}

/**
 * After checkout the page reads billing's status and Core's licenses together every `pollMs` (decision 18, 2 s) until
 * the purchase is `ready` and Core lists its license, or the banner gives up after its minute, or the person
 * dismisses it. Each read is the kind that doesn't cancel one still out, so a slow answer is waited for, not restarted.
 *
 * `answer` is `status.purchase`: null for an id billing doesn't know (or another owner's), which has no banner and
 * nothing to wait for. `offered` is false for a viewer who isn't asked for billing's status at all.
 */
export function usePurchaseFlow({
  purchaseId,
  offered,
  answer,
  listed,
  poll,
  pollMs,
  onDone,
}: {
  purchaseId: string | null;
  offered: boolean;
  answer: PurchaseStatus | null | undefined;
  /** Core lists the purchase's license (a person's license is billing's alone, so there it is always true). */
  listed: boolean;
  poll(): void;
  pollMs: number;
  onDone(): void;
}): PurchaseFlow {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  const showing = offered && purchaseId !== null && dismissed !== purchaseId ? purchaseId : null;
  const purchase = showing !== null ? (answer ?? null) : null;
  const ready = purchase?.status === "ready" && listed;
  const polling = showing !== null && answer !== null && !ready && gaveUp !== showing;

  const latest = useRef(poll);
  latest.current = poll;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => latest.current(), pollMs);
    return () => clearInterval(timer);
  }, [polling, pollMs]);

  return {
    purchase,
    dismiss: () => {
      setDismissed(showing);
      onDone();
    },
    giveUp: () => setGaveUp(showing),
  };
}
