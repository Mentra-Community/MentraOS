import { ArrowUpRight, LogOut, Menu, MoreHorizontal, X } from "lucide-react";
import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Avatar } from "../components/common";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";
import { MentraMark } from "./brand";
import { isNavigationClick, PlainLink, type ShellIcon, type ShellLinkComponent, type ShellTarget } from "./link";
import { useDismiss } from "./use-dismiss";

/** A sidebar or account-menu item: an address (`href`) or an action (`onSelect`). */
export type NavItem = ShellTarget & {
  key: string;
  label: string;
  icon: ShellIcon;
};

/** A link to another site, under the sidebar's sections. It always opens in a new tab. */
export type ExternalNavItem = {
  key: string;
  label: string;
  icon: ShellIcon;
  href: string;
};

/** A labelled run of sidebar items. A group with no items renders nothing, label included. */
export type NavGroup = {
  key: string;
  label?: string;
  items: readonly NavItem[];
};

const NAV_ITEM_CLASS =
  "text-foreground hover:bg-hover flex h-10 items-center gap-3 rounded-full px-4 text-[15px] font-semibold transition-colors";

const MENU_ITEM_CLASS =
  "hover:bg-hover flex h-10 w-full items-center gap-3 rounded-full px-3.5 text-left text-[15px] font-semibold";

/** What a `<button>` needs to sit in a list of links with the same look. */
const BUTTON_ITEM_CLASS = "w-full cursor-pointer text-left";

export type AppShellProps = {
  /** The site's name beside the Mentra mark: "Mentra Portal", "Developer Console". */
  brandTitle: string;
  /** Under the name, smaller: the platform ("MentraOS"). */
  brandSubtitle?: string;
  /**
   * The host's in-app link, for every `href` item (sections, account items). Defaults to a plain anchor.
   * Links to other sites (`links`) are always plain anchors that open a new tab.
   */
  linkComponent?: ShellLinkComponent;
  /** The top of the sidebar, under the brand: the workspace switcher. */
  switcher?: ReactNode;
  nav: readonly NavGroup[];
  /** Whether `item` is the page open now. It is marked `aria-current="page"` and drawn filled. */
  active?: (item: NavItem) => boolean;
  /** The sidebar navigation's name for assistive technology: "Workspace" for a workspace's sections, "Account" for the person's. */
  navLabel?: string;
  /** Links to other Mentra sites, above the account footer. Each opens in a new tab. */
  links?: readonly ExternalNavItem[];
  /** The person's own pages and actions, which the account menu offers above Sign out ("Billing"). */
  accountItems?: readonly NavItem[];
  /** The page header. Without a title there is no header (a full-page message), only the mobile menu bar. */
  title?: ReactNode;
  description?: ReactNode;
  headerAction?: ReactNode;
  /** Account footer: the signed-in address, shown when the person has no name. */
  userEmail: string;
  /** The signed-in person's name from sign-in; the footer shows it in place of the address. */
  userName?: string | null;
  onSignOut?: () => void;
  signingOut?: boolean;
  children: ReactNode;
};

/**
 * Mentra's site frame, as the workspace portal draws it: a sidebar with the brand and the workspace
 * switcher on top, the current workspace's sections, links to other Mentra sites and the account at the
 * bottom, and a sticky page header over the content. On small screens the sidebar is a drawer behind the
 * menu button. It knows no router: `href` items render through `linkComponent`, `onSelect` items as
 * buttons, and the host says which item is `active`.
 */
export function AppShell({
  brandTitle,
  brandSubtitle,
  linkComponent: Link = PlainLink,
  switcher,
  nav,
  active,
  navLabel = "Workspace",
  links = [],
  accountItems = [],
  title,
  description,
  headerAction,
  userEmail,
  userName,
  onSignOut,
  signingOut,
  children,
}: AppShellProps) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const closeDrawer = (event: MouseEvent) => {
    if (isNavigationClick(event.target)) setMobileSidebarOpen(false);
  };
  const groups = nav.filter(group => group.items.length > 0);
  const menuButton = (
    <Button
      variant="ghost"
      size="icon"
      className="-ml-2 md:hidden"
      onClick={() => setMobileSidebarOpen(true)}
      aria-label="Open sidebar"
    >
      <Menu className="size-5" />
    </Button>
  );

  return (
    <div className="bg-background text-foreground h-dvh overflow-hidden">
      {mobileSidebarOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-black/45 backdrop-blur-[4px] md:hidden"
          aria-label="Close sidebar"
          onClick={() => setMobileSidebarOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          "bg-background fixed inset-y-0 left-0 z-30 flex w-[264px] flex-col border-r transition-transform duration-200 md:z-20 md:translate-x-0 md:shadow-none",
          mobileSidebarOpen ? "shadow-dialog translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between gap-3 pr-3 pl-6">
          {/* The admin portal's header: the mark, the site's name and the platform under it. */}
          <div className="flex min-w-0 items-center gap-3">
            <MentraMark className="h-[22px] shrink-0" />
            <div className="min-w-0">
              <div className="font-display truncate text-[15px] leading-5 font-bold text-foreground">{brandTitle}</div>
              {brandSubtitle ? (
                <div className="truncate text-xs leading-4 text-muted-foreground">{brandSubtitle}</div>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground md:hidden"
            onClick={() => setMobileSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            <X className="size-4" />
          </Button>
        </div>

        {switcher ? (
          <div className="shrink-0 px-3" onClick={closeDrawer}>
            {switcher}
          </div>
        ) : null}

        <nav aria-label={navLabel} className="mt-5 flex-1 space-y-6 overflow-y-auto px-3 pb-4" onClick={closeDrawer}>
          {groups.map(group => (
            <div key={group.key}>
              {group.label ? (
                <div className="text-muted-foreground px-4 pb-2 text-xs font-semibold">{group.label}</div>
              ) : null}
              <ul className="space-y-0.5">
                {group.items.map(item => (
                  <li key={item.key}>
                    <NavEntry item={item} active={active?.(item) ?? false} Link={Link} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        {links.length > 0 ? (
          <ul className="shrink-0 space-y-0.5 px-3 pb-3" onClick={closeDrawer}>
            {links.map(item => {
              const Icon = item.icon;
              return (
                <li key={item.key}>
                  <a href={item.href} target="_blank" rel="noreferrer" className={NAV_ITEM_CLASS}>
                    <Icon className="text-muted-foreground size-[18px]" />
                    {item.label}
                    <ArrowUpRight className="text-muted-foreground ml-auto size-4" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </li>
              );
            })}
          </ul>
        ) : null}

        <AccountFooter
          userEmail={userEmail}
          userName={userName}
          items={accountItems}
          linkComponent={Link}
          onNavigate={() => setMobileSidebarOpen(false)}
          onSignOut={onSignOut}
          signingOut={signingOut}
        />
      </aside>

      <div className="h-dvh overflow-y-auto overflow-x-hidden overscroll-contain md:pl-[264px]">
        {title ? (
          <header className="bg-background/90 sticky top-0 z-10 border-b backdrop-blur">
            <div className="mx-auto flex min-h-[68px] max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5 md:min-h-[84px] md:flex-nowrap md:px-8 md:py-4">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {menuButton}
                <div className="min-w-0">
                  <h1 className="truncate text-xl leading-tight font-semibold md:text-2xl">{title}</h1>
                  {description ? <p className="text-muted-foreground mt-1 truncate text-sm">{description}</p> : null}
                </div>
              </div>
              {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
            </div>
          </header>
        ) : (
          <div className="px-4 pt-3 md:hidden">{menuButton}</div>
        )}

        <main className="mx-auto max-w-5xl px-4 py-6 sm:px-5 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}

/** One sidebar section: a link through the host's `Link`, or a button that runs `onSelect`. */
function NavEntry({ item, active, Link }: { item: NavItem; active: boolean; Link: ShellLinkComponent }) {
  const Icon = item.icon;
  const content = (
    <>
      <Icon className={cn("size-[18px]", active ? "text-primary-foreground" : "text-muted-foreground")} />
      {item.label}
    </>
  );
  const className = cn(NAV_ITEM_CLASS, active && "bg-primary text-primary-foreground hover:bg-primary");
  if (item.href !== undefined) {
    return (
      <Link href={item.href} aria-current={active ? "page" : undefined} className={className}>
        {content}
      </Link>
    );
  }
  return (
    <button
      type="button"
      data-navigates=""
      aria-current={active ? "page" : undefined}
      className={cn(className, BUTTON_ITEM_CLASS)}
      onClick={item.onSelect}
    >
      {content}
    </button>
  );
}

/**
 * The account at the bottom of the sidebar: who is signed in, and a menu with the person's own pages and
 * actions (`items`, such as Billing) above Sign out. `defaultOpen` opens the menu, for a render with no clicks.
 */
export function AccountFooter({
  userEmail,
  userName,
  items = [],
  linkComponent: Link = PlainLink,
  onNavigate,
  onSignOut,
  signingOut,
  defaultOpen = false,
}: {
  userEmail: string;
  /** The person's name: shown in place of the address (which stays as the tooltip). */
  userName?: string | null;
  items?: readonly NavItem[];
  /** The host's in-app link, for `href` items. Defaults to a plain anchor. */
  linkComponent?: ShellLinkComponent;
  /** An item was chosen: the shell closes its mobile drawer. */
  onNavigate?: () => void;
  onSignOut?: () => void;
  signingOut?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div ref={ref} className="relative shrink-0 border-t px-4 py-3">
      {open ? (
        <div className="rounded-menu bg-popover shadow-menu absolute right-3 bottom-[66px] left-3 z-40 overflow-hidden border p-1.5">
          {items.map(item => {
            const Icon = item.icon;
            if (item.href !== undefined) {
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={MENU_ITEM_CLASS}
                  onClick={() => {
                    close();
                    onNavigate?.();
                  }}
                >
                  <Icon className="size-4" />
                  {item.label}
                </Link>
              );
            }
            const onSelect = item.onSelect;
            return (
              <button
                key={item.key}
                type="button"
                className={cn(MENU_ITEM_CLASS, "cursor-pointer")}
                onClick={() => {
                  close();
                  onNavigate?.();
                  onSelect();
                }}
              >
                <Icon className="size-4" />
                {item.label}
              </button>
            );
          })}
          <button
            type="button"
            className={cn(MENU_ITEM_CLASS, "disabled:opacity-45")}
            disabled={signingOut}
            onClick={() => onSignOut?.()}
          >
            <LogOut className="size-4" />
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <Avatar label={userName?.trim() || userEmail} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={userName?.trim() ? userEmail : undefined}>
            {userName?.trim() || userEmail}
          </div>
          <div className="text-muted-foreground truncate text-xs">Account</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label="Open account menu"
          aria-expanded={open}
          onClick={() => setOpen(value => !value)}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </div>
    </div>
  );
}
