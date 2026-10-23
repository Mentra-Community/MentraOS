/**
 * How the shell's items go somewhere without knowing the host's router. An item has an address (`href`),
 * rendered with the host's own link component, or an action (`onSelect`), rendered as a button.
 */

import type { AnchorHTMLAttributes, ComponentType } from "react";

/** What the shell passes to the host's link component: an anchor's props, with an address. */
export type ShellLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

/**
 * The host's in-app link: the workspace portal's History-API `Link`, or a wrapper around a router's own
 * (`({href, ...props}) => <Link to={href} {...props} />`). It must render an `<a>` with the props it is
 * given, and call the given `onClick` before it navigates.
 */
export type ShellLinkComponent = ComponentType<ShellLinkProps>;

/** The default link: a plain anchor, so a click is a full page load. */
export function PlainLink(props: ShellLinkProps) {
  return <a {...props} />;
}

/** Where an item goes: an address, or an action the host runs. */
export type ShellTarget = { href: string; onSelect?: undefined } | { onSelect(): void; href?: undefined };

/** An item's icon: a lucide icon, or any component that takes a class name. */
export type ShellIcon = ComponentType<{ className?: string }>;

/**
 * Whether a click landed on a link (`selector`), or on a control marked `data-navigates`: one that goes
 * somewhere although it is not a link (an `onSelect` item). Either closes the mobile drawer and the
 * workspace menu.
 */
export function isNavigationClick(target: EventTarget | null, selector = "a[href]"): boolean {
  // Duck-typed rather than `instanceof Element`, which needs a DOM global: the check runs only on a click.
  const element = target as Partial<Pick<Element, "closest">> | null;
  return typeof element?.closest === "function" && element.closest(`${selector}, [data-navigates]`) !== null;
}
