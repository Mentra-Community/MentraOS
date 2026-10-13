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
  fleetHomeLocation,
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

describe("which page an address asks for", () => {
  async function loadPage() {
    const scope = globalThis as { window?: unknown };
    scope.window = { location: { search: "", hostname: "localhost", href: "http://localhost/", pathname: "/" } };
    try {
      return (await import("../App")).requestedPage;
    } finally {
      delete scope.window;
    }
  }
  const prCheck = `pr-check-${"a".repeat(64)}`;

  test("a Fleet link outranks the testing pages and the incident report, and only a system health link outranks it", async () => {
    const requestedPage = await loadPage();
    // The same order as the browser's Back and Forward restore: system health, Fleet, test runs, routine catalog.
    expect(requestedPage("?systemHealth=1&fleet=%2F")).toBe("system-health");
    expect(requestedPage("?fleet=%2Fdevices&testRuns=1")).toBe("fleet");
    expect(requestedPage(`?prCheck=${prCheck}&fleet=%2F`)).toBe("fleet");
    expect(requestedPage("?routineCatalog=1&fleet=%2F")).toBe("fleet");
    expect(requestedPage("?fleet=%2F", "rep_1")).toBe("fleet");
  });

  test("the other pages keep their order, and a report link opens the incident system", async () => {
    const requestedPage = await loadPage();
    expect(requestedPage("?testRuns=1&routineCatalog=1")).toBe("test-runs");
    expect(requestedPage(`?prCheck=${prCheck}`)).toBe("test-runs");
    expect(requestedPage("?routineCatalog=1", "rep_1")).toBe("routine-catalog");
    expect(requestedPage("", "rep_1")).toBe("incidents");
    expect(requestedPage("")).toBeNull();
    expect(requestedPage("?unrelated=1")).toBeNull();
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

  test("the Fleet page is entered at the overview with nothing else in the address", () => {
    expect(fleetHomeLocation()).toBe("/?fleet=%2F");
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

function fakeModule(options: { setRoute?: boolean } & Partial<FleetUiModule> = {}) {
  const { setRoute: redraws = false, ...overrides } = options;
  const mounts: Array<{ element: unknown; ctx: FleetUiContext }> = [];
  const unmounts: number[] = [];
  const routes: Array<{ path: string; query: string }> = [];
  /** What happened, in order. A synchronous remount shows up as an unmount straight followed by a mount. */
  const events: string[] = [];
  const module: FleetUiModule = {
    contractVersion: FLEET_UI_CONTRACT_VERSION,
    mount(element, ctx) {
      const id = mounts.length;
      mounts.push({ element, ctx });
      events.push(`mount ${ctx.route.path}${ctx.route.query}`);
      // Render something, and leave it there when unmounted: the page must not trust the module to clean up.
      (element as unknown as FakeShadowRoot).children.push(`fleet ${ctx.route.path}${ctx.route.query}`);
      return {
        unmount() {
          unmounts.push(id);
          events.push(`unmount ${id}`);
        },
        ...(redraws
          ? {
              setRoute(route: { path: string; query: string }) {
                routes.push(route);
                events.push(`setRoute ${route.path}${route.query}`);
                (element as unknown as FakeShadowRoot).children.splice(0, 1, `fleet ${route.path}${route.query}`);
              },
            }
          : {}),
      };
    },
    ...overrides,
  };
  return { module, mounts, unmounts, routes, events };
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
  /** The same, without act: for a test that wraps it in a synchronous act to show nothing was awaited. */
  updateNow(next: Partial<FleetPageProps>): void;
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
    updateNow(next) {
      Object.assign(props, next);
      view.update(<FleetPage {...props} />);
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

  test("shows Fleet is unavailable when the import fails, and Retry imports again under a fresh URL", async () => {
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

  test("Retry after a mount that threw mounts the module already loaded, not a second evaluation of it", async () => {
    // A module with import-time side effects (customElements.define, say) throws if it is evaluated twice.
    const attempts: string[] = [];
    const { module } = fakeModule({
      mount(element, ctx) {
        attempts.push(ctx.route.path);
        if (attempts.length === 1) throw new Error("boom");
        (element as unknown as FakeShadowRoot).children.push("fleet");
        return { unmount() {} };
      },
    });
    const { importEntry, specifiers } = importing({ default: module });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const opened = await open(importEntry, { path: "/devices" });
      expect(shown(opened.view)).toContain("Fleet is unavailable");
      expect(specifiers).toEqual([FLEET_MODULE_URL]);

      await act(async () => {
        button(opened.view, "Retry").props.onClick();
      });
      // Imported once, mounted twice, and no `?retry=` URL was ever asked for.
      expect(specifiers).toEqual([FLEET_MODULE_URL]);
      expect(attempts).toEqual(["/devices", "/devices"]);
      expect(shown(opened.view)).not.toContain("Fleet is unavailable");
      expect(opened.shadow.children).toEqual(["fleet"]);
    } finally {
      logged.mockRestore();
    }
  });

  test("Retry clicked twice before the page redraws imports and mounts once", async () => {
    const { module, mounts } = fakeModule();
    let failing = true;
    let calls = 0;
    const importEntry: FleetEntryImporter = async () => {
      calls += 1;
      if (failing) throw new TypeError("Failed to fetch dynamically imported module");
      return { default: module };
    };
    const opened = await open(importEntry);
    failing = false;
    const retry = button(opened.view, "Retry");
    await act(async () => {
      retry.props.onClick();
      retry.props.onClick();
    });
    expect(calls).toBe(2);
    expect(mounts).toHaveLength(1);
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

  for (const redraws of [false, true]) {
    const kind = redraws ? "a module that redraws itself (setRoute)" : "a module that is mounted again for a route";

    test(`unmounts ${kind} and clears its shadow root when the page is left`, async () => {
      const { module, mounts, unmounts } = fakeModule({ setRoute: redraws });
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

    test(`the same route with new handlers or a refreshed me does not touch ${kind}`, async () => {
      const { module, mounts, unmounts, routes } = fakeModule({ setRoute: redraws });
      const opened = await open(importing({ default: module }).importEntry, { path: "/devices" });
      const later: string[] = [];
      await opened.update({
        me: { ...orgAdmin },
        onNavigate: path => later.push(path),
        onSessionExpired: () => later.push("expired"),
      });
      expect(mounts).toHaveLength(1);
      expect(unmounts).toEqual([]);
      expect(routes).toEqual([]);

      // The running module reaches the page's latest handlers through the context it was given.
      mounts[0]!.ctx.navigate("/usage");
      mounts[0]!.ctx.onSessionExpired();
      expect(later).toEqual(["/usage", "expired"]);
      expect(opened.navigations).toEqual([]);
      expect(opened.expired).toEqual([]);
    });

    test(`passes ${kind}'s navigate on to the page, as a push unless it asks to replace, with a clean route`, async () => {
      const { module, mounts } = fakeModule({ setRoute: redraws });
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

    test(`${kind} is mounted at the latest route when the route changed while it loaded`, async () => {
      const { module, mounts } = fakeModule({ setRoute: redraws });
      let finish!: (entry: unknown) => void;
      const slow = new Promise<unknown>(resolve => {
        finish = resolve;
      });
      const opened = await open(() => slow, { path: "/" });
      await opened.update({ path: "/usage?range=30d" });
      await act(async () => {
        finish({ default: module });
        await slow;
      });
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.ctx.route).toEqual({ path: "/usage", query: "?range=30d" });
    });

    test(`${kind} is mounted at the latest route by a Retry after the route changed`, async () => {
      const { module, mounts } = fakeModule({ setRoute: redraws });
      let failing = true;
      const importEntry: FleetEntryImporter = async () => {
        if (failing) throw new TypeError("Failed to fetch dynamically imported module");
        return { default: module };
      };
      const opened = await open(importEntry, { path: "/" });
      await opened.update({ path: "/devices" });
      failing = false;
      await act(async () => {
        button(opened.view, "Retry").props.onClick();
      });
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!.ctx.route).toEqual({ path: "/devices", query: "" });
    });
  }

  test("a module that cannot redraw is unmounted and mounted again in one synchronous step for a new route", async () => {
    const { module, mounts, unmounts, events } = fakeModule();
    const { importEntry, specifiers } = importing({ default: module });
    const opened = await open(importEntry, { path: "/" });
    expect(events).toEqual(["mount /"]);

    // A synchronous act: nothing has been awaited when it returns, so no frame can be painted in between.
    act(() => {
      opened.updateNow({ path: "/usage/mu_1?range=30d" });
    });
    expect(events).toEqual(["mount /", "unmount 0", "mount /usage/mu_1?range=30d"]);
    expect(unmounts).toEqual([0]);
    expect(mounts).toHaveLength(2);
    expect(mounts[1]!.ctx.route).toEqual({ path: "/usage/mu_1", query: "?range=30d" });
    expect(mounts[1]!.element).toBe(opened.shadow);
    // attachShadow throws when called twice on a real element, so a second call here would have failed the mount.
    expect(opened.host.attachCalls).toBe(1);
    expect(opened.shadow.children).toEqual(["fleet /usage/mu_1?range=30d"]);
    // The module is imported once. Going to another route is not an unavailable Fleet, and shows no spinner.
    expect(specifiers).toEqual([FLEET_MODULE_URL]);
    expect(shown(opened.view)).not.toContain("Fleet is unavailable");
    expect(shown(opened.view)).not.toContain("Loading Fleet");
  });

  test("a module that redraws itself is given the new route and is neither unmounted nor mounted again", async () => {
    const { module, mounts, unmounts, routes, events } = fakeModule({ setRoute: true });
    const { importEntry, specifiers } = importing({ default: module });
    const opened = await open(importEntry, { path: "/" });

    act(() => {
      opened.updateNow({ path: "/devices?tab=phones" });
    });
    expect(routes).toEqual([{ path: "/devices", query: "?tab=phones" }]);
    expect(events).toEqual(["mount /", "setRoute /devices?tab=phones"]);
    expect(mounts).toHaveLength(1);
    expect(unmounts).toEqual([]);
    expect(specifiers).toEqual([FLEET_MODULE_URL]);
    expect(opened.host.attachCalls).toBe(1);
    expect(opened.shadow.children).toEqual(["fleet /devices?tab=phones"]);
  });

  test("a redrawing module's own navigate reaches it again as setRoute once the page has moved, and its context stays live", async () => {
    const { module, mounts, routes } = fakeModule({ setRoute: true });
    const opened = await open(importing({ default: module }).importEntry, { path: "/" });

    // The module asks to go somewhere; the page records it and hands the new route back as its `path`.
    mounts[0]!.ctx.navigate("/usage?range=7d");
    expect(opened.navigations).toEqual([{ path: "/usage?range=7d", replace: undefined }]);
    await opened.update({ path: "/usage?range=7d" });
    // Back and Forward arrive the same way.
    await opened.update({ path: "/" });
    expect(routes).toEqual([{ path: "/usage", query: "?range=7d" }, { path: "/", query: "" }]);
    expect(mounts).toHaveLength(1);

    mounts[0]!.ctx.navigate("/devices");
    expect(opened.navigations).toHaveLength(2);
  });

  test("a redrawing module whose setRoute throws is mounted again for the route", async () => {
    const mountedAt: string[] = [];
    const unmounted: number[] = [];
    const module: FleetUiModule = {
      contractVersion: FLEET_UI_CONTRACT_VERSION,
      mount(element, ctx) {
        const id = mountedAt.length;
        mountedAt.push(ctx.route.path);
        (element as unknown as FakeShadowRoot).children.push(`fleet ${ctx.route.path}`);
        return {
          unmount() {
            unmounted.push(id);
          },
          setRoute() {
            throw new Error("cannot redraw");
          },
        };
      },
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const opened = await open(importing({ default: module }).importEntry, { path: "/" });
      act(() => {
        opened.updateNow({ path: "/devices" });
      });
      expect(mountedAt).toEqual(["/", "/devices"]);
      expect(unmounted).toEqual([0]);
      expect(opened.shadow.children).toEqual(["fleet /devices"]);
      expect(logs(logged, "failed to change route")).toHaveLength(1);
      expect(shown(opened.view)).not.toContain("Fleet is unavailable");
    } finally {
      logged.mockRestore();
    }
  });

  test("a route change after a failed mount waits for Retry and does not mount behind the notice", async () => {
    const { module, mounts } = fakeModule();
    const attempts: string[] = [];
    const flaky: FleetUiModule = {
      ...module,
      mount(element, ctx) {
        attempts.push(ctx.route.path);
        if (attempts.length === 1) throw new Error("boom");
        return module.mount(element, ctx);
      },
    };
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const opened = await open(importing({ default: flaky }).importEntry, { path: "/" });
      await opened.update({ path: "/devices" });
      expect(attempts).toEqual(["/"]);
      expect(shown(opened.view)).toContain("Fleet is unavailable");
      await act(async () => {
        button(opened.view, "Retry").props.onClick();
      });
      expect(attempts).toEqual(["/", "/devices"]);
      expect(mounts).toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
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

  test("ignores navigation from a redrawing module once the page was left", async () => {
    const { module, mounts } = fakeModule({ setRoute: true });
    const opened = await open(importing({ default: module }).importEntry);
    await act(async () => {
      opened.view.unmount();
    });
    mounts[0]!.ctx.navigate("/after-leaving");
    expect(opened.navigations).toEqual([]);
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
