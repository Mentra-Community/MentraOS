/**
 * Leaving the portal for one of billing's hosted pages: ask billing for a session, then send the person to its
 * URL. Every ↗ button on the Licenses and Billing screens (a card's actions, the roster's Add seats, the over
 * notice's "Add 2 seats", the picker's Add seats) goes through one `useHostedAction`, so they all behave alike.
 *
 * - An action that returns to the portal navigates this tab.
 * - An action billing lists with `returns: false` (an invoice's payment page has no way back) opens a blank tab
 *   in the click itself, since a browser allows that only while the click is being handled, then sends that tab to
 *   the session's URL; a session that fails closes the tab again. If the browser blocked the tab, the URL comes
 *   back as a link ("Open the payment page ↗") for a second click. Either way the licenses and billing's status
 *   are read again when the window regains focus.
 *
 * The host supplies the two ways out (`NavigateOut`): this file never touches `window.location`, and the URL it
 * sends them to has already passed the contract's check (billing's client refuses any other).
 *
 * Nothing here imports the contract's schemas (the billing client is a type only), so a screen that only needs
 * the hook doesn't carry them.
 */

import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { BillingAction } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "../../api";
import type { BillingApi } from "../../billing-api";
import { billingErrorMessage } from "../../billing-errors";
import { ownerTypeOf, type BillingScope } from "../../billing-scope";
import { billingKeys, workspaceKeys } from "../../queries";
import { licenseStrings as t } from "../../strings/licenses";
import { buttonVariants } from "../../ui/button";

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

/** One press of a hosted-page button: the action billing listed, for a license (none for the account's), and how many seats `add_seats` adds. */
export interface HostedRequest {
  action: BillingAction;
  licenseId?: string;
  seats?: number;
}

export interface HostedAction {
  /** Starts the action. Call it from the click itself: a tab for a page that doesn't return can only be opened there. Ignored while one is under way. */
  run(request: HostedRequest): void;
  /** The `kind` of the action whose session is being requested, else null. */
  pending: string | null;
  /** Billing's refusal, in words; null when there is none. */
  error: string | null;
  /** Where a tab the browser blocked would have gone: shown as a link for a second click. */
  link: string | null;
}

/**
 * The hosted-page flow for one card or dialog. `product` is the name a refusal may mention ("A purchase of Fleet
 * is already under way"). `api` lets the window-focus refresh read the workspace's licenses again as well as
 * billing's status; without it (a person's page) only the status is refreshed.
 */
export function useHostedAction({
  billing,
  scope,
  navigateOut,
  api,
  product,
}: {
  billing: Pick<BillingApi, "session">;
  scope: BillingScope;
  navigateOut: NavigateOut;
  api?: Pick<WorkspaceApi, "basePath">;
  product?: string;
}): HostedAction {
  const client = useQueryClient();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const stopWaiting = useRef<(() => void) | null>(null);
  // The latest of what the callback reads, so `run` keeps one identity.
  const latest = useRef({ billing, scope, navigateOut, api, product });
  latest.current = { billing, scope, navigateOut, api, product };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopWaiting.current?.();
    };
  }, []);

  /** After a page that doesn't return: read again whenever the person comes back to this window. */
  const refreshOnReturn = useCallback(() => {
    if (stopWaiting.current) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      const { scope: current, api: workspaceApi } = latest.current;
      void client.invalidateQueries({ queryKey: billingKeys.statuses(current) });
      if (workspaceApi && current.kind === "workspace") {
        void client.invalidateQueries({ queryKey: workspaceKeys.licenses(workspaceApi, current.workspaceId) });
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    stopWaiting.current = () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      stopWaiting.current = null;
    };
  }, [client]);

  const run = useCallback(
    ({ action, licenseId, seats }: HostedRequest) => {
      if (busy.current) return;
      const { billing: api, scope: owner, navigateOut: out, product: name } = latest.current;
      const newTab = action.returns === false;
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
      setPending(action.kind);
      setError(null);
      setLink(null);
      const request = {
        action: action.kind,
        ...(licenseId !== undefined ? { licenseId } : {}),
        ...(seats !== undefined ? { seats } : {}),
      };
      void (async () => {
        try {
          const { url } = await api.session(owner, request);
          if (newTab) {
            if (tab) tab.go(url);
            else if (mounted.current) setLink(url);
            refreshOnReturn();
          } else {
            out.leave(url);
          }
        } catch (cause) {
          // Nothing to show in the tab, and nothing to wait for.
          try {
            tab?.close();
          } catch {
            // A tab that is already gone is the outcome wanted.
          }
          if (mounted.current) setError(billingErrorMessage(cause, { product: name, scope: ownerTypeOf(owner) }));
        } finally {
          busy.current = false;
          if (mounted.current) setPending(null);
        }
      })();
    },
    [refreshOnReturn],
  );

  return { run, pending, error, link };
}

/**
 * What a hosted action left to say: billing's refusal (an alert), and the link for a tab the browser blocked.
 * Renders nothing when there is neither.
 */
export function HostedFeedback({ action }: { action: Pick<HostedAction, "error" | "link"> }) {
  const hint = useId();
  if (action.error === null && action.link === null) return null;
  return (
    <div className="space-y-3">
      {action.error !== null ? (
        <p role="alert" className="rounded-notice bg-error text-error-foreground px-4 py-3 text-sm">
          {action.error}
        </p>
      ) : null}
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
