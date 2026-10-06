import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrganizationCapability, PrincipalResponse } from "@mentra/workspace-contract";
import { renderToStaticMarkup } from "react-dom/server";
import type { AdminMe } from "./lib/admin-access";
import { ApiError } from "./lib/api";

let AdminPage: typeof import("./App").AdminPage;
let SessionFailure: typeof import("./App").SessionFailure;

// App.tsx reads window.location (hostname, search) while the module evaluates, and LoginGate reads it
// again when it renders. Provide a plain localhost location for this file and restore `window` after.
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
beforeAll(async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { location: new URL("http://localhost/") },
  });
  ({ AdminPage, SessionFailure } = await import("./App"));
});
afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else delete (globalThis as { window?: unknown }).window;
});

// Synthetic principals only; nothing is fetched.
const workspace: PrincipalResponse["workspaces"][number] = {
  organizationId: "org_test",
  workspaceId: "ws_acme",
  name: "Acme Robotics",
  status: "active",
  authorizationRevision: 3,
  membership: { membershipId: "wm_self", role: "admin" },
  capabilities: ["workspace.read", "miniapps.access", "workspace.members.read"],
};

function me(capabilities: OrganizationCapability[], workspaces: AdminMe["workspaces"] = []): AdminMe {
  return {
    authenticated: true,
    user: { mentraUserId: "u_self", email: "sam@acme.test" },
    credential: null,
    organization: { organizationId: "org_test", capabilities },
    workspaces,
  };
}

function renderAdmin(principal: AdminMe): string {
  const client = new QueryClient();
  client.setQueryData(["admin-me"], principal);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AdminPage />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

/** The labels of the sidebar's navigation buttons, in order. */
function navLabels(markup: string): string[] {
  const nav = /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(markup)?.[1] ?? "";
  return [...nav.matchAll(/<span[^>]*>([^<]+)<\/span>/g)].map(match => match[1]!);
}

const pageTitle = (markup: string) => /<h1[^>]*>([^<]*)<\/h1>/.exec(markup)?.[1];

describe("admin navigation follows what the principal may do", () => {
  test("incident access alone shows Incident system only", () => {
    const markup = renderAdmin(me(["organization.incidents.read"]));
    expect(navLabels(markup)).toEqual(["Incident system"]);
    expect(pageTitle(markup)).toBe("Incident system");
  });

  test("a workspace member with no organization capability sees Workspaces only, and no 403 gate", () => {
    const markup = renderAdmin(me([], [workspace]));
    expect(navLabels(markup)).toEqual(["Workspaces"]);
    expect(pageTitle(markup)).toBe("Workspaces");
    expect(markup).not.toContain("No admin access");
    expect(markup).not.toContain("allowlist");
    expect(markup).not.toContain("Continue with Mentra login");
  });

  test("testing access opens the three testing pages and starts on Test runs", () => {
    const markup = renderAdmin(me(["organization.testing.read"]));
    expect(navLabels(markup)).toEqual(["Test runs", "Fix flows", "System health"]);
    expect(pageTitle(markup)).toBe("Test runs");
  });

  test("credential management shows Operator keys", () => {
    const markup = renderAdmin(me(["organization.credentials.manage"]));
    expect(navLabels(markup)).toEqual(["Operator keys"]);
    expect(pageTitle(markup)).toBe("Operator keys");
  });

  test("workspace administration shows Workspaces to a person in no workspace", () => {
    expect(navLabels(renderAdmin(me(["organization.workspaces.administer"])))).toEqual(["Workspaces"]);
  });

  test("an Organization Admin sees everything and starts on Incident system", () => {
    const markup = renderAdmin(
      me([
        "organization.workspaces.administer",
        "organization.credentials.manage",
        "organization.incidents.read",
        "organization.supportProfiles.read",
        "organization.testing.read",
        "organization.testing.manage",
      ]),
    );
    expect(navLabels(markup)).toEqual([
      "Incident system",
      "Test runs",
      "Fix flows",
      "System health",
      "Workspaces",
      "Operator keys",
    ]);
    expect(pageTitle(markup)).toBe("Incident system");
  });

  test("a principal with no visible page gets an empty state, not the old 403 screen", () => {
    const markup = renderAdmin(me([]));
    expect(navLabels(markup)).toEqual([]);
    expect(markup).toContain("Your account has no admin access yet.");
    expect(markup).not.toContain("No admin access");
    expect(markup).not.toContain("allowlist");
    // Still inside the shell, so they can sign out and switch account.
    expect(markup).toContain("Open account menu");
  });

  test("the account footer shows the person's email", () => {
    expect(renderAdmin(me([], [workspace]))).toContain("sam@acme.test");
  });
});

describe("a failed session check", () => {
  test("a 401 shows the login screen", () => {
    const markup = renderToStaticMarkup(<SessionFailure error={new ApiError("401 Unauthorized", 401)} onRetry={() => {}} />);
    expect(markup).toContain("Sign into Mentra Admin");
    expect(markup).toContain("Continue with Mentra login");
    expect(markup).toContain("/api/console/auth/login?return_to=http%3A%2F%2Flocalhost%2F");
  });

  test("anything else says what happened and offers to retry, and is never a login or allowlist screen", () => {
    for (const status of [403, 500, 0]) {
      const markup = renderToStaticMarkup(<SessionFailure error={new ApiError("Core is unavailable", status)} onRetry={() => {}} />);
      expect(markup).toContain("Core is unavailable");
      expect(markup).toContain("Try again");
      expect(markup).not.toContain("Continue with Mentra login");
      expect(markup).not.toContain("allowlist");
    }
  });
});
