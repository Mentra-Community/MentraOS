/**
 * Client-side navigation on the History API: the current path as React state, `navigate` and `Link`.
 * The portal has a handful of routes (lib/routes), so it needs no router library.
 */

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

/** Go to `path` in this tab. `replace` swaps the current history entry (redirects). */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (`${window.location.pathname}${window.location.search}` === path && !options.replace) return;
  if (options.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  for (const listener of listeners) listener();
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
