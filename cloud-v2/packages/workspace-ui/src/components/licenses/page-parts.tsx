/**
 * What the Licenses page and its header share: the header action ("Billing ↗"), the sentence the page says in place of cards, and what happens after checkout (which purchase the page is
 * following, polling for its license, and closing its dialog).
 *
 * No sentence is written here; the words are `strings/licenses.ts`.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BillingAction, CatalogEntry, PurchaseStatus } from "@mentra/workspace-contract/portal-billing";
import { licenseStrings as t } from "../../strings/licenses";
import { Card } from "../../ui/card";
import { HostedFeedback, type HostedAction } from "./hosted-action";
import { HostedPageButton } from "./parts";

/** What a page reads of a query to tell whether it has answered, failed or is still on its way. */
interface ReadResult {
  data: unknown;
  isError: boolean;
  isFetching: boolean;
  /** When it last failed, or 0: a refetch does not clear it (it is cleared by an answer or by the query being reset). */
  errorUpdatedAt: number;
}

/**
 * Whether a read has no answer and has failed, and stays failed while it is asked again. A refetch that failed after an
 * answer keeps the answer (it is not "failed" here); but a read that never answered is put back to "pending" by TanStack
 * Query the moment it is refetched, with its error dropped, so `isError` alone would turn a failed page back into
 * "Loading…" for as long as every retry and every purchase poll is out. `errorUpdatedAt` survives the refetch, so the
 * page keeps its "unavailable" card, with Retry, until a read answers.
 */
export const readFailed = (result: ReadResult): boolean => result.data === undefined && (result.isError || result.errorUpdatedAt > 0);

/** Whether a read that is wanted has no answer yet and has never failed. */
export const readWaiting = (result: ReadResult): boolean => result.data === undefined && !readFailed(result);

/** Whether a read that has failed is being asked again (Retry, or a poll), for Retry to show it is busy. */
export const readRetrying = (result: ReadResult): boolean => result.isFetching && readFailed(result);

/**
 * The page's header action: "Billing ↗", only where billing lists `billing_and_invoices` for the account. Billing's
 * refusal of it, or the link for a tab the browser blocked, shows under it.
 *
 * It is drawn by the page's header component (`WorkspaceLicensesHeaderActions`)
 * for the host to put in its title bar, not by the view.
 */
export function HeaderButtons({
  invoices,
  hosted,
}: {
  /** The account's `billing_and_invoices` as billing listed it, or null. */
  invoices: BillingAction | null;
  /** The header's hosted-page flow, which the ↗ button uses. */
  hosted: HostedAction;
}) {
  if (invoices === null) return null;
  return (
    <div className="flex flex-col items-end gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <HostedPageButton
          variant="secondary"
          newTab={invoices.returns === false}
          pending={hosted.pending === invoices.kind}
          disabled={hosted.pending !== null}
          onClick={() => hosted.run({ action: invoices })}
        >
          {t.actions.label(invoices.kind, invoices.fallbackLabel)}
        </HostedPageButton>
      </div>
      <div className="max-w-sm empty:hidden">
        <HostedFeedback action={hosted} />
      </div>
    </div>
  );
}

/**
 * Whether billing offers the workspace something to do with the catalog: an entry with an `offer`. It is what makes
 * buying copy exist for a viewer at all.
 */
export function hasOffer(products: readonly CatalogEntry[]): boolean {
  return products.some((entry) => entry.offer !== undefined);
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

/**
 * The id a return names in the address (`?purchase=`, `?added=`) that the page follows: the address's, and once the host
 * has taken it out of the address (the person closed its dialog) still the same one, so that the page goes on reading for
 * it and keeps the license it made first and ringed. A new id replaces it; another workspace drops it. The page and its
 * header both follow `?purchase=` this way, so they keep reading billing's status under one key.
 */
export function useFollowed(id: string | null, workspaceId: string): string | null {
  const [kept, setKept] = useState<{ id: string; workspaceId: string } | null>(id === null ? null : { id, workspaceId });
  // Kept during render, as React has state follow a prop: the next render already sees it.
  if (id !== null && (kept?.id !== id || kept.workspaceId !== workspaceId)) setKept({ id, workspaceId });
  if (id !== null) return id;
  return kept !== null && kept.workspaceId === workspaceId ? kept.id : null;
}

/** What the page is doing about the purchase it follows (`?purchase=`, kept by `useFollowed`). */
export interface PurchaseFlow {
  /**
   * Billing's answer for the purchase the page follows: the license just bought (first and ringed in green), and the
   * dialog's words. Null when there is none to show. Closing the dialog leaves it: the card stays first and ringed.
   */
  purchase: PurchaseStatus | null;
  /** The minute is up and the page has stopped reading: the dialog says the licenses can take a few minutes. */
  timedOut: boolean;
  /** The dialog is open: there is a purchase to show and the person hasn't closed it. */
  open: boolean;
  /**
   * OK, Escape, the × or the backdrop: the dialog closes at once, and the host is told so that it takes `?purchase=` out
   * of the address. Nothing else stops: the page goes on reading until the license is listed or the minute is up.
   */
  close(): void;
}

/**
 * After checkout the page reads billing's status and Core's licenses together every `pollMs` (decision 18, 2 s) for up
 * to `timeoutMs` (a minute), and stops sooner when the purchase is `ready` and Core lists its license, or when the page
 * goes away. Closing the dialog stops neither: a person who presses OK while it is setting up still sees the card turn
 * ready. Each read is the kind that doesn't cancel one still out, so a slow answer is waited for, not restarted.
 *
 * The minute is counted here, from when the page has a purchase to follow, whatever it shows meanwhile: its reads may
 * be failing, with the page saying "unavailable" and no dialog on screen, and the polling must still end. (A dialog
 * that kept its own clock would start it only when it first appeared, and never at all behind an unavailable page.)
 * It says so with `timedOut`, which is also what the dialog shows its "payment went through" state by.
 *
 * `purchaseId` is the purchase the page follows (`useFollowed`). `answer` is `status.purchase`: null for an id billing
 * doesn't know (or another owner's), which has no dialog and nothing to wait for; undefined while the status is loading
 * or failed. `offered` is false for a viewer who isn't asked for billing's status at all.
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
  /** Core lists the purchase's license. */
  listed: boolean;
  poll(): void;
  pollMs: number;
  timeoutMs: number;
  onDone(): void;
}): PurchaseFlow {
  const [closed, setClosed] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  const following = offered && purchaseId !== null ? purchaseId : null;
  const purchase = following !== null ? (answer ?? null) : null;
  const ready = purchase?.status === "ready" && listed;
  const waiting = following !== null && answer !== null && !ready;
  const timedOut = following !== null && gaveUp === following;
  const polling = waiting && !timedOut;

  const latest = useRef(poll);
  latest.current = poll;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => latest.current(), pollMs);
    return () => clearInterval(timer);
  }, [polling, pollMs]);

  // The deadline: it starts with the purchase and ends with the wait (ready, or unmounted).
  useEffect(() => {
    if (!waiting || following === null) return;
    const timer = setTimeout(() => setGaveUp(following), timeoutMs);
    return () => clearTimeout(timer);
  }, [waiting, following, timeoutMs]);

  const open = purchase !== null && closed !== following;
  return {
    purchase,
    timedOut,
    open,
    close: () => {
      if (!open) return;
      setClosed(following);
      onDone();
    },
  };
}
