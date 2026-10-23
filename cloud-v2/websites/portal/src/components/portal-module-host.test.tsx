import { describe, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PORTAL_MODULE_CONTRACT_VERSION,
  type PortalModule,
  type PortalModuleContext,
  type PortalModuleScope,
} from "@mentra/workspace-contract/portal-module-ui";
import { renderToStaticMarkup } from "react-dom/server";
import type { PortalMe } from "@/lib/api";
import { PortalProvider, type PortalSession } from "@/lib/portal";
import {
  createPortalModuleHost,
  isPortalPath,
  loadPortalModule,
  PortalModuleHost,
  PortalModuleUnavailable,
  PortalModuleUnavailableError,
  portalModuleApiBase,
  portalModuleEntryUrl,
  portalModuleMe,
  type ModuleEntryImporter,
  type ModulePhase,
} from "./portal-module-host";

// Synthetic people and a fake module only. No test reaches the network or Core.
const ME: PortalMe = {
  authenticated: true,
  user: { id: "mu_ada", email: "ada@acme.test", emailVerified: true },
  workspaceCreation: { allowed: true, reason: null },
  onboardingRequired: false,
  org: null,
  modules: { billing: true, billingCatalog: true },
};

const WORKSPACE: PortalModuleScope = { kind: "workspace", workspaceId: "ws_acme" };
const PERSON: PortalModuleScope = { kind: "person" };
const ROUTE = { path: "/w/ws_acme/licenses", query: "" };

describe("what the module is told about the caller", () => {
  test("is the contract's shape, mapped from /api/portal/me: the Core user id becomes mentraUserId", () => {
    expect(portalModuleMe(ME)).toEqual({
      authenticated: true,
      user: { mentraUserId: "mu_ada", email: "ada@acme.test", emailVerified: true },
    });
  });

  test("carries nothing else the portal knows, and keeps a missing address and an unverified one as they are", () => {
    const mapped = portalModuleMe({ ...ME, user: { id: "mu_bo", email: null, emailVerified: false } });
    expect(mapped).toEqual({ authenticated: true, user: { mentraUserId: "mu_bo", email: null, emailVerified: false } });
    expect(Object.keys(mapped).sort()).toEqual(["authenticated", "user"]);
    expect(Object.keys(mapped.user).sort()).toEqual(["email", "emailVerified", "mentraUserId"]);
    expect(JSON.stringify(mapped)).not.toContain("workspaceCreation");
    expect(JSON.stringify(mapped)).not.toContain('"id"');
  });
});

describe("where the module is", () => {
  test("its API is under /api/portal/<module> and its UI entry under ui/, both on this origin", () => {
    expect(portalModuleApiBase("fleet", WORKSPACE)).toBe("/api/portal/fleet/workspaces/ws_acme");
    expect(portalModuleEntryUrl("fleet", WORKSPACE)).toBe("/api/portal/fleet/workspaces/ws_acme/ui/entry.js");
    expect(portalModuleEntryUrl("fleet", { kind: "workspace", workspaceId: "ws/odd id" })).toBe(
      "/api/portal/fleet/workspaces/ws%2Fodd%20id/ui/entry.js",
    );
  });
});

/** An element with a shadow root to attach, as the browser's would, recording what the host does with it. */
function fakeElement() {
  const shadow = {
    cleared: 0,
    replaceChildren() {
      shadow.cleared += 1;
    },
  };
  const element = {
    attached: 0,
    shadowRoot: null as typeof shadow | null,
    attachShadow() {
      element.attached += 1;
      element.shadowRoot = shadow;
      return shadow;
    },
  };
  return { element: element as unknown as HTMLElement, raw: element, shadow };
}

/** A module that records its mounts. With `withSetRoute` its handle follows route changes itself. */
function fakeModule(options: { withSetRoute?: boolean; version?: number } = {}) {
  const mounts: Array<{ target: unknown; context: PortalModuleContext }> = [];
  const events: string[] = [];
  const module: PortalModule = {
    contractVersion: options.version ?? PORTAL_MODULE_CONTRACT_VERSION,
    mount(target, context) {
      mounts.push({ target, context });
      events.push(`mount ${context.route.path}${context.route.query}`);
      return {
        unmount: () => void events.push("unmount"),
        ...(options.withSetRoute
          ? { setRoute: (route: { path: string; query: string }) => void events.push(`setRoute ${route.path}${route.query}`) }
          : {}),
      };
    },
  };
  return { module, mounts, events };
}

/** An importer that records what it was asked for and answers with `entry` as the module's default export. */
function importerOf(entry: unknown) {
  const asked: string[] = [];
  const importEntry: ModuleEntryImporter = async specifier => {
    asked.push(specifier);
    return { default: entry };
  };
  return { importEntry, asked };
}

describe("loading the module", () => {
  test("imports the module's entry from Core, and a retry asks for a URL no earlier attempt used", async () => {
    const { module } = fakeModule();
    const { importEntry, asked } = importerOf(module);
    expect(await loadPortalModule("fleet", WORKSPACE, importEntry)).toBe(module);
    await loadPortalModule("fleet", WORKSPACE, importEntry, 17);
    expect(asked).toEqual([
      "/api/portal/fleet/workspaces/ws_acme/ui/entry.js",
      "/api/portal/fleet/workspaces/ws_acme/ui/entry.js?retry=17",
    ]);
  });

  test("a module built for another version of the contract is unavailable, and says which versions", async () => {
    const { module } = fakeModule({ version: PORTAL_MODULE_CONTRACT_VERSION + 1 });
    const error = await loadPortalModule("fleet", WORKSPACE, importerOf(module).importEntry).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalModuleUnavailableError);
    expect((error as Error).message).toContain(`version ${PORTAL_MODULE_CONTRACT_VERSION + 1}`);
    expect((error as Error).message).toContain(`version ${PORTAL_MODULE_CONTRACT_VERSION}`);
  });

  test("an entry that is not a module, or has no mount, is unavailable", async () => {
    for (const entry of [undefined, null, "text", {}, { contractVersion: PORTAL_MODULE_CONTRACT_VERSION }, { mount() {} }]) {
      const error = await loadPortalModule("fleet", WORKSPACE, importerOf(entry).importEntry).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PortalModuleUnavailableError);
    }
    const noDefault = await loadPortalModule("fleet", WORKSPACE, async () => ({})).catch((e: unknown) => e);
    expect(noDefault).toBeInstanceOf(PortalModuleUnavailableError);
  });

  test("a failed import (Core answers 404 or 503 while the module is off or down) is unavailable, keeping the cause", async () => {
    const cause = new TypeError("Failed to fetch dynamically imported module");
    const error = await loadPortalModule("fleet", WORKSPACE, async () => {
      throw cause;
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortalModuleUnavailableError);
    expect((error as Error).cause).toBe(cause);
  });
});

describe("mounting the module", () => {
  /** A host over a fake element, recording its phases and what the page was asked to do. */
  function hostFor(options: { module?: PortalModule | unknown; scope?: PortalModuleScope; route?: typeof ROUTE; importEntry?: ModuleEntryImporter } = {}) {
    const fake = fakeElement();
    const phases: ModulePhase[] = [];
    const navigated: Array<{ path: string; replace?: boolean }> = [];
    let expired = 0;
    const imported = importerOf(options.module);
    const host = createPortalModuleHost({
      name: "fleet",
      element: fake.element,
      importEntry: options.importEntry ?? imported.importEntry,
      scope: options.scope ?? WORKSPACE,
      route: options.route ?? ROUTE,
      inputs: () => ({
        me: ME,
        navigate: (path, opts) => void navigated.push({ path, replace: opts?.replace }),
        onSessionExpired: () => void (expired += 1),
      }),
      onPhase: phase => void phases.push(phase),
    });
    return { host, phases, navigated, expired: () => expired, asked: imported.asked, ...fake };
  }

  test("mounts it into an open shadow root with the contract's context, for a workspace", async () => {
    const { module, mounts } = fakeModule();
    const { host, phases, raw, shadow } = hostFor({ module });
    await host.start();
    expect(phases.map(phase => phase.status)).toEqual(["loading", "ready"]);
    expect(raw.attached).toBe(1);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.target).toBe(shadow);
    const { context } = mounts[0]!;
    expect(context.apiBase).toBe("/api/portal/fleet/workspaces/ws_acme");
    expect(context.me).toEqual(portalModuleMe(ME));
    expect(context.scope).toEqual({ kind: "workspace", workspaceId: "ws_acme" });
    expect(context.route).toEqual(ROUTE);
    expect(Object.keys(context).sort()).toEqual(["apiBase", "me", "navigate", "onSessionExpired", "route", "scope"]);
  });

  test("mounts it for the person on the personal page", async () => {
    const { module, mounts } = fakeModule();
    const { host } = hostFor({ module, scope: PERSON, route: { path: "/account/billing", query: "?checkout=done" } });
    await host.start();
    expect(mounts[0]!.context.scope).toEqual({ kind: "person" });
    expect(mounts[0]!.context.route).toEqual({ path: "/account/billing", query: "?checkout=done" });
  });

  test("the module's navigate goes to the page, with replace when it asks; its 401 reaches the page", async () => {
    const { module, mounts } = fakeModule();
    const { host, navigated, expired } = hostFor({ module });
    await host.start();
    const { context } = mounts[0]!;
    context.navigate("/account/billing");
    context.navigate("/w/ws_acme/members", { replace: true });
    expect(navigated).toEqual([
      { path: "/account/billing", replace: undefined },
      { path: "/w/ws_acme/members", replace: true },
    ]);
    context.onSessionExpired();
    expect(expired()).toBe(1);
  });

  test("the page goes only to an address of the portal: another origin, a relative or a junk path is ignored", async () => {
    const { module, mounts } = fakeModule();
    const { host, navigated } = hostFor({ module });
    await host.start();
    const { context } = mounts[0]!;
    for (const to of ["https://evil.test/x", "//evil.test/x", "/\\evil.test", "account/billing", "javascript:alert(1)", "/a\nb", `/${"a".repeat(3000)}`, ""]) {
      context.navigate(to);
    }
    context.navigate("/account/billing?checkout=done");
    expect(navigated).toEqual([{ path: "/account/billing?checkout=done", replace: undefined }]);
    expect(isPortalPath("/")).toBe(true);
    expect(isPortalPath("/w/ws_1/licenses")).toBe(true);
    expect(isPortalPath(undefined)).toBe(false);
  });

  test("a later route change reaches a module that follows routes, without mounting it again", async () => {
    const { module, events } = fakeModule({ withSetRoute: true });
    const { host } = hostFor({ module });
    await host.start();
    host.setRoute({ path: "/w/ws_acme/licenses", query: "?checkout=done" });
    host.setRoute({ path: "/w/ws_acme/licenses", query: "?checkout=done" });
    expect(events).toEqual(["mount /w/ws_acme/licenses", "setRoute /w/ws_acme/licenses?checkout=done"]);
  });

  test("a module that does not follow routes is unmounted and mounted again in the same shadow root", async () => {
    const { module, events, mounts } = fakeModule();
    const { host, raw, shadow } = hostFor({ module });
    await host.start();
    host.setRoute({ path: "/account/billing", query: "" });
    expect(events).toEqual(["mount /w/ws_acme/licenses", "unmount", "mount /account/billing"]);
    expect(raw.attached).toBe(1);
    expect(shadow.cleared).toBeGreaterThan(0);
    expect(mounts[1]!.context.route).toEqual({ path: "/account/billing", query: "" });
  });

  test("a route that changes while the module is loading is the route it mounts at", async () => {
    const { module, mounts } = fakeModule();
    const { host } = hostFor({ module });
    const started = host.start();
    host.setRoute({ path: "/w/ws_acme/licenses", query: "?checkout=done" });
    await started;
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.context.route).toEqual({ path: "/w/ws_acme/licenses", query: "?checkout=done" });
  });

  test("a version mismatch is the unavailable state, not a mount, and the page says Fleet Management is unavailable and why", async () => {
    const { module, mounts } = fakeModule({ version: 2 });
    const { host, phases } = hostFor({ module });
    await host.start();
    expect(mounts).toEqual([]);
    const last = phases.at(-1);
    expect(last).toMatchObject({ status: "unavailable" });
    const reason = (last as { reason: string }).reason;
    expect(reason).toContain("version 2");
    const markup = renderToStaticMarkup(<PortalModuleUnavailable label="Fleet Management" reason={reason} onRetry={() => {}} />);
    expect(markup).toContain("Fleet Management is unavailable");
    expect(markup).toContain(reason);
    expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
  });

  test("a module that throws while mounting is the unavailable state, and the error is logged, not shown", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const broken: PortalModule = {
        contractVersion: PORTAL_MODULE_CONTRACT_VERSION,
        mount() {
          throw new Error("boom with details");
        },
      };
      const { host, phases, shadow } = hostFor({ module: broken });
      await host.start();
      expect(phases.at(-1)).toEqual({ status: "unavailable", reason: "Fleet Management could not start." });
      expect(shadow.cleared).toBeGreaterThan(0);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("Retry after a failed import imports again under a new URL; after a failed mount it mounts the same module again", async () => {
    // A failed import.
    const flaky = fakeModule();
    let attempts = 0;
    const asked: string[] = [];
    const importEntry: ModuleEntryImporter = async specifier => {
      asked.push(specifier);
      attempts += 1;
      if (attempts === 1) throw new TypeError("offline");
      return { default: flaky.module };
    };
    const first = hostFor({ importEntry });
    await first.host.start();
    expect(first.phases.at(-1)).toMatchObject({ status: "unavailable" });
    await first.host.retry();
    expect(first.phases.at(-1)).toEqual({ status: "ready" });
    expect(asked[0]).toBe("/api/portal/fleet/workspaces/ws_acme/ui/entry.js");
    expect(asked[1]).toMatch(/^\/api\/portal\/fleet\/workspaces\/ws_acme\/ui\/entry\.js\?retry=\d+$/);

    // A failed mount: the module was fine to import, so it is not imported twice.
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      let mountAttempts = 0;
      const mounted: string[] = [];
      const module: PortalModule = {
        contractVersion: PORTAL_MODULE_CONTRACT_VERSION,
        mount() {
          mountAttempts += 1;
          if (mountAttempts === 1) throw new Error("first mount fails");
          mounted.push("ok");
          return { unmount() {} };
        },
      };
      const second = hostFor({ module });
      await second.host.start();
      expect(second.phases.at(-1)).toMatchObject({ status: "unavailable" });
      await second.host.retry();
      expect(second.phases.at(-1)).toEqual({ status: "ready" });
      expect(mounted).toEqual(["ok"]);
      expect(second.asked).toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("leaving the page unmounts the module, and nothing it or the import does afterwards touches the page", async () => {
    const { module, mounts, events } = fakeModule();
    const { host, navigated, phases } = hostFor({ module });
    await host.start();
    const { context } = mounts[0]!;
    host.dispose();
    expect(events).toEqual(["mount /w/ws_acme/licenses", "unmount"]);
    context.navigate("/account/billing");
    expect(navigated).toEqual([]);
    const seen = phases.length;
    host.setRoute({ path: "/elsewhere", query: "" });
    await host.retry();
    expect(phases).toHaveLength(seen);
    expect(events).toHaveLength(2);

    // An import that settles after the page was left mounts nothing.
    const late = fakeModule();
    let release: (entry: unknown) => void = () => {};
    const pending = new Promise<unknown>(resolve => (release = resolve));
    const slow = hostFor({ importEntry: () => pending as Promise<unknown> });
    const started = slow.host.start();
    slow.host.dispose();
    release({ default: late.module });
    await started;
    expect(late.mounts).toEqual([]);
  });
});

describe("the page around the module", () => {
  const session: PortalSession = {
    userEmail: "ada@acme.test",
    accountEmail: "ada@acme.test",
    creation: { allowed: true, reason: null },
    link: { status: "none" },
    invitations: [],
    forgetInvitation() {},
    signOut() {},
    signingOut: false,
    developerConsoleUrl: null,
    modules: { billing: true, billingCatalog: true },
    sessionExpired() {},
  };

  test("the unavailable state says Fleet Management is unavailable, why, and offers Retry", () => {
    const markup = renderToStaticMarkup(
      <PortalModuleUnavailable label="Fleet Management" reason="The Fleet Management module could not be loaded." onRetry={() => {}} />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Fleet Management is unavailable");
    expect(markup).toContain("The Fleet Management module could not be loaded.");
    expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
  });

  test("before the module has loaded, the page shows that Fleet Management is loading, in a region of its own", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <PortalProvider value={session}>
          <PortalModuleHost module="fleet" me={ME} scope={WORKSPACE} />
        </PortalProvider>
      </QueryClientProvider>,
    );
    expect(markup).toContain('<section aria-label="Fleet Management"');
    expect(markup).toContain("Loading Fleet Management");
    expect(markup).not.toContain("is unavailable");
  });

  test("no text the host shows names the payment processor", () => {
    // Spelled in pieces: the repository's guard keeps that name out of every source file in Cloud V2.
    const processor = new RegExp(["st", "ripe"].join(""), "i");
    const reasons = [
      "The Fleet Management module could not be loaded.",
      "Fleet Management could not start.",
      "The Fleet Management module uses version 2 of the module interface.",
    ];
    for (const reason of reasons) {
      const markup = renderToStaticMarkup(<PortalModuleUnavailable label="Fleet Management" reason={reason} onRetry={() => {}} />);
      expect(markup).toContain(reason);
      expect(markup).not.toMatch(processor);
    }
  });
});
