/**
 * Sign-out from the whole portal, in a DOM (happy-dom), over a small fake Core: Sign out ends the portal session and
 * the tab goes straight to Core's sign-out (which signs the person out of their Mentra account and brings them back to
 * `/`); only when Core gives no sign-out URL does the portal show its own signed-out screen. Back at `/` with an
 * invitation still pending in the tab (Switch account), the sign-in gate returns to the invitation.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { capabilitiesForRole, type InvitationPreview } from "@mentra/workspace-contract";
import { byText, cleanup, click, find, render, setupDom, teardownDom, until } from "@mentra/workspace-ui/test-dom";
import { useState, type ReactElement } from "react";
import { App, LoginGate, PortalRoutes } from "./App";
import type { PortalMe } from "./lib/api";
import { usePathname } from "./lib/navigation";
import { PortalProvider, type PortalSession } from "./lib/portal";
import { invitationLanding, parseRoute } from "./lib/routes";
import { signOut } from "./lib/session";
import { usePortalInvitations } from "./lib/use-portal-invitations";
import { takePendingInvite, type InviteStorage } from "./lib/workspace-invite";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(async () => {
  await cleanup();
  mock.restore();
});

const SIGN_OUT_URL =
  "https://account.example.test/oidc/session/end?client_id=workspace-portal&post_logout_redirect_uri=https%3A%2F%2Fportal.example.test%2F";

const ME: PortalMe = {
  authenticated: true,
  user: { id: "u_dana", email: "dana@example.com", emailVerified: true },
  workspaceCreation: { allowed: false, reason: null },
  onboardingRequired: false,
  org: null,
  modules: { billing: false },
};

const page = () => document.body.textContent ?? "";

/** The signed-in portal at an address with the account menu (a page that is not found), over a Core whose logout answers `signOutUrl`. */
async function signedIn(signOutUrl: string | null) {
  window.history.replaceState(null, "", "/not-a-page");
  const asked: Array<{ url: string; method: string }> = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    asked.push({ url, method });
    if (url === "/api/portal/me") return Response.json(ME);
    if (url === "/api/portal/auth/logout" && method === "POST") return Response.json({ signOutUrl });
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as unknown as typeof fetch);
  const left: string[] = [];
  spyOn(window.location, "replace").mockImplementation(((url: string | URL) => {
    left.push(String(url));
  }) as typeof window.location.replace);
  await render(<App />);
  await until(() => page().includes("dana@example.com"), "the signed-in portal");
  return { asked, left };
}

async function pressSignOut() {
  await click(find("[aria-label='Open account menu']"));
  await click(byText("Sign out", "button"));
}

describe("Sign out", () => {
  test("goes straight to Core's sign-out, replacing this page, and shows no signed-out screen", async () => {
    const { asked, left } = await signedIn(SIGN_OUT_URL);
    await pressSignOut();
    await until(() => left.length > 0, "the tab to leave");
    expect(left).toEqual([SIGN_OUT_URL]);
    expect(asked.filter(call => call.url === "/api/portal/auth/logout")).toEqual([{ url: "/api/portal/auth/logout", method: "POST" }]);
    // Until the browser has left: signing out, never the signed-out screen or its second sign-out.
    expect(page()).toContain("Signing out");
    expect(page()).not.toContain("Signed out of Mentra Portal");
    expect(page()).not.toContain("Sign out of your Mentra account");
  });

  test("without a sign-out URL, stays and shows the signed-out screen with only Sign in again", async () => {
    const { left } = await signedIn(null);
    await pressSignOut();
    await until(() => page().includes("Signed out of Mentra Portal"), "the signed-out screen");
    expect(left).toEqual([]);
    expect(page()).toContain("You can close this tab.");
    expect(byText("Sign in again", "a").getAttribute("href")).toBe("/");
    expect(page()).not.toContain("Sign out of your Mentra account");
  });
});

describe("back at / after signing out", () => {
  test("with an invitation pending, the sign-in gate returns to the invitation", async () => {
    window.history.replaceState(null, "", "/");
    await render(<LoginGate invitePending />);
    expect(page()).toContain("Sign in with the email address your invitation was sent to, then accept it.");
    const href = find<HTMLAnchorElement>("a[href^='/api/portal/auth/login']").getAttribute("href")!;
    expect(new URL(href, "https://portal.example.test").searchParams.get("return_to")).toBe("/invitation");
  });

  test("without one, it returns to /", async () => {
    window.history.replaceState(null, "", "/");
    await render(<LoginGate />);
    const href = find<HTMLAnchorElement>("a[href^='/api/portal/auth/login']").getAttribute("href")!;
    expect(new URL(href, "https://portal.example.test").searchParams.get("return_to")).toBe("/");
  });
});

describe("Switch account, for an invitation sent to another account", () => {
  const TOKEN = "link-token-never-rendered";
  const INVITATION: InvitationPreview = {
    invitationId: "winv_acme",
    workspaceId: "ws_acme",
    workspaceName: "Acme Field Team",
    email: "sam@example.com",
    role: "member",
    invitedByEmail: "olivia@example.com",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  /** This tab's session storage: it outlives the trip to Core's sign-out and back, as a browser tab's does. */
  const tabStorage = (): InviteStorage => {
    const data = new Map<string, string>();
    return { getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value), removeItem: key => void data.delete(key) };
  };

  /** A small Core: the signed-in person's (empty) lists, the link's invitation, and logout answering Core's sign-out URL. */
  function core() {
    spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://portal.example.test").pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/api/portal/auth/logout" && method === "POST") return Response.json({ signOutUrl: SIGN_OUT_URL });
      if (path === "/api/portal/workspaces/invitations/peek" && method === "POST") return Response.json(INVITATION);
      if (path === "/api/portal/workspaces" || path === "/api/portal/workspaces/invitations/mine") return Response.json({ items: [] });
      if (path === "/api/portal/workspaces/ws_acme") {
        return Response.json({ workspaceId: "ws_acme", name: "Acme Field Team", status: "active", authorizationRevision: 1, membership: null, capabilities: [...capabilitiesForRole("member")] });
      }
      return Response.json({ error: "not_found", error_description: path }, { status: 404 });
    }) as unknown as typeof fetch);
  }

  /** The portal as App wires it for a signed-in person: the real invitations hook, and Sign out from lib/session. */
  function SignedInPortal({ email, token, store, leave }: { email: string; token: string | null; store: InviteStorage; leave(url: string): void }) {
    const pathname = usePathname();
    const [signingOut, setSigningOut] = useState(false);
    const invites = usePortalInvitations({ initialToken: token, signedIn: true, accountEmail: email, pathname, sessionStore: store, localStore: tabStorage() });
    const me: PortalMe = { ...ME, user: { ...ME.user, email } };
    const session: PortalSession = {
      userEmail: email,
      accountEmail: email,
      creation: { allowed: false, reason: null },
      link: invites.link,
      invitations: invites.invitations,
      invitationsUnavailable: invites.unavailable,
      forgetInvitation: invites.forgetInvitation,
      signOut: () => {
        setSigningOut(true);
        void signOut({ leave });
      },
      signingOut,
      developerConsoleUrl: null,
      modules: me.modules,
      sessionExpired() {},
    };
    return (
      <PortalProvider value={session}>
        <PortalRoutes route={parseRoute(pathname)} me={me} />
      </PortalProvider>
    );
  }

  const withClient = (ui: ReactElement) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })}>{ui}</QueryClientProvider>
  );

  test("signs out of everything, lands on the sign-in gate, and signing in with the invited account opens the invitation", async () => {
    core();
    const store = tabStorage();
    // The invitation link: its token moves into the tab's storage and the tab lands on /invitation.
    window.history.replaceState(null, "", `/?workspaceInvite=${TOKEN}`);
    const token = takePendingInvite(window.location, store, url => window.history.replaceState(null, "", invitationLanding(url)));
    expect(window.location.pathname).toBe("/invitation");

    // Signed in as dana: the invitation is for sam, so it offers Switch account, which leaves for Core's sign-out.
    const left: string[] = [];
    await render(withClient(<SignedInPortal email="dana@example.com" token={token} store={store} leave={url => left.push(url)} />));
    await until(() => page().includes("Switch account"), "Switch account");
    await click(byText("Switch account", "button"));
    await until(() => left.length > 0, "the tab to leave");
    expect(left).toEqual([SIGN_OUT_URL]);
    await cleanup();

    // Core signs the person out of their Mentra account and sends the tab back to the portal's root, signed out.
    window.history.replaceState(null, "", "/");
    const kept = takePendingInvite(window.location, store, () => {});
    expect(kept).toBe(TOKEN);
    await render(<LoginGate invitePending={kept !== null} />);
    expect(page()).toContain("your invitation was sent to");
    const href = find<HTMLAnchorElement>("a[href^='/api/portal/auth/login']").getAttribute("href")!;
    expect(new URL(href, "https://portal.example.test").searchParams.get("return_to")).toBe("/invitation");
    await cleanup();

    // Signed in again as sam, the sign-in returns to /invitation, which now offers Accept.
    window.history.replaceState(null, "", "/invitation");
    await render(withClient(<SignedInPortal email="sam@example.com" token={kept} store={store} leave={url => left.push(url)} />));
    await until(() => page().includes("Accept invitation"), "Accept invitation");
    expect(page()).not.toContain("Switch account");
  });
});
