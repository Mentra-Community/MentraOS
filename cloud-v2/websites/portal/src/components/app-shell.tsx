import { LogOut, Menu, MoreHorizontal, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import mentraLogo from "@/assets/mentra-logo.svg";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type NavItem = {
  key: string;
  label: string;
  icon: LucideIcon;
};

type AppShellProps = {
  /** Brand block under the logo. */
  brandTitle: string;
  brandSubtitle: string;
  /** Optional chip shown under the brand (e.g. role/org). */
  badge?: ReactNode;
  /** Sidebar nav items. */
  nav: readonly NavItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  /** Header title + description for the active page. */
  title: string;
  description: string;
  /** Optional right-aligned header action. */
  headerAction?: ReactNode;
  /** Account footer. */
  userEmail: string;
  accountLabel?: string;
  onSignOut?: () => void;
  signingOut?: boolean;
  children: ReactNode;
};

/**
 * Shared console shell — a faithful adaptation of the dev console's AppShell
 * (sidebar + sticky header + scroll area), wired to local page-state instead of
 * a router so it drops into the admin/portal single-page apps.
 */
export function AppShell({
  brandTitle,
  brandSubtitle,
  badge,
  nav,
  activeKey,
  onSelect,
  title,
  description,
  headerAction,
  userEmail,
  accountLabel,
  onSignOut,
  signingOut,
  children,
}: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

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
          "fixed inset-y-0 left-0 z-30 flex w-[248px] flex-col border-r border-[#e4e6e2] bg-white shadow-xl transition-transform duration-200 md:z-20 md:translate-x-0 md:shadow-none",
          mobileSidebarOpen ? "translate-x-0" : "-translate-x-full",
          sidebarCollapsed ? "md:w-[76px]" : "md:w-[248px]",
        )}
      >
        <div className="px-4 pb-4 pt-5">
          <div className="grid h-10 grid-cols-[40px_1fr] items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="size-10 rounded-[10px] text-[#5d6068] hover:bg-[#f3f4f2] hover:text-[#111217]"
              onClick={() => {
                if (mobileSidebarOpen) {
                  setMobileSidebarOpen(false);
                  return;
                }
                setSidebarCollapsed(value => !value);
              }}
              aria-label={mobileSidebarOpen ? "Close sidebar" : sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <Menu className="size-5" />
            </Button>
            <div className={cn("flex min-w-0 items-center gap-3", sidebarCollapsed && "md:hidden")}>
              <img src={mentraLogo} alt="" className="h-[22px] w-[41px] shrink-0" />
              <div className="min-w-0">
                <div className="truncate font-display text-[15px] font-bold leading-5 text-[#14151b]">{brandTitle}</div>
                <div className="truncate text-xs leading-4 text-[#8a8d95]">{brandSubtitle}</div>
              </div>
            </div>
          </div>

          {badge ? <div className={cn("mt-4", sidebarCollapsed && "md:hidden")}>{badge}</div> : null}
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {nav.map(item => {
            const Icon = item.icon;
            const active = activeKey === item.key;
            return (
              <Button
                key={item.key}
                variant="ghost"
                className={cn(
                  "h-10 w-full justify-start rounded-[10px] px-3 text-[15px] font-medium text-[#5d6068] hover:bg-[#f3f4f2]",
                  active && "bg-[#111217] text-white hover:bg-[#111217] hover:text-white focus:text-white",
                  sidebarCollapsed && "md:justify-center md:px-0",
                )}
                onClick={() => onSelect(item.key)}
              >
                <Icon className={cn("size-4", active && "text-white")} />
                <span className={cn(sidebarCollapsed && "md:hidden")}>{item.label}</span>
              </Button>
            );
          })}
        </nav>

        <div className={cn("relative px-4 pb-4", sidebarCollapsed && "md:hidden")}>
          {profileMenuOpen ? (
            <div className="absolute bottom-[64px] left-4 right-4 z-40 overflow-hidden rounded-[14px] border border-[#e0e4de] bg-white p-1 shadow-[0_12px_30px_rgba(20,21,27,0.14)]">
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
            <div className="flex size-9 items-center justify-center rounded-full bg-[#111217] text-xs font-semibold text-white">
              {initials(userEmail)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{userEmail}</div>
              <div className="truncate text-xs text-[#9a9da4]">{accountLabel ?? brandTitle}</div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 rounded-full text-[#747780] hover:bg-[#f3f4f2] hover:text-[#111217]"
              aria-label="Open account menu"
              aria-expanded={profileMenuOpen}
              onClick={() => setProfileMenuOpen(open => !open)}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </div>
        </div>
      </aside>

      <div
        className={cn(
          "h-dvh overflow-y-auto overflow-x-hidden overscroll-contain transition-[padding]",
          sidebarCollapsed ? "md:pl-[76px]" : "md:pl-[248px]",
        )}
      >
        <header className="sticky top-0 z-10 border-b border-[#e4e6e2] bg-white/88 backdrop-blur">
          <div className="mx-auto flex min-h-[68px] max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5 md:min-h-[76px] md:flex-nowrap md:px-8 md:py-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="size-10 shrink-0 rounded-[10px] text-[#5d6068] hover:bg-[#f3f4f2] hover:text-[#111217] md:hidden"
                onClick={() => setMobileSidebarOpen(true)}
                aria-label="Open sidebar"
              >
                <Menu className="size-5" />
              </Button>
              <div className="min-w-0">
                <h1 className="truncate font-display text-[20px] font-bold leading-7 text-[#14151b] md:text-[22px]">{title}</h1>
                <p className="mt-0.5 truncate text-xs text-[#747780] sm:text-sm">{description}</p>
              </div>
            </div>
            {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
          </div>
        </header>

        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-5 md:px-8">{children}</div>
      </div>
    </div>
  );
}

function initials(value: string): string {
  const local = value.split("@")[0] || "MD";
  return local
    .split(/[._\- ]+/)
    .filter(Boolean)
    .map(part => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
