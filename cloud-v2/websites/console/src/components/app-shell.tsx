import { Link, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Boxes, Building2, FileText, Home, KeyRound, LogOut, Menu, MoreHorizontal } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { isUnauthorizedError, redirectToConsoleLogin } from "@/api/http";
import mentraLogo from "@/assets/mentra-logo.svg";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  displayNameForUser,
  initialsForUser,
  logoutConsoleSession,
  selectConsoleOrganization,
} from "@/features/session/session.api";
import { sessionQuery } from "@/features/session/session.queries";
import { DevOnboarding } from "@/features/org/org-onboarding";
import { OnboardingShell } from "@/components/onboarding-shell";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui-store";

const navItems = [
  { label: "Home", to: "/dashboard", icon: Home },
  { label: "Miniapps", to: "/apps", icon: Boxes },
  { label: "CLI & API keys", to: "/tokens", icon: KeyRound },
  { label: "Organization", to: "/organization", icon: Building2 },
] as const;

const pageTitles: Record<string, { title: string; description: string }> = {
  "/dashboard": {
    title: "Home",
    description: "Build and publish miniapps for MentraOS.",
  },
  "/apps": {
    title: "Miniapps",
    description: "Manage package identity, releases, and listings.",
  },
  "/tokens": {
    title: "CLI & API keys",
    description: "Manage CLI login and API keys for CI/CD.",
  },
  "/organization": {
    title: "Organization",
    description: "Set your org prefix and team identity.",
  },
};
const fallbackPageTitle = pageTitles["/dashboard"]!;

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const pathname = useRouterState({ select: state => state.location.pathname });
  const sidebarCollapsed = useUiStore(state => state.sidebarCollapsed);
  const toggleSidebar = useUiStore(state => state.toggleSidebar);
  const session = useQuery(sessionQuery());
  const user = session.data?.user;
  const sessionReady = session.isSuccess;
  const onboardingRequired = sessionReady ? session.data.onboardingRequired : false;
  const email = user?.email;
  const profileName = user ? displayNameForUser(user) : "Loading";
  const initials = user ? initialsForUser(user) : "";
  const page =
    pageTitles[pathname] ??
    (pathname.startsWith("/apps/")
      ? { title: "Miniapp", description: "Package identity, releases, and review status." }
      : fallbackPageTitle);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const developerOrgs = useMemo(() => {
    const orgs = session.data?.organizations;
    if (orgs?.length) return orgs;
    return [];
  }, [session.data?.organizationId, session.data?.organizations, session.data?.packagePrefix]);
  const selectedOrgId = session.data?.organizationId ?? developerOrgs[0]?.id ?? "default";
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const logout = useMutation({
    mutationFn: logoutConsoleSession,
    onSuccess: ({ logoutUrl }) => {
      window.location.href = logoutUrl ?? "/";
    },
  });
  const selectOrganization = useMutation({
    mutationFn: selectConsoleOrganization,
    onSuccess: () => window.location.reload(),
  });

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [pathname]);

  useEffect(() => {
    setProfileMenuOpen(false);
  }, [pathname, sidebarCollapsed]);

  useEffect(() => {
    if (isUnauthorizedError(session.error)) {
      redirectToConsoleLogin();
    }
  }, [session.error]);

  if (session.isPending) {
    return <ConsoleLoadingState />;
  }

  if (session.isError) {
    if (isUnauthorizedError(session.error)) {
      return <ConsoleLoadingState label="Redirecting to sign in..." />;
    }

    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#f5f6f4] px-4 text-[#14151b]">
        <section className="w-full max-w-md rounded-[18px] border border-[#e0e4de] bg-white p-6 text-center shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
          <img src={mentraLogo} alt="" className="mx-auto h-[24px] w-[45px]" />
          <h1 className="mt-5 font-display text-xl font-bold">Could not load console</h1>
          <p className="mt-2 text-sm leading-6 text-[#747780]">
            {session.error instanceof Error ? session.error.message : "Refresh the page or sign in again."}
          </p>
          <Button className="mt-5 h-10 rounded-full bg-[#111217] px-5 text-white hover:bg-[#25262c]" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </section>
      </main>
    );
  }

  // Onboarding gate: a developer with no org gets a dedicated, nav-free shell —
  // no sidebar links to bounce off of. This supersedes whatever route they're on
  // until they belong to an org, so the gate is inescapable by design.
  if (sessionReady && onboardingRequired) {
    return (
      <OnboardingShell
        userLabel={profileName}
        onSignOut={() => logout.mutate()}
        signingOut={logout.isPending}
      >
        <DevOnboarding />
      </OnboardingShell>
    );
  }

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
          <div className="space-y-4">
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
                  toggleSidebar();
                }}
                aria-label={mobileSidebarOpen ? "Close sidebar" : sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                <Menu className="size-5" />
              </Button>
              <div className={cn("min-w-0", sidebarCollapsed && "md:hidden")}>
                <Link to="/dashboard" className="flex min-w-0 items-center gap-3 rounded-[10px] outline-none focus-visible:ring-3 focus-visible:ring-[#9dddc7]/25">
                  <img src={mentraLogo} alt="" className="h-[22px] w-[41px] shrink-0" />
                  <div className="min-w-0">
                    <div className="truncate font-display text-[15px] font-bold leading-5 text-[#14151b]">
                      Dev Console
                    </div>
                    <div className="truncate text-xs leading-4 text-[#8a8d95]">
                      MentraOS
                    </div>
                  </div>
                </Link>
              </div>
            </div>
            <div className={cn(sidebarCollapsed && "md:hidden")}>
              {developerOrgs.length > 0 ? (
                <>
                  <Select
                  value={selectedOrgId}
                  disabled={selectOrganization.isPending}
                  onValueChange={organizationId => {
                    if (organizationId !== selectedOrgId) selectOrganization.mutate(organizationId);
                  }}
                  >
                    <SelectTrigger className="h-10 w-full rounded-[10px] border-[#e0e4de] bg-[#f7f8f6] px-3 shadow-none focus:ring-0 focus-visible:ring-0">
                      <div className="flex min-w-0 items-center gap-3">
                        <Building2 className="size-4 shrink-0 text-[#747780]" />
                        <div className="min-w-0 text-left">
                          <div className="truncate text-sm font-medium leading-5">
                            <SelectValue />
                          </div>
                        </div>
                      </div>
                    </SelectTrigger>
                    <SelectContent align="start" className="w-[210px] rounded-[12px] border-[#e4e6e2] bg-white p-1 shadow-lg">
                      {developerOrgs.map(org => (
                        <SelectItem key={org.id} value={org.id} className="rounded-[9px] py-2">
                          {org.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectOrganization.error ? (
                    <p className="mt-1 px-1 text-xs text-red-700">
                      {selectOrganization.error instanceof Error
                        ? selectOrganization.error.message
                        : "Could not switch organization"}
                    </p>
                  ) : null}
                </>
              ) : sessionReady ? (
                <Link
                  to="/organization"
                  className="flex h-10 items-center gap-3 rounded-[10px] border border-[#e0e4de] bg-[#f7f8f6] px-3 text-sm font-medium text-[#1c1d22] outline-none focus-visible:ring-3 focus-visible:ring-[#9dddc7]/25"
                >
                  <Building2 className="size-4 shrink-0 text-[#747780]" />
                  Create organization
                </Link>
              ) : (
                <div className="flex h-10 items-center gap-3 rounded-[10px] border border-[#e0e4de] bg-[#f7f8f6] px-3 text-sm font-medium text-[#8a8d95]">
                  <Building2 className="size-4 shrink-0 text-[#a0a3aa]" />
                  Loading org
                </div>
              )}
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {navItems.map(item => {
            const Icon = item.icon;
            const active = pathname === item.to;
            return (
              <Button
                key={item.label}
                asChild
                variant="ghost"
                className={cn(
                  "h-10 w-full justify-start rounded-[10px] px-3 text-[15px] font-medium text-[#5d6068] hover:bg-[#f3f4f2]",
                  active && "bg-[#111217] text-white hover:bg-[#111217] hover:text-white focus:text-white",
                  sidebarCollapsed && "md:justify-center md:px-0",
                )}
              >
                <Link to={item.to}>
                  <Icon className={cn("size-4", active && "text-white")} />
                  <span className={cn(sidebarCollapsed && "md:hidden")}>{item.label}</span>
                </Link>
              </Button>
            );
          })}

          <div className={cn("pt-7", sidebarCollapsed && "md:hidden")}>
              <div className="px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[#a0a3aa]">Resources</div>
              <Button
                asChild
                variant="ghost"
                className="mt-2 h-10 w-full justify-start rounded-[10px] px-3 text-[15px] font-medium text-[#5d6068] hover:bg-[#f3f4f2]"
              >
                <a href="https://docs.mentra.glass" target="_blank" rel="noreferrer">
                  <FileText className="size-4" />
                  Docs & SDK
                </a>
              </Button>
          </div>
        </nav>

        <div className={cn("relative px-4 pb-4", sidebarCollapsed && "md:hidden")}>
          {profileMenuOpen ? (
            <div className="absolute bottom-[72px] left-4 right-4 z-40 overflow-hidden rounded-[14px] border border-[#e0e4de] bg-white p-1 shadow-[0_12px_30px_rgba(20,21,27,0.14)]">
              <button
                type="button"
                className="flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-left text-sm font-medium text-[#a64235] hover:bg-[#fff3f1]"
                disabled={logout.isPending}
                onClick={() => logout.mutate()}
              >
                <LogOut className="size-4" />
                {logout.isPending ? "Signing out..." : "Sign out"}
              </button>
            </div>
          ) : null}
          <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-full bg-[#111217] text-xs font-semibold text-white">
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{profileName}</div>
                {email ? <div className="truncate text-xs text-[#9a9da4]">{email}</div> : null}
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

      <div className={cn("h-dvh overflow-y-auto overflow-x-hidden overscroll-contain transition-[padding]", sidebarCollapsed ? "md:pl-[76px]" : "md:pl-[248px]")}>
        <header className="sticky top-0 z-10 border-b border-[#e4e6e2] bg-white/88 backdrop-blur">
          <div className="flex min-h-[68px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5 md:min-h-[76px] md:flex-nowrap md:px-8 md:py-4">
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
                <h1 className="truncate font-display text-[20px] font-bold leading-7 text-[#14151b] md:text-[22px]">{page.title}</h1>
                <p className="mt-0.5 truncate text-xs text-[#747780] sm:text-sm">{page.description}</p>
              </div>
            </div>
          </div>
        </header>

        {children}
      </div>
    </div>
  );
}

function ConsoleLoadingState({ label = "Loading console..." }: { label?: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#f5f6f4] px-4 text-[#14151b]">
      <section className="flex items-center gap-3 rounded-full border border-[#e0e4de] bg-white px-4 py-3 text-sm font-medium text-[#5d6068] shadow-[0_1px_2px_rgba(20,21,27,0.06)]">
        <img src={mentraLogo} alt="" className="h-[18px] w-[34px]" />
        {label}
      </section>
    </main>
  );
}
