import { describe, expect, spyOn, test } from "bun:test";
import { ORGANIZATION_CAPABILITIES } from "@mentra/workspace-contract";
import { FLEET_UI_CONTRACT_VERSION, type FleetUiContext, type FleetUiModule } from "@mentra/workspace-contract/fleet-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { visiblePages, type AdminMe } from "../lib/admin-access";
import {
  FLEET_API_BASE,
  FLEET_MODULE_URL,
  FleetPage,
  FleetUnavailable,
  FleetUnavailableError,
  fleetLocation,
  fleetRoute,
  fleetUiMe,
  loadFleetModule,
  normalizeFleetPath,
  readFleetPath,
  type FleetEntryImporter,
  type FleetPageProps,
} from "./fleet";

// React only runs effects inside act() when it knows it is under test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Synthetic people and a fake module only. No test reaches the network or Core.
const orgAdmin: AdminMe = {
  authenticated: true,
  user: { mentraUserId: "mu_ada", email: "ada@acme.test", emailVerified: true, isOrganizationAdmin: true },
  credential: null,
  organization: { capabilities: ["organization.fleet.administer", "organization.incidents.read"] },
  workspaces: [],
  fleet: { installed: true },
};

describe("the Fleet item in the admin portal's navigation", () => {
  // App.tsx reads the address bar when it is imported, so it needs a window for that one moment.
  async function loadNav() {
    const scope = globalThis as { window?: unknown };
    scope.window = { location: { search: "", hostname: "localhost", href: "http://localhost/", pathname: "/" } };
    try {
      return await import("../App");
    } finally {
      delete scope.window;
    }
  }

  test("is offered, after the incident system and labelled Fleet, to an Organization Admin once Fleet is installed", async () => {
    const { visibleNav } = await loadNav();
    const nav = visibleNav(visiblePages({ ...orgAdmin, organization: { capabilities: [...ORGANIZATION_CAPABILITIES] } }));
    expect(nav.map(item => item.key)).toEqual(["incidents", "fleet", "test-runs", "routine-catalog", "system-health", "workspaces", "operator-keys", "audit"]);
    expect(nav.find(item => item.key === "fleet")?.label).toBe("Fleet");
  });

  test("is hidden when Fleet is not installed, or the answer is missing", async () => {
    const { visibleNav } = await loadNav();
    const held = [...ORGANIZATION_CAPABILITIES];
    expect(visibleNav(visiblePages({ ...orgAdmin, organization: { capabilities: held }, fleet: { installed: false } })).map(item => item.key)).not.toContain("fleet");
    expect(visibleNav(visiblePages({ ...orgAdmin, organization: { capabilities: held }, fleet: undefined })).map(item => item.key)).not.toContain("fleet");
  });

  test("is hidden without organization.fleet.administer even when Fleet is installed", async () => {
    const { visibleNav } = await loadNav();
    const without = ORGANIZATION_CAPABILITIES.filter(capability => capability !== "organization.fleet.administer");
    const nav = visibleNav(visiblePages({ ...orgAdmin, organization: { capabilities: [...without] } }));
    expect(nav.map(item => item.key)).not.toContain("fleet");
    expect(nav.length).toBeGreaterThan(0);
  });
});

describe("the Fleet route in the address bar", () => {
  test("?fleet= holds the route, with its own query, and its absence means no Fleet link", () => {
    expect(readFleetPath("")).toBeNull();
    expect(readFleetPath("?systemHealth=1")).toBeNull();
    expect(readFleetPath("?fleet=%2Fdevices%3Ftab%3Dphones")).toBe("/devices?tab=phones");
    expect(readFleetPath("?routineCatalog=1&fleet=%2Fusage%2Fmu_1")).toBe("/usage/mu_1");
  });

  test("a blank route is the overview, and a route is always a path from the root", () => {
    expect(readFleetPath("?fleet=")).toBe("/");
    expect(readFleetPath("?fleet=devices")).toBe("/devices");
    expect(normalizeFleetPath("//evil.test/x")).toBe("/evil.test/x");
    expect(normalizeFleetPath("https://evil.test/x")).toBe("/https://evil.test/x");
    expect(normalizeFleetPath("/devices\n?x=1")).toBe("/");
    expect(normalizeFleetPath(`/${"a".repeat(3000)}`)).toBe("/");
  });

  test("splits into the path and the query (with its ?) that a module reads", () => {
    expect(fleetRoute("/")).toEqual({ path: "/", query: "" });
    expect(fleetRoute("/devices")).toEqual({ path: "/devices", query: "" });
    expect(fleetRoute("/devices?tab=phones&q=a%3Fb")).toEqual({ path: "/devices", query: "?tab=phones&q=a%3Fb" });
    expect(fleetRoute("/usage?")).toEqual({ path: "/usage", query: "" });
    expect(fleetRoute("?range=7d")).toEqual({ path: "/", query: "?range=7d" });
  });

  test("builds the location for a route, keeping the rest of the address", () => {
    expect(fleetLocation("https://admin.test/", "/devices?tab=phones")).toBe("/?fleet=%2Fdevices%3Ftab%3Dphones");
    expect(fleetLocation("https://admin.test/?fleet=%2F&x=1#top", "/usage")).toBe("/?fleet=%2Fusage&x=1#top");
    expect(fleetLocation("https://admin.test/?fleet=%2Fusage", "usage")).toBe("/?fleet=%2Fusage");
  });

  test("reads back what it wrote", () => {
    for (const route of ["/", "/devices", "/devices/dev_1?tab=battery&since=7d", "/usage/mu_1?range=custom&from=2026-10-01"]) {
      const location = fleetLocation("https://admin.test/", route);
      expect(readFleetPath(new URL(location, "https://admin.test").search)).toBe(route);
    }
  });
});

describe("what the module is told about the caller", () => {
  test("is the contract's fields only, not the portal's credential or workspaces", () => {
    const portalMe: AdminMe = {
      ...orgAdmin,
      credential: { credentialId: "cred_1", credentialKind: "organization", label: "ops key" },
      workspaces: [{ workspaceId: "ws_acme", name: "Acme", capabilities: ["workspace.read"], role: "owner" }] as unknown as AdminMe["workspaces"],
    };
    expect(fleetUiMe(portalMe)).toEqual({
      authenticated: true,
      user: { mentraUserId: "mu_ada", email: "ada@acme.test" },
      organization: { capabilities: ["organization.fleet.administer", "organization.incidents.read"] },
      fleet: { installed: true },
    });
  });

  test("is not signed in as a person for a key, and Fleet not installed when the answer is missing", () => {
    expect(fleetUiMe({ ...orgAdmin, user: null, fleet: undefined })).toMatchObject({ user: null, fleet: { installed: false } });
  });
});

function fakeModule(overrides: Partial<FleetUiModule> = {}) {
  const mounts: Array<{ element: unknown; ctx: FleetUiContext }> = [];
  const unmounts: number[] = [];
  const module: FleetUiModule = {
    contractVersion: FLEET_UI_CONTRACT_VERSION,
    mount(element, ctx) {
      const id = mounts.length;
      mounts.push({ element, ctx });
      // Render something, and leave it there when unmounted: the page must not trust the module to clean up.
      (element as unknown as FakeShadowRoot).children.push(`fleet ${ctx.route.path}${ctx.route.query}`);
      return {
        unmount() {
          unmounts.push(id);
        },
      };
    },
    ...overrides,
  };
  return { module, mounts, unmounts };
}

function importing(entry: unknown): { importEntry: FleetEntryImporter; specifiers: string[] } {
  const specifiers: string[] = [];
  return {
    specifiers,
    importEntry: async specifier => {
      specifiers.push(specifier);
      return entry;
    },
  };
}

interface FakeShadowRoot {
  children: string[];
  replaceChildren(): void;
}

/** A host element standing in for the DOM's: one open shadow root, and a second attachShadow throws as it does there. */
function fakeHost() {
  const shadow: FakeShadowRoot = {
    children: [],
    replaceChildren() {
      this.children.length = 0;
    },
  };
  const host = {
    attachCalls: 0,
    attachedMode: null as string | null,
    shadowRoot: null as FakeShadowRoot | null,
    attachShadow(init: { mode: string }) {
      if (host.shadowRoot) throw new DOMException("A shadow root is already attached", "NotSupportedError");
      host.attachCalls += 1;
      host.attachedMode = init.mode;
      host.shadowRoot = shadow;
      return shadow;
    },
  };
  return { host, shadow };
}

interface Opened {
  view: ReactTestRenderer;
  host: ReturnType<typeof fakeHost>["host"];
  shadow: FakeShadowRoot;
  navigations: Array<{ path: string; replace: boolean | undefined }>;
  expired: number[];
  props: FleetPageProps;
  update(next: Partial<FleetPageProps>): Promise<void>;
}

async function open(importEntry: FleetEntryImporter, overrides: Partial<FleetPageProps> = {}): Promise<Opened> {
  const { host, shadow } = fakeHost();
  const navigations: Opened["navigations"] = [];
  const expired: number[] = [];
  const props: FleetPageProps = {
    me: orgAdmin,
    path: "/",
    onNavigate: (path, opts) => navigations.push({ path, replace: opts?.replace }),
    onSessionExpired: () => expired.push(expired.length),
    importEntry,
    ...overrides,
  };
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(<FleetPage {...props} />, { createNodeMock: element => (element.type === "div" ? host : null) });
  });
  return {
    view,
    host,
    shadow,
    navigations,
    expired,
    props,
    async update(next) {
      Object.assign(props, next);
      await act(async () => {
        view.update(<FleetPage {...props} />);
      });
    },
  };
}

function shown(view: ReactTestRenderer): string {
  return JSON.stringify(view.toJSON());
}

/** The console.error calls about the module (the test renderer has its own to report). */
function logs(spy: { mock: { calls: unknown[][] } }, about: string): unknown[][] {
  return spy.mock.calls.filter(([message]) => typeof message === "string" && message.includes(about));
}

function button(view: ReactTestRenderer, label: string) {
  return view.root.find(node => node.type === "button" && node.props.children === label);
}

describe("loading the Fleet module", () => {
  test("imports the same-origin entry and returns its default export", async () => {
    const { module } = fakeModule();
    const { importEntry, specifiers } = importing({ default: module });
    expect(FLEET_MODULE_URL).toBe("/api/admin/fleet/ui/entry.js");
    await expect(loadFleetModule(importEntry)).resolves.toBe(module);
    expect(specifiers).toEqual([FLEET_MODULE_URL]);
  });

  test("a retry asks for a URL no earlier attempt used, so a cached failure or stale module cannot answer it", async () => {
    const { module } = fakeModule();
    const { importEntry, specifiers } = importing({ default: module });
    await loadFleetModule(importEntry, 1760000000000);
    await loadFleetModule(importEntry, 1760000000001);
    expect(specifiers).toEqual([`${FLEET_MODULE_URL}?retry=1760000000000`, `${FLEET_MODULE_URL}?retry=1760000000001`]);
  });

  test("refuses a module built for another contract version", async () => {
    const { module } = fakeModule({ contractVersion: FLEET_UI_CONTRACT_VERSION + 1 });
    const error = await loadFleetModule(importing({ default: module }).importEntry).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FleetUnavailableError);
    expect((error as Error).message).toContain(`version ${FLEET_UI_CONTRACT_VERSION + 1}`);
  });

  test("refuses an entry with no usable default export, whatever else it exports", async () => {
    for (const entry of [{}, { default: null }, { default: "fleet" }, { default: { contractVersion: 1 } }, { default: { mount() {} } }, null, undefined]) {
      const error = await loadFleetModule(importing(entry).importEntry).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FleetUnavailableError);
    }
  });

  test("a failed import (the 404 and 503 Core answers while Fleet is missing or down) is Fleet being unavailable", async () => {
    const failing: FleetEntryImporter = async () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    };
    const error = await loadFleetModule(failing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FleetUnavailableError);
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });
});

describe("the Fleet page", () => {
  test("says it is loading until the module has been imported", () => {
    const markup = renderToStaticMarkup(
      <FleetPage me={orgAdmin} path="/" onNavigate={() => {}} onSessionExpired={() => {}} importEntry={async () => new Promise(() => {})} />,
    );
    expect(markup).toContain("Loading Fleet");
    expect(markup).not.toContain("Fleet is unavailable");
  });

  test("mounts the module into an open shadow root with the contract's apiBase, me and route", async () => {
    const { module, mounts } = fakeModule();
    const { importEntry, specifiers } = importing({ default: module });
    const { host, shadow, view } = await open(importEntry, { path: "/devices?tab=phones" });

    expect(specifiers).toEqual([FLEET_MODULE_URL]);
    expect(host.attachCalls).toBe(1);
    expect(host.attachedMode).toBe("open");
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.element).toBe(shadow);
    expect(mounts[0]!.ctx).toMatchObject({
      contractVersion: FLEET_UI_CONTRACT_VERSION,
      apiBase: "/api/admin/fleet",
      me: fleetUiMe(orgAdmin),
      route: { path: "/devices", query: "?tab=phones" },
    });
    expect(FLEET_API_BASE).toBe("/api/admin/fleet");
    expect(shown(view)).not.toContain("Loading Fleet");
    expect(shown(view)).not.toContain("Fleet is unavailable");
  });

  test("shows Fleet is unavailable, with Retry, for a module on another contract version, and never mounts it", async () => {
    const { module, mounts } = fakeModule({ contractVersion: 2 });
    const { host, view } = await open(importing({ default: module }).importEntry);
    expect(shown(view)).toContain("Fleet is unavailable");
    expect(button(view, "Retry")).toBeDefined();
    expect(mounts).toHaveLength(0);
    expect(host.attachCalls).toBe(0);
  });

  test("shows Fleet is unavailable when the import fails, and Retry loads it again under a fresh URL", async () => {
    const { module, mounts } = fakeModule();
    const specifiers: string[] = [];
    let failing = true;
    const importEntry: FleetEntryImporter = async specifier => {
      specifiers.push(specifier);
      if (failing) throw new TypeError("Failed to fetch dynamically imported module");
      return { default: module };
    };
    const opened = await open(importEntry);
    expect(shown(opened.view)).toContain("Fleet is unavailable");
    expect(mounts).toHaveLength(0);

    failing = false;
    await act(async () => {
      button(opened.view, "Retry").props.onClick();
    });
    expect(specifiers).toHaveLength(2);
    expect(specifiers[0]).toBe(FLEET_MODULE_URL);
    expect(specifiers[1]).toMatch(/^\/api\/admin\/fleet\/ui\/entry\.js\?retry=\d+$/);
    expect(mounts).toHaveLength(1);
    expect(shown(opened.view)).not.toContain("Fleet is unavailable");
  });

  test("shows Fleet is unavailable when mount throws, and leaves nothing of the module behind", async () => {
    const { module } = fakeModule({
      mount(element) {
        (element as unknown as FakeShadowRoot).children.push("half drawn");
        throw new Error("boom");
      },
    });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { view, shadow } = await open(importing({ default: module }).importEntry);
      expect(shown(view)).toContain("Fleet is unavailable");
      expect(shadow.children).toEqual([]);
      expect(logs(logged, "failed to mount")).toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
  });

  test("unmounts the module and clears its shadow root when the page is left", async () => {
    const { module, mounts, unmounts } = fakeModule();
    const { view, shadow } = await open(importing({ default: module }).importEntry);
    expect(mounts).toHaveLength(1);
    expect(shadow.children).toEqual(["fleet /"]);

    await act(async () => {
      view.unmount();
    });
    expect(unmounts).toEqual([0]);
    // The module's own unmount left its markup behind; the page does not.
    expect(shadow.children).toEqual([]);
  });

  test("never mounts a module that finishes loading after the page was left", async () => {
    const { module, mounts } = fakeModule();
    let finish!: (entry: unknown) => void;
    const slow = new Promise<unknown>(resolve => {
      finish = resolve;
    });
    const { view, host } = await open(() => slow);
    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      finish({ default: module });
      await slow;
    });
    expect(mounts).toHaveLength(0);
    expect(host.attachCalls).toBe(0);
  });

  test("a module that throws from unmount does not stop the page from leaving", async () => {
    const { module } = fakeModule({
      mount() {
        return {
          unmount() {
            throw new Error("unmount failed");
          },
        };
      },
    });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { view, shadow } = await open(importing({ default: module }).importEntry);
      await act(async () => {
        view.unmount();
      });
      expect(logs(logged, "failed to unmount")).toHaveLength(1);
      expect(shadow.children).toEqual([]);
    } finally {
      logged.mockRestore();
    }
  });

  test("a new route unmounts the old mount and mounts again in the same shadow root", async () => {
    const { module, mounts, unmounts } = fakeModule();
    const { importEntry, specifiers } = importing({ default: module });
    const opened = await open(importEntry, { path: "/" });
    await opened.update({ path: "/usage/mu_1?range=30d" });

    expect(unmounts).toEqual([0]);
    expect(mounts).toHaveLength(2);
    expect(mounts[1]!.ctx.route).toEqual({ path: "/usage/mu_1", query: "?range=30d" });
    expect(mounts[1]!.element).toBe(opened.shadow);
    // attachShadow throws when called twice on a real element, so a second call here would have failed the mount.
    expect(opened.host.attachCalls).toBe(1);
    expect(opened.shadow.children).toEqual(["fleet /usage/mu_1?range=30d"]);
    // The module was already imported once for this page; going to another route is not an unavailable Fleet.
    expect(shown(opened.view)).not.toContain("Fleet is unavailable");
    expect(specifiers.every(specifier => specifier.startsWith(FLEET_MODULE_URL))).toBe(true);
  });

  test("the same route with new handlers or a refreshed me does not remount the module", async () => {
    const { module, mounts, unmounts } = fakeModule();
    const opened = await open(importing({ default: module }).importEntry, { path: "/devices" });
    const later: string[] = [];
    await opened.update({
      me: { ...orgAdmin },
      onNavigate: path => later.push(path),
      onSessionExpired: () => later.push("expired"),
    });
    expect(mounts).toHaveLength(1);
    expect(unmounts).toEqual([]);

    // The running module reaches the page's latest handlers through the context it was given.
    mounts[0]!.ctx.navigate("/usage");
    mounts[0]!.ctx.onSessionExpired();
    expect(later).toEqual(["/usage", "expired"]);
    expect(opened.navigations).toEqual([]);
    expect(opened.expired).toEqual([]);
  });

  test("passes the module's navigate on to the page, as a push unless it asks to replace, with a clean route", async () => {
    const { module, mounts } = fakeModule();
    const opened = await open(importing({ default: module }).importEntry);
    const { ctx } = mounts[0]!;
    ctx.navigate("/devices?tab=phones");
    ctx.navigate("/usage", { replace: true });
    ctx.navigate("//evil.test");
    expect(opened.navigations).toEqual([
      { path: "/devices?tab=phones", replace: undefined },
      { path: "/usage", replace: true },
      { path: "/evil.test", replace: undefined },
    ]);
  });

  test("ignores navigation from a mount that was replaced or left, but still passes on an expired session", async () => {
    const { module, mounts } = fakeModule();
    const opened = await open(importing({ default: module }).importEntry, { path: "/" });
    const first = mounts[0]!.ctx;
    await opened.update({ path: "/devices" });
    first.navigate("/stale");
    expect(opened.navigations).toEqual([]);

    await act(async () => {
      opened.view.unmount();
    });
    mounts[1]!.ctx.navigate("/after-leaving");
    expect(opened.navigations).toEqual([]);

    // The session is the caller's, not the route's: a 401 that lands as the page closes is still true.
    mounts[1]!.ctx.onSessionExpired();
    expect(opened.expired).toEqual([0]);
  });

  test("tells the page when the module reports an expired session", async () => {
    const { module, mounts } = fakeModule();
    const opened = await open(importing({ default: module }).importEntry);
    mounts[0]!.ctx.onSessionExpired();
    expect(opened.expired).toEqual([0]);
  });

  test("reopening later attaches a shadow root to the new element once, and a retained one is reused", async () => {
    const { module, mounts } = fakeModule();
    const { importEntry } = importing({ default: module });
    const first = await open(importEntry);
    await act(async () => {
      first.view.unmount();
    });
    const second = await open(importEntry);
    expect(first.host.attachCalls).toBe(1);
    expect(second.host.attachCalls).toBe(1);
    expect(mounts).toHaveLength(2);

    // A host that already holds an open shadow root (an effect run twice, as in development) is reused.
    const { host, shadow } = fakeHost();
    host.shadowRoot = shadow;
    let view!: ReactTestRenderer;
    await act(async () => {
      view = create(
        <FleetPage me={orgAdmin} path="/" onNavigate={() => {}} onSessionExpired={() => {}} importEntry={importEntry} />,
        { createNodeMock: element => (element.type === "div" ? host : null) },
      );
    });
    expect(host.attachCalls).toBe(0);
    expect(mounts[2]!.element).toBe(shadow);
    await act(async () => {
      view.unmount();
    });
  });
});

describe("the unavailable notice", () => {
  test("says Fleet is unavailable, gives the reason, and offers Retry", () => {
    const markup = renderToStaticMarkup(<FleetUnavailable reason="The Fleet module could not be loaded." onRetry={() => {}} />);
    expect(markup).toContain("Fleet is unavailable");
    expect(markup).toContain("The Fleet module could not be loaded.");
    expect(markup).toContain('role="alert"');
    expect(markup).toMatch(/<button[^>]*>Retry<\/button>/);
  });
});
