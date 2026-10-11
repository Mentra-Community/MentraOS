import { LogOut, Menu, MoreHorizontal, X, type LucideIcon } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import mentraLogo from "@/assets/mentra-logo.svg";
import { Button } from "@/components/ui/button";
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

type AppShellProps = {
  /** The top of the sidebar, under the Mentra mark: the workspace switcher. */
  switcher: ReactNode;
  nav: readonly NavGroup[];
  activeKey: string | null;
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
 * sections and the account at the bottom, and a sticky page header over the content. On small screens
 * the sidebar is a drawer behind the menu button.
 */
export function AppShell({
  switcher,
  nav,
  activeKey,
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
      className="size-10 shrink-0 rounded-[10px] text-[#5d6068] hover:bg-[#f3f4f2] hover:text-[#111217] md:hidden"
      onClick={() => setMobileSidebarOpen(true)}
      aria-label="Open sidebar"
    >
      <Menu className="size-5" />
    </Button>
  );

  return (
    <div className="h-dvh overflow-hidden bg-[#f5f6f4] text-[#14151b]">
      {mobileSidebarOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-[#111217]/30 md:hidden"
          aria-label="Close sidebar"
          onClick={() => setMobileSidebarOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-[264px] flex-col border-r border-[#e4e6e2] bg-white shadow-xl transition-transform duration-200 md:z-20 md:translate-x-0 md:shadow-none",
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between px-5">
          <img src={mentraLogo} alt="Mentra" className="h-[20px] w-[37px]" />
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-[8px] text-[#5d6068] md:hidden"
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
                <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#a0a3aa]">{group.label}</div>
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
                        className={cn(
                          "flex h-9 items-center gap-3 rounded-[10px] px-3 text-[14px] font-medium text-[#5d6068] hover:bg-[#f3f4f2] hover:text-[#14151b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#36dd89]/60",
                          active && "bg-[#111217] text-white hover:bg-[#111217] hover:text-white",
                        )}
                      >
                        <Icon className={cn("size-4", active ? "text-white" : "text-[#8a8d95]")} />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <AccountFooter userEmail={userEmail} onSignOut={onSignOut} signingOut={signingOut} />
      </aside>

      <div className="h-dvh overflow-y-auto overflow-x-hidden overscroll-contain md:pl-[264px]">
        {title ? (
          <header className="sticky top-0 z-10 border-b border-[#e4e6e2] bg-white/88 backdrop-blur">
            <div className="mx-auto flex min-h-[68px] max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5 md:min-h-[76px] md:flex-nowrap md:px-8 md:py-4">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {menuButton}
                <div className="min-w-0">
                  <h1 className="truncate font-display text-[20px] font-bold leading-7 text-[#14151b] md:text-[22px]">{title}</h1>
                  {description ? <p className="mt-0.5 truncate text-xs text-[#747780] sm:text-sm">{description}</p> : null}
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
    <div ref={ref} className="relative shrink-0 border-t border-[#eceeeb] px-4 py-3">
      {open ? (
        <div className="absolute bottom-[62px] left-3 right-3 z-40 overflow-hidden rounded-[14px] border border-[#e0e4de] bg-white p-1 shadow-[0_12px_30px_rgba(20,21,27,0.14)]">
          <button
            type="button"
            className="flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-left text-sm font-medium text-[#a64235] hover:bg-[#fff3f1] disabled:opacity-60"
            disabled={signingOut}
            onClick={() => onSignOut?.()}
          >
            <LogOut className="size-4" />
            {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[#111217] text-xs font-semibold text-white">
          {accountInitials(userEmail)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{userEmail}</div>
          <div className="truncate text-xs text-[#9a9da4]">Account</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 rounded-full text-[#747780] hover:bg-[#f3f4f2] hover:text-[#111217]"
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

export function accountInitials(value: string): string {
  const local = value.split("@")[0] || "MD";
  return local
    .split(/[._\- ]+/)
    .filter(Boolean)
    .map(part => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
