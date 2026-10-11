import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { workspaceListQuery } from "@mentra/workspace-ui";
import { Loader2, UsersRound } from "lucide-react";
import { useState } from "react";
import { PortalShell } from "@/components/portal-shell";
import mentraLogo from "./assets/mentra-logo.svg";
import { SignedOutScreen } from "./components/signed-out";
import { api, safeLocalStorage, type PortalMe } from "./lib/api";
import { Redirect, usePathname } from "./lib/navigation";
import { PortalProvider, portalWorkspaceApi, usePortal, type PortalSession } from "./lib/portal";
import { homeWorkspace, invitationLanding, parseRoute, recallWorkspace, workspacePath, type PortalRoute } from "./lib/routes";
import { loginHref, signOutOfEnterprisePortal } from "./lib/session";
import { forgetPendingInvite, takePendingInvite } from "./lib/workspace-invite";
import { EnterpriseScreen } from "./pages/enterprise";
import { NotFoundMessage } from "./pages/not-found";
import { WelcomeScreen } from "./pages/welcome";
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
  const [inviteToken, setInviteToken] = useState<string | null>(initialInvite);
  const [signingOut, setSigningOut] = useState(false);
  const [signedOut, setSignedOut] = useState<{ signOutUrl: string | null } | null>(null);
  const me = useQuery({
    queryKey: ["portal-me"],
    queryFn: () => api<PortalMe>("/api/portal/me"),
    retry: false,
  });

  if (signedOut) return <SignedOutScreen signOutUrl={signedOut.signOutUrl} />;
  if (me.isLoading) return <Splash label="Checking your session" />;
  if (me.isError || !me.data) return <LoginGate invitePending={inviteToken !== null} />;

  async function signOut() {
    setSigningOut(true);
    const result = await signOutOfEnterprisePortal();
    qc.clear();
    setSignedOut(result);
  }

  const session: PortalSession = {
    userEmail: me.data.user.email || "Signed in",
    creation: me.data.workspaceCreation ?? { allowed: false, reason: null },
    inviteToken,
    forgetInvite() {
      forgetPendingInvite(sessionStore);
      initialInvite = null;
      setInviteToken(null);
    },
    signOut: () => void signOut(),
    signingOut,
  };

  return (
    <PortalProvider value={session}>
      <PortalRoutes route={parseRoute(pathname)} me={me.data} />
    </PortalProvider>
  );
}

/** The screen for an address. Needs a `PortalProvider` and a `QueryClientProvider`. */
export function PortalRoutes({ route, me }: { route: PortalRoute; me: PortalMe }) {
  switch (route.kind) {
    case "home":
      return <HomeRoute />;
    case "invitation":
      return <InvitationRoute />;
    case "workspace":
      return <WorkspaceScreen key={route.workspaceId} workspaceId={route.workspaceId} section={route.section} />;
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

/** `/`: the last-used workspace, else the first one, else the first run. */
function HomeRoute() {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  if (list.data === undefined && !list.isError) return <Splash label="Loading your workspaces" />;
  const target = list.data ? homeWorkspace(list.data, recallWorkspace(safeLocalStorage())) : null;
  if (target) {
    return (
      <>
        <Splash label="Opening your workspace" />
        <Redirect to={workspacePath(target)} />
      </>
    );
  }
  return <WelcomeScreen />;
}

/** `/invitation`: the invitation this tab holds; without one, home. */
function InvitationRoute() {
  const list = useQuery(workspaceListQuery(portalWorkspaceApi));
  const { inviteToken } = usePortal();
  if (!inviteToken) return <Redirect to="/" />;
  if (list.data === undefined && !list.isError) return <Splash label="Loading your invitation" />;
  return <WelcomeScreen />;
}

export function LoginGate({ invitePending = false, loginUrl = loginHref() }: { invitePending?: boolean; loginUrl?: string }) {

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[linear-gradient(180deg,#ffffff_0%,#f4f8f6_100%)] px-5 py-10 text-[#14141a]">
      <div className="pointer-events-none absolute left-[42%] top-[-54%] size-[980px] rounded-full bg-[radial-gradient(circle,rgba(201,244,232,0.78)_0%,rgba(228,246,240,0.46)_35%,rgba(255,255,255,0)_70%)] blur-[68px]" />
      <div className="pointer-events-none absolute left-[-24%] top-[58%] size-[720px] rounded-full bg-[radial-gradient(circle,rgba(214,242,235,0.68)_0%,rgba(232,247,242,0.4)_42%,rgba(255,255,255,0)_72%)] blur-[62px]" />

      <section className="relative flex w-full flex-col items-center justify-center gap-5">
        <div className="relative w-full max-w-[440px] overflow-hidden rounded-[24px] p-9 shadow-[0_16px_40px_-8px_rgba(20,20,26,0.07),0_0_0_1px_rgba(20,20,26,0.07),inset_0_1px_0_rgba(255,255,255,0.9)]">
          <div className="absolute inset-0 rounded-[24px] bg-[rgba(255,255,255,0.82)] backdrop-blur-[14px]" />
          <div className="relative text-center">
            <img src={mentraLogo} alt="Mentra" className="mx-auto h-[27px] w-[50px]" />

            <div className="h-[22px]" />
            <div className="mx-auto flex h-11 w-fit items-center gap-2 rounded-full bg-[#f0faf5] px-4 text-[12px] font-bold uppercase tracking-[0.14em] text-[#087d50] shadow-[0_0_0_1px_rgba(8,125,80,0.12)]">
              <UsersRound className="size-4" />
              Workspaces
            </div>

            <div className="h-[18px]" />
            <h1 className="font-display text-[28px] font-bold leading-[32px] tracking-[-0.64px] text-[#14141a]">
              Sign into the Mentra Workspace Portal
            </h1>

            <div className="h-2.5" />
            <p className="mx-auto max-w-[320px] font-body text-[13.5px] leading-[20px] text-[#7a7a82]">
              {invitePending
                ? "Sign in with the email address your invitation was sent to, then accept it."
                : "Manage your workspaces, their members, roles and invitations."}
            </p>

            <div className="h-8" />
            <a
              className="flex h-[48px] w-full items-center justify-center rounded-full bg-[#14141a] px-[18px] font-display text-sm font-semibold text-white shadow-[0_18px_44px_-10px_rgba(20,20,26,0.25),inset_0_1px_0_rgba(255,255,255,0.14)] transition hover:bg-[#24242b] focus:outline-none focus:ring-4 focus:ring-[#14141a]/10"
              href={loginUrl}
            >
              Sign in
            </a>

            <div className="h-5" />
            <p className="font-body text-[11.5px] leading-4 text-[#a6a6ac]">
              Sign in with your Mentra account.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

function Splash({ label }: { label: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f7f4] text-[#68746d]">
      <Loader2 className="mr-3 size-5 animate-spin" />
      {label}
    </main>
  );
}

export default App;
