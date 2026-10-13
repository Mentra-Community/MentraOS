import { Avatar, Button } from "@mentra/workspace-ui";
import { ArrowUpRight, LogOut, Menu, MoreHorizontal, X, type LucideIcon } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { MentraLogo } from "@/components/brand";
import { Link } from "@/lib/navigation";
import { useDismiss } from "@/lib/use-dismiss";
import { cn } from "@/lib/utils";

export type NavItem = {
  key: string;
  label: string;
  icon: LucideIcon;
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

type AppShellProps = {
  /** The top of the sidebar, under the Mentra mark: the workspace switcher. */
  switcher: ReactNode;
  nav: readonly NavGroup[];
  activeKey: string | null;
  /** Links to other Mentra sites, above the account footer. Each opens in a new tab. */
  links?: readonly NavItem[];
  /** The page header. Without a title there is no header (a full-page message), only the mobile menu bar. */
  title?: string;
  description?: string;
  headerAction?: ReactNode;
  /** Account footer. */
  userEmail: string;
  onSignOut?: () => void;
  signingOut?: boolean;
  children: ReactNode;
};

/**
 * The workspace portal's frame: a sidebar with the workspace switcher on top, the current workspace's
 * sections, links to other Mentra sites and the account at the bottom, and a sticky page header over
 * the content. On small screens the sidebar is a drawer behind the menu button.
 */
export function AppShell({
  switcher,
  nav,
  activeKey,
  links = [],
  title,
  description,
  headerAction,
  userEmail,
  onSignOut,
  signingOut,
  children,
}: AppShellProps) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
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
        <div className="flex h-16 shrink-0 items-center justify-between pr-3 pl-6">
          <MentraLogo className="h-[22px]" />
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

        <div className="shrink-0 px-3" onClick={event => closeOnNavigation(event, () => setMobileSidebarOpen(false))}>
          {switcher}
        </div>

        <nav
          aria-label="Workspace"
          className="mt-5 flex-1 space-y-6 overflow-y-auto px-3 pb-4"
          onClick={event => closeOnNavigation(event, () => setMobileSidebarOpen(false))}
        >
          {groups.map(group => (
            <div key={group.key}>
              {group.label ? (
                <div className="text-muted-foreground px-4 pb-2 text-xs font-semibold">{group.label}</div>
              ) : null}
              <ul className="space-y-0.5">
                {group.items.map(item => {
                  const Icon = item.icon;
                  const active = activeKey === item.key;
                  return (
                    <li key={item.key}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(NAV_ITEM_CLASS, active && "bg-primary text-primary-foreground hover:bg-primary")}
                      >
                        <Icon className={cn("size-[18px]", active ? "text-primary-foreground" : "text-muted-foreground")} />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {links.length > 0 ? (
          <ul
            className="shrink-0 space-y-0.5 px-3 pb-3"
            onClick={event => closeOnNavigation(event, () => setMobileSidebarOpen(false))}
          >
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

        <AccountFooter userEmail={userEmail} onSignOut={onSignOut} signingOut={signingOut} />
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

/** A click on a link inside the drawer closes the drawer (on desktop it is not a drawer, so nothing changes). */
function closeOnNavigation(event: React.MouseEvent, close: () => void) {
  if (event.target instanceof Element && event.target.closest("a[href]")) close();
}

function AccountFooter({ userEmail, onSignOut, signingOut }: { userEmail: string; onSignOut?: () => void; signingOut?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div ref={ref} className="relative shrink-0 border-t px-4 py-3">
      {open ? (
        <div className="rounded-menu bg-popover shadow-menu absolute right-3 bottom-[66px] left-3 z-40 overflow-hidden border p-1.5">
          <button
            type="button"
            className="hover:bg-hover flex h-10 w-full items-center gap-3 rounded-full px-3.5 text-left text-[15px] font-semibold disabled:opacity-45"
            disabled={signingOut}
            onClick={() => onSignOut?.()}
          >
            <LogOut className="size-4" />
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <Avatar label={userEmail} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{userEmail}</div>
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
