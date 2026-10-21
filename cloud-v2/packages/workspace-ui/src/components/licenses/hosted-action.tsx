/**
 * Leaving the portal for one of billing's hosted pages: ask billing for a session (or a checkout), then send the
 * person to its URL. Every ↗ button on the Licenses and Billing screens (a card's actions, the roster's Add seats,
 * the over notice's "Add 2 seats", the picker's Add seats, and the catalog's Buy, Continue to payment and Add
 * seats) goes through one `useHostedAction`, so they all behave alike.
 *
 * - An action that returns to the portal, and every purchase, navigates this tab.
 * - An action billing lists with `returns: false` (an invoice's payment page has no way back) opens a blank tab
 *   in the click itself, since a browser allows that only while the click is being handled, then sends that tab to
 *   the session's URL; a session that fails closes the tab again. If the browser blocked the tab, the URL comes
 *   back as a link ("Open the payment page ↗") for a second click. Either way the licenses and billing's status
 *   are read again when the window regains focus (`watchReturn`).
 * - A screen that has let go of the request (its dialog closed, its card gone) doesn't send this tab anywhere when
 *   billing answers; the tab a click opened still gets its page, and the return is still watched.
 *
 * The host supplies the two ways out (`NavigateOut`): this file never touches `window.location`, and the URL it
 * sends them to has already passed the contract's check (billing's client refuses any other).
 *
 * Nothing here imports the contract's schemas (the billing client is a type only), so a screen that only needs
 * the hook doesn't carry them.
 */

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { BillingAction } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "../../api";
import type { BillingApi } from "../../billing-api";
import { BillingRefusedError, billingErrorMessage } from "../../billing-errors";
import { ownerTypeOf, type BillingScope } from "../../billing-scope";
import { billingKeys, workspaceKeys } from "../../queries";
import { licenseStrings as t } from "../../strings/licenses";
import { buttonVariants } from "../../ui/button";
import { AlertText } from "../common";

/** A tab opened for a hosted page that doesn't return: sent on once billing has answered, or closed if it won't. */
export interface PortalTab {
  go(url: string): void;
  close(): void;
}

/** How the host takes the person out of the portal. */
export interface NavigateOut {
  /** Sends this tab to the hosted page. */
  leave(url: string): void;
  /**
   * Opens a blank tab, and must be called in the click that asked for it. Null when the browser blocked it.
   * Called only for an action listed with `returns: false`.
   */
  openTab(): PortalTab | null;
}

/** What the hook asks billing's client for: a session for an action, or a checkout for a purchase. */
export type HostedBilling = Pick<BillingApi, "purchase" | "session">;

/** One press of a hosted-page button for an action billing listed: for a license (none for the account's), and how many seats `add_seats` adds. */
export interface ActionRequest {
  action: BillingAction;
  licenseId?: string;
  seats?: number;
  /** The product, as a refusal names it, where it isn't the hook's own `product`. */
  name?: string;
}

/** One press of Buy: `seats` of `product`, which billing answers with the checkout's page. A purchase always returns to the portal. */
export interface HostedPurchase {
  product: string;
  seats: number;
  /** The product, as a refusal names it, where it isn't the hook's own `product`. */
  name?: string;
}

export type HostedRequest = ActionRequest | HostedPurchase;

/** What `HostedAction.pending` is while a purchase is being asked for (an action's is its `kind`). */
export const PURCHASE = "purchase";

export interface HostedAction {
  /**
   * Starts the request. Call it from the click itself: a tab for a page that doesn't return can only be opened
   * there. Ignored while one is under way. `surface` names where the press happened (a dialog, say), so that
   * what the request leaves to say (`error`, `link`) is drawn there and not behind it; none means the card.
   */
  run(request: HostedRequest, surface?: string): void;
  /** Forgets the last refusal and link, for a screen that is shown again and shouldn't greet the person with them. Ignored while a request is out. */
  clear(): void;
  /** The `kind` of the action whose session is being requested (`PURCHASE` for a purchase), else null. */
  pending: string | null;
  /** The request being asked for, else null: which product's button is the one waiting. */
  request: HostedRequest | null;
  /** Billing's refusal, in words; null when there is none. */
  error: string | null;
  /** Billing's code for that refusal when it sent one (`already_licensed`), else null. */
  code: string | null;
  /** Where a tab the browser blocked would have gone: shown as a link for a second click. */
  link: string | null;
  /** The `surface` of the press that `error` and `link` belong to; null for the card itself. */
  surface: string | null;
}

/** The watches on a return to this window, per client and then per what they read again: one each, however many asked. */
const returnWatches = new WeakMap<QueryClient, Map<string, () => void>>();

/**
 * After a page that doesn't return: reads billing's status for the owner, and for a workspace Core's licenses too,
 * again whenever the person comes back to this window.
 *
 * The watch belongs to what it refreshes and not to the button that asked. A dialog or a panel closing, or a card
 * going, ends nothing, because the page behind it still shows those reads. It ends when nothing on screen reads them
 * any more, which it finds out at the next return, so a page the person has left leaves no listener behind for
 * longer than that. Asked for while nothing shows them (the screen was already gone), it starts nothing.
 */
function watchReturn(client: QueryClient, scope: BillingScope, api?: Pick<WorkspaceApi, "basePath">): void {
  const keys: Array<readonly unknown[]> = [billingKeys.statuses(scope)];
  if (api && scope.kind === "workspace") keys.push(workspaceKeys.licenses(api, scope.workspaceId));
  const shown = () => keys.some((queryKey) => client.getQueryCache().findAll({ queryKey, type: "active" }).length > 0);
  if (!shown()) return;
  const id = JSON.stringify(keys);
  let owned = returnWatches.get(client);
  if (!owned) returnWatches.set(client, (owned = new Map()));
  if (owned.has(id)) return;
  const watches = owned;
  const refresh = () => {
    if (document.visibilityState === "hidden") return;
    if (!shown()) {
      stop();
      return;
    }
    for (const queryKey of keys) void client.invalidateQueries({ queryKey });
  };
  function stop() {
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
    watches.delete(id);
  }
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  watches.set(id, stop);
}

/**
 * The hosted-page flow for one card or dialog. `product` is the name a refusal may mention ("A purchase of Fleet
 * is already under way"), for a screen that has one product; a request may name its own. `api` lets the
 * window-focus refresh read the workspace's licenses again as well as billing's status; without it (a person's
 * page) only the status is refreshed.
 *
 * A purchase refused as `already_licensed` means the catalog on screen is stale, so billing's answers for the owner
 * are read again.
 */
export function useHostedAction({
  billing,
  scope,
  navigateOut,
  api,
  product,
}: {
  billing: HostedBilling;
  scope: BillingScope;
  navigateOut: NavigateOut;
  api?: Pick<WorkspaceApi, "basePath">;
  product?: string;
}): HostedAction {
  const client = useQueryClient();
  const [current, setCurrent] = useState<HostedRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [surface, setSurface] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  // The latest of what the callback reads, so `run` keeps one identity.
  const latest = useRef({ billing, scope, navigateOut, api, product });
  latest.current = { billing, scope, navigateOut, api, product };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    (request: HostedRequest, from?: string) => {
      if (busy.current) return;
      const { billing: billingApi, scope: owner, navigateOut: out, product } = latest.current;
      const purchasing = !("action" in request);
      const newTab = !purchasing && request.action.returns === false;
      // In the click, before anything is awaited: a browser lets a page open a tab only while it handles one.
      let tab: PortalTab | null = null;
      if (newTab) {
        try {
          tab = out.openTab();
        } catch {
          tab = null;
        }
      }
      busy.current = true;
      setCurrent(request);
      setError(null);
      setCode(null);
      setLink(null);
      setSurface(from ?? null);
      void (async () => {
        try {
          const { url } = await (purchasing
            ? billingApi.purchase(owner, { product: request.product, seats: request.seats })
            : billingApi.session(owner, {
                action: request.action.kind,
                ...(request.licenseId !== undefined ? { licenseId: request.licenseId } : {}),
                ...(request.seats !== undefined ? { seats: request.seats } : {}),
              }));
          if (newTab) {
            if (tab) tab.go(url);
            else if (mounted.current) setLink(url);
            // Whoever asked may be gone (a dialog closed while billing answered); the page behind it still wants the return.
            watchReturn(client, owner, latest.current.api);
          } else if (mounted.current) {
            out.leave(url);
          }
        } catch (cause) {
          // Nothing to show in the tab, and nothing to wait for.
          try {
            tab?.close();
          } catch {
            // A tab that is already gone is the outcome wanted.
          }
          const refused = cause instanceof BillingRefusedError ? cause.code : null;
          // Held already: the catalog the person is looking at is out of date, whatever became of the screen that asked.
          if (purchasing && refused === "already_licensed") void client.invalidateQueries({ queryKey: billingKeys.owner(owner) });
          if (mounted.current) {
            setError(billingErrorMessage(cause, { product: request.name ?? product, scope: ownerTypeOf(owner) }));
            setCode(refused);
          }
        } finally {
          busy.current = false;
          if (mounted.current) setCurrent(null);
        }
      })();
    },
    [client],
  );

  const clear = useCallback(() => {
    if (busy.current) return;
    setError(null);
    setCode(null);
    setLink(null);
    setSurface(null);
  }, []);

  const pending = current === null ? null : "action" in current ? current.action.kind : PURCHASE;
  return { run, clear, pending, request: current, error, code, link, surface };
}

/**
 * What a hosted action left to say: billing's refusal (an alert, in the neutral notice style: amber on these pages is
 * for payments), and the link for a tab the browser blocked. Renders nothing when there is neither.
 */
export function HostedFeedback({ action }: { action: Pick<HostedAction, "error" | "link"> }) {
  const hint = useId();
  if (action.error === null && action.link === null) return null;
  return (
    <div className="space-y-3">
      {action.error !== null ? <AlertText tone="neutral">{action.error}</AlertText> : null}
      {action.link !== null ? (
        <p className="flex flex-wrap items-center gap-2">
          <a
            href={action.link}
            target="_blank"
            rel="noopener noreferrer"
            data-hosted-page=""
            aria-describedby={hint}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            {t.actions.openPaymentPage}
            <ArrowUpRightIcon aria-hidden="true" />
          </a>
          <span id={hint} className="sr-only">
            {t.actions.opensSecureBillingPageInNewTab}
          </span>
        </p>
      ) : null}
    </div>
  );
}
