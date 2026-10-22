import { describe, expect, spyOn, test } from "bun:test";
import { FLEET_UI_CONTRACT_VERSION, type FleetUiContext, type FleetUiModule } from "@mentra/workspace-contract/fleet-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { api, PortalApiError, type PortalMe } from "@/lib/api";
import {
  createFleetHost,
  endsSession,
  fleetApiBase,
  fleetModuleUrl,
  FleetUnavailable,
  FleetUnavailableError,
  fleetLocation,
  fleetRoute,
  fleetUiMe,
  loadFleetModule,
  normalizeFleetPath,
  readFleetPath,
  type FleetEntryImporter,
} from "./fleet";

// Synthetic people and a fake module only. No test reaches the network or Core.
const ME: PortalMe = {
  authenticated: true,
  user: { id: "mu_ada", mentraUserId: "mu_ada", email: "ada@acme.test", emailVerified: true },
  workspaceCreation: { allowed: false, reason: null },
  onboardingRequired: false,
  org: null,
  modules: { billing: false, billingCatalog: false },
  organization: { capabilities: ["organization.fleet.administer"] },
  workspaces: [{ workspaceId: "ws_acme", name: "Acme", capabilities: ["fleet.read", "miniapps.assign"] }],
  fleet: { installed: true },
};

describe("where Fleet is", () => {
  test("its API is this one workspace under /api/portal/fleet/workspaces, and its UI entry is on this origin", () => {
    expect(fleetApiBase("ws_acme")).toBe("/api/portal/fleet/workspaces/ws_acme");
    expect(fleetApiBase("ws/odd id")).toBe("/api/portal/fleet/workspaces/ws%2Fodd%20id");
    // The entry is this workspace's too: Core checks fleet.read in it, as for the API. Chunks and CSS the entry
    // loads by relative path come from the same `ui/` folder, so they take the same route and check.
    expect(fleetModuleUrl("ws_acme")).toBe("/api/portal/fleet/workspaces/ws_acme/ui/entry.js");
    expect(fleetModuleUrl("ws/odd id")).toBe("/api/portal/fleet/workspaces/ws%2Fodd%20id/ui/entry.js");
    expect(new URL("chunk-1.js", `https://portal.test${fleetModuleUrl("ws_acme")}`).pathname).toBe(
      "/api/portal/fleet/workspaces/ws_acme/ui/chunk-1.js",
    );
    expect(new URL("../ui/entry.css", `https://portal.test${fleetModuleUrl("ws_acme")}`).pathname).toBe(
      "/api/portal/fleet/workspaces/ws_acme/ui/entry.css",
    );
  });
});

describe("the Fleet route in the address", () => {
  test("a missing or blank ?fleet= is the overview, and a route is always a path from the root", () => {
    expect(readFleetPath("")).toBe("/");
    expect(readFleetPath("?fleet=")).toBe("/");
    expect(readFleetPath("?fleet=people")).toBe("/people");
    expect(readFleetPath("?fleet=%2Fdevices%3Ftab%3Dphones")).toBe("/devices?tab=phones");
    expect(normalizeFleetPath("//evil.test/x")).toBe("/evil.test/x");
    expect(normalizeFleetPath("/devices\n?x=1")).toBe("/");
    expect(normalizeFleetPath(`/${"a".repeat(3000)}`)).toBe("/");
  });

  test("splits into the path and the query (with its ?) that a module reads", () => {
    expect(fleetRoute("/")).toEqual({ path: "/", query: "" });
    expect(fleetRoute("/devices?tab=phones")).toEqual({ path: "/devices", query: "?tab=phones" });
    expect(fleetRoute("/usage?")).toEqual({ path: "/usage", query: "" });
  });

  test("the module's navigation becomes ?fleet= on this workspace's Fleet address, and reads back the same", () => {
    expect(fleetLocation("ws_acme", "/people")).toBe("/w/ws_acme/fleet?fleet=people");
    for (const route of ["/", "/people", "/devices/dev_1?tab=battery&since=7d", "/miniapps/com.acme.app"]) {
      const location = fleetLocation("ws_acme", route);
      expect(location.startsWith("/w/ws_acme/fleet?fleet=")).toBe(true);
      expect(readFleetPath(new URL(location, "https://portal.test").search)).toBe(route);
    }
  });
});

describe("what the module is told about the caller", () => {
  test("is the contract's fields, with the workspace the page is open on and nothing else the portal knows", () => {
    const told = fleetUiMe(ME);
    expect(told).toEqual({
      authenticated: true,
      user: { mentraUserId: "mu_ada", email: "ada@acme.test" },
      organization: { capabilities: ["organization.fleet.administer"] },
      workspaces: [{ workspaceId: "ws_acme", name: "Acme", capabilities: ["fleet.read", "miniapps.assign"] }],
      fleet: { installed: true },
    });
    expect(JSON.stringify(told)).not.toContain("workspaceCreation");
  });

  test("an Organization Admin who is not a member is told exactly the one workspace /me named for them", () => {
    const admin: PortalMe = { ...ME, workspaces: [{ workspaceId: "ws_other", name: "Other", capabilities: ["fleet.read", "fleet.devices.manage", "miniapps.assign"] }] };
    expect(fleetUiMe(admin).workspaces).toEqual([
      { workspaceId: "ws_other", name: "Other", capabilities: ["fleet.read", "fleet.devices.manage", "miniapps.assign"] },
    ]);
  });

  test("a Core that predates these fields says Fleet is not installed, with no workspaces", () => {
    const old: PortalMe = { ...ME, organization: undefined, workspaces: undefined, fleet: undefined };
    expect(fleetUiMe(old)).toMatchObject({ organization: { capabilities: [] }, workspaces: [], fleet: { installed: false } });
  });
});

function fakeModule(options: { setRoute?: boolean; version?: number } = {}) {
  const mounts: Array<{ target: unknown; ctx: FleetUiContext }> = [];
  const events: string[] = [];
  const module: FleetUiModule = {
    contractVersion: options.version ?? FLEET_UI_CONTRACT_VERSION,
    mount(target, ctx) {
      mounts.push({ target, ctx });
      events.push(`mount ${ctx.route.path}${ctx.route.query}`);
      return {
        unmount: () => void events.push("unmount"),
        ...(options.setRoute ? { setRoute: (route: { path: string; query: string }) => void events.push(`setRoute ${route.path}${route.query}`) } : {}),
      };
    },
  };
  return { module, mounts, events };
}

function importerOf(entry: unknown) {
  const asked: string[] = [];
  const importEntry: FleetEntryImporter = async specifier => {
    asked.push(specifier);
    return { default: entry };
  };
  return { importEntry, asked };
}

/** A host element standing in for the DOM's: one open shadow root, and a second attachShadow throws as it does there. */
function fakeElement() {
  const shadow = { cleared: 0, replaceChildren: () => void (shadow.cleared += 1) };
  const element = {
    attached: 0,
    shadowRoot: null as typeof shadow | null,
    attachShadow() {
      if (element.shadowRoot) throw new DOMException("already attached", "NotSupportedError");
      element.attached += 1;
      element.shadowRoot = shadow;
      return shadow;
    },
  };
  return { element: element as unknown as HTMLElement, raw: element, shadow };
}

type Phase = { status: string; reason?: string };

function openHost(entry: unknown, overrides: { path?: string; me?: PortalMe; importEntry?: FleetEntryImporter } = {}) {
  const { element, raw, shadow } = fakeElement();
  const phases: Phase[] = [];
  const navigations: Array<{ path: string; replace?: boolean }> = [];
  let expired = 0;
  const importer = importerOf(entry);
  const host = createFleetHost({
    element,
    workspaceId: "ws_acme",
    importEntry: overrides.importEntry ?? importer.importEntry,
    path: overrides.path ?? "/",
    inputs: () => ({
      me: overrides.me ?? ME,
      onNavigate: (path, opts) => void navigations.push({ path, replace: opts?.replace }),
      onSessionExpired: () => void (expired += 1),
    }),
    onPhase: phase => void phases.push(phase),
  });
  return { host, raw, shadow, phases, navigations, asked: importer.asked, expired: () => expired };
}

describe("loading the Fleet module", () => {
  test("a retry asks for a URL no earlier attempt used", async () => {
    const { module } = fakeModule();
    const { importEntry, asked } = importerOf(module);
    await loadFleetModule("ws_acme", importEntry);
    await loadFleetModule("ws_acme", importEntry, 17);
    const url = "/api/portal/fleet/workspaces/ws_acme/ui/entry.js";
    expect(asked).toEqual([url, `${url}?retry=17`]);
  });

  test("a module for another contract version, or no module at all, is Fleet being unavailable", async () => {
    const mismatch = await loadFleetModule("ws_acme", importerOf(fakeModule({ version: FLEET_UI_CONTRACT_VERSION + 1 }).module).importEntry).catch((e: unknown) => e);
    expect(mismatch).toBeInstanceOf(FleetUnavailableError);
    expect((mismatch as Error).message).toContain(`version ${FLEET_UI_CONTRACT_VERSION + 1}`);
    for (const entry of [undefined, null, "text", {}, { contractVersion: 1 }, { mount() {} }]) {
      expect(await loadFleetModule("ws_acme", importerOf(entry).importEntry).catch((e: unknown) => e)).toBeInstanceOf(FleetUnavailableError);
    }
  });

  test("a failed import (the 404 and 503 Core answers) is Fleet being unavailable", async () => {
    const failing: FleetEntryImporter = async () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    };
    const error = await loadFleetModule("ws_acme", failing).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FleetUnavailableError);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });
});

describe("the Fleet host", () => {
  test("mounts the module in an open shadow root with this workspace's apiBase, me and the route", async () => {
    const { module, mounts } = fakeModule();
    const opened = openHost(module, { path: "/devices?tab=phones" });
    opened.host.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(opened.asked).toEqual(["/api/portal/fleet/workspaces/ws_acme/ui/entry.js"]);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.target).toBe(opened.shadow);
    expect(mounts[0]!.ctx).toMatchObject({
      contractVersion: FLEET_UI_CONTRACT_VERSION,
      apiBase: "/api/portal/fleet/workspaces/ws_acme",
      me: fleetUiMe(ME),
      route: { path: "/devices", query: "?tab=phones" },
    });
    expect(opened.phases.map(phase => phase.status)).toEqual(["loading", "ready"]);
  });

  test("a route change reaches a module with setRoute through it, and remounts one without", async () => {
    const withRoute = fakeModule({ setRoute: true });
    const a = openHost(withRoute.module);
    a.host.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    a.host.setPath("/people");
    expect(withRoute.events).toEqual(["mount /", "setRoute /people"]);

    const without = fakeModule();
    const b = openHost(without.module);
    b.host.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    b.host.setPath("/devices?tab=phones");
    expect(without.events).toEqual(["mount /", "unmount", "mount /devices?tab=phones"]);
    expect(b.raw.attached).toBe(1);
  });

  test("the module's own navigate and a 401 reach the page; once the page is left, nothing does", async () => {
    const { module, mounts, events } = fakeModule();
    const opened = openHost(module);
    opened.host.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    const ctx = mounts[0]!.ctx;
    ctx.navigate("people", { replace: true });
    ctx.onSessionExpired();
    expect(opened.navigations).toEqual([{ path: "/people", replace: true }]);
    expect(opened.expired()).toBe(1);
    opened.host.dispose();
    expect(events).toEqual(["mount /", "unmount"]);
    expect(opened.shadow.cleared).toBeGreaterThan(0);
    ctx.navigate("/devices");
    expect(opened.navigations).toHaveLength(1);
  });

  test("a version mismatch, a missing module (404) and a down one (503) show unavailable, and never mount", async () => {
    const mismatch = fakeModule({ version: 2 });
    for (const importEntry of [
      importerOf(mismatch.module).importEntry,
      (async () => {
        throw new TypeError("404");
      }) as FleetEntryImporter,
      (async () => {
        throw new TypeError("503");
      }) as FleetEntryImporter,
    ]) {
      const opened = openHost(null, { importEntry });
      opened.host.start();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(opened.phases.at(-1)?.status).toBe("unavailable");
      expect(opened.raw.attached).toBe(0);
    }
    expect(mismatch.mounts).toHaveLength(0);
  });

  test("a module that throws while mounting is unavailable, and Retry mounts the same module again", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const mounts: number[] = [];
    const module: FleetUiModule = {
      contractVersion: FLEET_UI_CONTRACT_VERSION,
      mount() {
        mounts.push(mounts.length);
        if (fail) throw new Error("boom");
        return { unmount() {} };
      },
    };
    const opened = openHost(module);
    opened.host.start();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(opened.phases.at(-1)).toEqual({ status: "unavailable", reason: "Fleet could not start." });
    fail = false;
    opened.host.retry();
    expect(opened.phases.at(-1)?.status).toBe("ready");
    expect(opened.asked).toHaveLength(1);
    error.mockRestore();
  });
});

describe("the unavailable state", () => {
  test("says Fleet is unavailable, with the reason and Retry", () => {
    const markup = renderToStaticMarkup(<FleetUnavailable reason="The Fleet module could not be loaded." onRetry={() => {}} />);
    expect(markup).toContain("Fleet is unavailable");
    expect(markup).toContain("The Fleet module could not be loaded.");
    expect(markup).toContain(">Retry<");
  });
});

describe("an ended session while Fleet is open", () => {
  test("a failed portal request keeps its HTTP status", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    try {
      const error = await api("/api/portal/me?workspaceId=ws_acme").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PortalApiError);
      expect((error as PortalApiError).status).toBe(401);
      expect((error as PortalApiError).message).toBe("unauthorized");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("only a 401 means the session ended; a 5xx, a 403 or a network failure is Fleet being unreachable", () => {
    expect(endsSession(new PortalApiError("unauthorized", 401))).toBe(true);
    expect(endsSession(new PortalApiError("down", 503))).toBe(false);
    expect(endsSession(new PortalApiError("forbidden", 403))).toBe(false);
    expect(endsSession(new TypeError("Failed to fetch"))).toBe(false);
    expect(endsSession(null)).toBe(false);
  });
});
