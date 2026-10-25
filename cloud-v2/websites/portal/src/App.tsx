import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrandPage, Button, buttonVariants, Spinner, WorkspaceApiError, workspaceKeys, workspaceListQuery } from "@mentra/workspace-ui";
import { useEffect, useRef, useState } from "react";
import { PortalCenteredLayout, PortalShell, TabWorkspaceProvider, useTabWorkspace } from "@/components/portal-shell";
import { SignedOutScreen } from "./components/signed-out";
import { fetchPortalMe, fetchPublicProductName, safeLocalStorage, type PortalMe } from "./lib/api";
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
import { loginHref, signOut as signOutEverywhere } from "./lib/session";
import { usePortalInvitations } from "./lib/use-portal-invitations";
import { takePendingInvite } from "./lib/workspace-invite";
import { EnterpriseScreen } from "./pages/enterprise";
import { NotFoundMessage } from "./pages/not-found";
import { InvitationScreen, InvitationsUnavailable, WelcomeScreen } from "./pages/welcome";
import { buyParam } from "./pages/licenses";
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
  // Signing out, then on the way to Core's sign-out ("leaving"), or signed out here without one ("signed-out").
  const [signOutState, setSignOutState] = useState<"signing-out" | "leaving" | "signed-out" | null>(null);
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

  // On the way to Core's sign-out, which signs the person out of their Mentra account and brings them back to `/`.
  if (signOutState === "leaving") return <Splash label="Signing out" />;
  if (signOutState === "signed-out") return <SignedOutScreen signInHref={invites.inviteToken ? INVITATION_PATH : "/"} />;
  if (me.isLoading) return <Splash label="Checking your session" />;
  if (me.isError || !me.data) return <LoginGate invitePending={invites.inviteToken !== null} />;

  async function signOut() {
    setSignOutState("signing-out");
    const outcome = await signOutEverywhere();
    if (outcome === "signed-out") qc.clear();
    setSignOutState(outcome);
  }

  const session: PortalSession = {
    userEmail: me.data.user.email || "Signed in",
    accountEmail,
    creation: me.data.workspaceCreation ?? { allowed: false, reason: null },
    link: invites.link,
    invitations: invites.invitations,
    invitationsUnavailable: invites.unavailable,
    forgetInvitation: invites.forgetInvitation,
    signOut: () => void signOut(),
    signingOut: signOutState !== null,
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
 * The first run keeps the address it was opened at, so a `?buy=` survives both the workspace made for the person and
 * an invitation they accept. It asks Core for a workspace (`ensure`) only when nothing else is left to offer: no
 * `?workspace=` (the person came to a workspace by its id), no invitation they can accept, invitations that were
 * all read (a dropped connection or a 5xx on the link's lookup or the person's list holds it back, with Try again),
 * and a deployment that lets them have one.
 *
 * The remembered workspace is this tab's own (`TabWorkspaceProvider`): another tab's pick does not move this one.
 * A workspace opened from the person's list through `?workspace=` is remembered, and a `?workspace=` that names
 * what the bare address opens is dropped from the address in place. One the person is not in (an Organization Admin
 * at a customer's workspace) is neither remembered nor dropped: it never becomes the bare address.
 */
function WorkspaceRoute({ section, search, me }: { section: WorkspaceSection | null; search: string; me: PortalMe }) {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const { invitations, invitationsUnavailable, creation } = usePortal();
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

  // An invitation the person can accept comes first: the first run shows it in place and makes nothing. One for
  // another account does not count. Nothing is made while the list or the invitations are still being looked up.
  const acceptable = invitations?.filter(invitation => !invitation.forOtherAccount) ?? [];
  const unreadable = invitationsUnavailable ?? null;
  const makes =
    !current && workspaces !== undefined && !list.isFetching && invitations !== undefined && acceptable.length === 0 && creation.allowed && unreadable === null;
  const ensure = useEnsureWorkspace({ wanted: makes, has: current !== null });

  if (workspaces === undefined && !list.isError) return <Splash label="Loading your workspaces" />;
  if (!current) {
    // The first run offers the person's invitations instead of a workspace, so it waits for them.
    if (invitations === undefined) return <Splash label="Looking for your invitations" />;
    if (workspaces === undefined || acceptable.length > 0 || !creation.allowed) return <WelcomeScreen />;
    // Whether an invitation waits is not known: nothing is made until it is.
    if (unreadable !== null) return <InvitationsUnavailable unavailable={unreadable} />;
    // Core refused to make one (the deployment's rule changed after `me` was read): that is decision 6's page, and
    // asking again would be refused the same way.
    if (ensure.error instanceof WorkspaceApiError && ensure.error.status === 403) return <WelcomeScreen creationRefused />;
    // Failed, or answered but the list still has no workspace once it has settled: either way there is a way out.
    const failed = ensure.isError || (ensure.isSuccess && !list.isFetching);
    return <FirstRun failed={failed} retry={() => ensure.mutate()} />;
  }
  return <WorkspaceScreen key={current} workspaceId={current} bareWorkspaceId={bare} section={section} me={me} />;
}

/**
 * Asks Core for the person's workspace (`POST /ensure`) once `wanted` turns true, and again only when asked (the
 * mutation's `mutate`, from Try again) or after the person has had a workspace and lost it (`has` goes true, then
 * false). The answer goes into the cache and the workspace list is read again, which is what opens it. A ref holds
 * "asked", because React's strict mode runs an effect twice from the same render.
 */
function useEnsureWorkspace({ wanted, has }: { wanted: boolean; has: boolean }) {
  const qc = useQueryClient();
  const asked = useRef(false);
  const ensure = useMutation({
    mutationFn: () => portalWorkspaceApi.ensureWorkspace(),
    gcTime: 0,
    onSuccess: async created => {
      qc.setQueryData(workspaceKeys.detail(portalWorkspaceApi, created.workspaceId), created);
      await qc.invalidateQueries({ queryKey: workspaceKeys.list(portalWorkspaceApi) });
    },
  });
  const { reset, mutate, isIdle } = ensure;
  useEffect(() => {
    if (has) {
      asked.current = false;
      if (!isIdle) reset();
    } else if (wanted && !asked.current) {
      asked.current = true;
      mutate();
    }
  }, [wanted, has, mutate, reset, isIdle]);
  return ensure;
}

/** The first run while Core makes the person's workspace, or when it could not. */
function FirstRun({ failed, retry }: { failed: boolean; retry(): void }) {
  if (!failed) return <Splash label="Setting up your workspace" />;
  return (
    <PortalCenteredLayout>
      <div role="alert" className="rounded-notice bg-error text-error-foreground px-4 py-3 text-center text-sm">
        <p>Couldn't set up your workspace.</p>
        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={retry}>
          Try again
        </Button>
      </div>
    </PortalCenteredLayout>
  );
}

/** `/invitation`: the invitation link this tab holds (or, once, that it is no longer valid); without one, home. */
function InvitationRoute() {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const { link } = usePortal();
  if (link.status === "none") return <Redirect to="/" />;
  if ((list.data === undefined && !list.isError) || link.status === "checking") return <Splash label="Loading your invitation" />;
  return <InvitationScreen />;
}

/**
 * What the sign-in gate says to someone who followed a `?buy=<product>` link: "Sign in to buy <product's name>." with the
 * name from the public read (no sign-in needed), or "Sign in to buy a license." where it can't be read. Nothing until that
 * read has answered, so the line is never rewritten under the person.
 */
function SignInToBuy({ product }: { product: string }) {
  const [answer, setAnswer] = useState<{ product: string; name: string | null } | null>(null);
  useEffect(() => {
    let current = true;
    void fetchPublicProductName(product).then(name => {
      if (current) setAnswer({ product, name });
    });
    return () => {
      current = false;
    };
  }, [product]);
  const name = answer?.product === product ? answer.name : undefined;
  return (
    <p className="text-muted-foreground mb-7 min-h-6">
      {name === undefined ? null : name === null ? "Sign in to buy a license." : `Sign in to buy ${name}.`}
    </p>
  );
}

export function LoginGate({
  invitePending = false,
  loginUrl = loginHref(window.location, invitePending),
  buyProduct = typeof window === "undefined" ? null : buyParam(window.location.search),
}: {
  invitePending?: boolean;
  loginUrl?: string;
  /** The `?buy=` product the address named; the gate says what the sign-in is for. */
  buyProduct?: string | null;
}) {
  return (
    <BrandPage title="Sign into Mentra Portal">
      {buyProduct !== null && !invitePending ? (
        <SignInToBuy product={buyProduct} />
      ) : (
        <p className="text-muted-foreground mb-7">
          {invitePending
            ? "Sign in with the email address your invitation was sent to, then accept it."
            : "Manage your workspaces, their members, roles and invitations."}
        </p>
      )}
      <a className={buttonVariants({ size: "lg", className: "w-full" })} href={loginUrl}>
        Sign into Mentra account
      </a>
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
