import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrandPage, buttonVariants, Spinner, workspaceListQuery } from "@mentra/workspace-ui";
import { useEffect, useState } from "react";
import { PortalShell, TabWorkspaceProvider, useTabWorkspace } from "@/components/portal-shell";
import { SignedOutScreen } from "./components/signed-out";
import { fetchPortalMe, safeLocalStorage, type PortalMe } from "./lib/api";
import { DEVELOPER_CONSOLE_URL } from "./lib/config";
import { Redirect, setQueryParam, usePathname, useSearch } from "./lib/navigation";
import {
  expireSession,
  PORTAL_ME_KEY,
  PortalProvider,
  portalWorkspaceApi,
  usePortal,
  type PortalSession,
} from "./lib/portal";
import {
  currentWorkspace,
  INVITATION_PATH,
  invitationLanding,
  legacyRedirect,
  parseRoute,
  workspaceParam,
  type PortalRoute,
  type WorkspaceSection,
} from "./lib/routes";
import { loginHref, signOutOfEnterprisePortal } from "./lib/session";
import { usePortalInvitations } from "./lib/use-portal-invitations";
import { takePendingInvite } from "./lib/workspace-invite";
import { EnterpriseScreen } from "./pages/enterprise";
import { NotFoundMessage } from "./pages/not-found";
import { InvitationScreen, WelcomeScreen } from "./pages/welcome";
import { WorkspaceScreen } from "./pages/workspace";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <PortalPage />
    </QueryClientProvider>
  );
}

// An invitation link's token leaves the address bar before anything else runs (lib/workspace-invite), and
// the tab lands on the invitation screen, which reads the token from this tab's session storage.
const sessionStore = typeof window !== "undefined" ? safeSessionStorage() : null;
let initialInvite = typeof window !== "undefined"
  ? takePendingInvite(window.location, sessionStore, url => window.history.replaceState(null, "", invitationLanding(url)))
  : null;

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function PortalPage() {
  const qc = useQueryClient();
  const pathname = usePathname();
  const [signingOut, setSigningOut] = useState(false);
  const [signedOut, setSignedOut] = useState<{ signOutUrl: string | null } | null>(null);
  const me = useQuery({
    queryKey: PORTAL_ME_KEY,
    queryFn: fetchPortalMe,
    retry: false,
  });
  const accountEmail = me.data?.user.email?.trim() || null;
  const invites = usePortalInvitations({
    initialToken: initialInvite,
    signedIn: me.data !== undefined,
    accountEmail,
    pathname,
    sessionStore,
    localStore: safeLocalStorage(),
    onTokenForgotten: () => {
      initialInvite = null;
    },
  });

  if (signedOut) {
    return <SignedOutScreen signOutUrl={signedOut.signOutUrl} signInHref={invites.inviteToken ? INVITATION_PATH : "/"} />;
  }
  if (me.isLoading) return <Splash label="Checking your session" />;
  if (me.isError || !me.data) return <LoginGate invitePending={invites.inviteToken !== null} />;

  async function signOut() {
    setSigningOut(true);
    const result = await signOutOfEnterprisePortal();
    qc.clear();
    setSignedOut(result);
  }

  const session: PortalSession = {
    userEmail: me.data.user.email || "Signed in",
    accountEmail,
    creation: me.data.workspaceCreation ?? { allowed: false, reason: null },
    link: invites.link,
    invitations: invites.invitations,
    forgetInvitation: invites.forgetInvitation,
    signOut: () => void signOut(),
    signingOut,
    developerConsoleUrl: DEVELOPER_CONSOLE_URL,
    modules: me.data.modules,
    sessionExpired: () => expireSession(qc),
  };

  return (
    <PortalProvider value={session}>
      <PortalRoutes route={parseRoute(pathname)} me={me.data} />
    </PortalProvider>
  );
}

/**
 * The screen for an address. Needs a `PortalProvider` and a `QueryClientProvider`. `search` is the address's query
 * string; without it, the window's.
 */
export function PortalRoutes({ route, me, pathname, search }: { route: PortalRoute; me: PortalMe; pathname?: string; search?: string }) {
  return (
    <TabWorkspaceProvider>
      <RouteScreen route={route} me={me} pathname={pathname} search={search} />
    </TabWorkspaceProvider>
  );
}

function RouteScreen({ route, me, pathname, search }: { route: PortalRoute; me: PortalMe; pathname?: string; search?: string }) {
  const path = usePathname(pathname);
  const query = useSearch(search);
  switch (route.kind) {
    case "home":
      return <WorkspaceRoute section={null} search={query} me={me} />;
    case "section":
      return <WorkspaceRoute section={route.section} search={query} me={me} />;
    case "legacy-workspace": {
      // An older `/w/<id>[/<section>]` address: the same page at its short address, keeping its query.
      const hash = typeof window === "undefined" ? "" : window.location.hash;
      return <Redirect to={legacyRedirect(path, query, hash) ?? "/"} />;
    }
    case "invitation":
      return <InvitationRoute />;
    case "enterprise":
      return <EnterpriseScreen page={route.page} me={me} />;
    case "not-found":
      return (
        <PortalShell current={null} nav={[]} activeKey={null}>
          <NotFoundMessage kind="page" />
        </PortalShell>
      );
  }
}

/**
 * `/` and a section's address: the current workspace (`?workspace=`, else the last one opened from the person's
 * own list, else their first), or the first run when there is none.
 *
 * The remembered workspace is this tab's own (`TabWorkspaceProvider`): another tab's pick does not move this one.
 * A workspace opened from the person's list through `?workspace=` is remembered, and a `?workspace=` that names
 * what the bare address opens is dropped from the address in place. One the person is not in (an Organization Admin
 * at a customer's workspace) is neither remembered nor dropped: it never becomes the bare address.
 */
function WorkspaceRoute({ section, search, me }: { section: WorkspaceSection | null; search: string; me: PortalMe }) {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const { invitations } = usePortal();
  const tab = useTabWorkspace();
  const param = workspaceParam(search);
  const workspaces = list.data;
  const bare = workspaces ? currentWorkspace({ param: null, remembered: tab.remembered, workspaces }) : null;
  const current = param ?? bare;
  const inList = param !== null && (workspaces?.some(item => item.workspaceId === param) ?? false);

  useEffect(() => {
    if (!param || !inList) return;
    if (tab.remembered !== param) tab.remember(param);
  }, [param, inList, tab.remembered]);

  useEffect(() => {
    if (param && param === bare) setQueryParam("workspace", null, { replace: true });
  }, [param, bare]);

  if (workspaces === undefined && !list.isError) return <Splash label="Loading your workspaces" />;
  if (!current) {
    // The first run offers the person's invitations instead of creating a workspace, so it waits for them.
    if (invitations === undefined) return <Splash label="Looking for your invitations" />;
    return <WelcomeScreen />;
  }
  return <WorkspaceScreen key={current} workspaceId={current} bareWorkspaceId={bare} section={section} me={me} />;
}

/** `/invitation`: the invitation link this tab holds (or, once, that it is no longer valid); without one, home. */
function InvitationRoute() {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const { link } = usePortal();
  if (link.status === "none") return <Redirect to="/" />;
  if ((list.data === undefined && !list.isError) || link.status === "checking") return <Splash label="Loading your invitation" />;
  return <InvitationScreen />;
}

export function LoginGate({ invitePending = false, loginUrl = loginHref() }: { invitePending?: boolean; loginUrl?: string }) {
  return (
    <BrandPage title="Sign into Mentra Portal">
      <p className="text-muted-foreground mb-7">
        {invitePending
          ? "Sign in with the email address your invitation was sent to, then accept it."
          : "Manage your workspaces, their members, roles and invitations."}
      </p>
      <a className={buttonVariants({ size: "lg", className: "w-full" })} href={loginUrl}>
        Sign in
      </a>
      <p className="text-muted-foreground mt-6 text-sm">Sign in with your Mentra account.</p>
    </BrandPage>
  );
}

/** While the portal works something out: the sign-in page's spinner and what it is doing. */
function Splash({ label }: { label: string }) {
  return (
    <main role="status" className="bg-background text-muted-foreground flex min-h-dvh flex-col items-center justify-center gap-4">
      <Spinner className="size-7 border-[3px]" />
      {label}
    </main>
  );
}

export default App;
