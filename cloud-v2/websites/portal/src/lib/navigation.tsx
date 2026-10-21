/**
 * Client-side navigation on the History API: the current path as React state, `navigate` and `Link`.
 * The portal has a handful of routes (lib/routes), so it needs no router library.
 *
 * It also holds the portal's two ways out for a hosted page (`leavePortal`, `openPortalTab`: the host's side of
 * `@mentra/workspace-ui`'s `NavigateOut`) and the query parameters a page keeps in its address (`?member=`,
 * `?purchase=`).
 */

import { HostedUrlSchema } from "@mentra/workspace-contract/portal-billing";
import type { PortalTab } from "@mentra/workspace-ui";
import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

/** The current path. On the server (tests) it is `/` unless a test passes its own. */
export function usePathname(serverPath = "/"): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => serverPath,
  );
}

/** The current query string, with its `?` (or ""). On the server (tests) it is "" unless a test passes its own. */
export function useSearch(serverSearch = ""): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.search,
    () => serverSearch,
  );
}

/**
 * Go to `path` in this tab. `replace` swaps the current history entry (redirects). `state` is what the entry carries
 * (none, unless the caller marks it: see {@link openQueryParam}).
 */
export function navigate(path: string, options: { replace?: boolean; state?: unknown } = {}): void {
  if (`${window.location.pathname}${window.location.search}` === path && !options.replace) return;
  if (options.replace) window.history.replaceState(options.state ?? null, "", path);
  else window.history.pushState(options.state ?? null, "", path);
  for (const listener of listeners) listener();
}

// --- Query parameters ------------------------------------------------------------------------------------------

/** The query parameters pages keep in their address: the open member panel, and the purchase a checkout returned with. */
export type QueryParam = "member" | "purchase";

/** Sets (or, for null, removes) one query parameter, leaving the path and the other parameters as they are. */
export function setQueryParam(name: QueryParam, value: string | null, options: { replace?: boolean; state?: unknown } = {}): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get(name) === value) return;
  if (value === null) url.searchParams.delete(name);
  else url.searchParams.set(name, value);
  navigate(`${url.pathname}${url.search}${url.hash}`, options);
}

/** What an entry carries when this module pushed it to open a panel: the parameter it opened. */
const OPENED_BY_PORTAL = "portalOpened";

/**
 * Opens a panel the address carries (`?member=`): a new history entry, so that Back closes it. Where the panel is
 * already open (another member chosen), the address changes in place and the one Back still closes it.
 */
export function openQueryParam(name: QueryParam, value: string): void {
  if (new URL(window.location.href).searchParams.has(name)) {
    setQueryParam(name, value, { replace: true, state: window.history.state });
    return;
  }
  setQueryParam(name, value, { state: { [OPENED_BY_PORTAL]: name } });
}

/**
 * Closes a panel the address carries. A panel this module opened goes back out of its entry (so Back does not land
 * on a second copy of the page without it); one the address opened (a link, a reload) just loses its parameter.
 */
export function closeQueryParam(name: QueryParam): void {
  const opened = (window.history.state as { [OPENED_BY_PORTAL]?: string } | null)?.[OPENED_BY_PORTAL] === name;
  if (opened && new URL(window.location.href).searchParams.has(name)) window.history.back();
  else setQueryParam(name, null, { replace: true });
}

// --- Leaving the portal ----------------------------------------------------------------------------------------

/**
 * The address of a hosted page, as the portal may follow it, or a throw: `https:`, or `http:` to `localhost` or
 * `127.0.0.1` for development, with no credentials in it (the contract's `HostedUrlSchema`, the same check billing's
 * client makes). The client has checked every address before it gets here; this is the last look, by whoever is about
 * to navigate, so that no caller can send the browser to a `javascript:` or `data:` address.
 */
function hostedHref(url: string): string {
  const parsed = HostedUrlSchema.safeParse(url);
  if (!parsed.success) throw new Error("The portal does not follow that address.");
  return parsed.data;
}

/** Sends this tab to a hosted page (an action that returns, and every purchase). */
export function leavePortal(url: string): void {
  window.location.assign(hostedHref(url));
}

/**
 * Opens a blank tab for a hosted page that does not return (an invoice's payment page), and must be called in the
 * click itself: a browser lets a page open a tab only while it handles one. The tab is sent on once billing has
 * answered (`go`) or closed if it won't (`close`). Null when the browser blocked it, and then the caller offers the page
 * as a link.
 *
 * Not opened with `noopener`, which would leave nothing to send on; the tab's `opener` is cleared at once instead,
 * while it is still blank and ours, so the hosted page cannot reach back to the portal. A tab that won't let go of its
 * opener is closed and not used (null), so the link, which is `rel="noopener"`, is the way there instead.
 *
 * `go` returns false when the person closed the blank tab while billing answered, which is not a failure: the caller
 * offers the page as a link for a second click. An address the portal won't follow closes the tab and throws.
 */
export function openPortalTab(): PortalTab | null {
  let tab: Window | null;
  try {
    tab = window.open("", "_blank");
  } catch {
    return null;
  }
  if (!tab || tab.closed) return null;
  const opened = tab;
  try {
    opened.opener = null;
  } catch {
    // The hosted page would keep a way back to the portal: not a tab to send anywhere.
    try {
      opened.close();
    } catch {
      // A tab that is already gone is the outcome wanted.
    }
    return null;
  }
  return {
    go(url) {
      let href: string;
      try {
        href = hostedHref(url);
      } catch (error) {
        opened.close();
        throw error;
      }
      if (opened.closed) return false;
      opened.location.replace(href);
      return true;
    },
    close() {
      opened.close();
    },
  };
}

/** Replaces the address with `to` once rendered: for routes that only send you elsewhere. */
export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

/**
 * An in-app link. A plain click navigates without a reload; a modified click (new tab, new window) is
 * left to the browser, so every link also works as a real address.
 */
export function Link({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  function click(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  }
  return <a href={href} onClick={click} {...props} />;
}
