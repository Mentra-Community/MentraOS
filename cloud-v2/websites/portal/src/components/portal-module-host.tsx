import {
  PORTAL_MODULE_CONTRACT_VERSION,
  type PortalModule,
  type PortalModuleContext,
  type PortalModuleMe,
  type PortalModuleScope,
} from "@mentra/workspace-contract/portal-module-ui";
import { Button, Spinner } from "@mentra/workspace-ui";
import { CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PortalMe } from "@/lib/api";
import { navigate, usePathname, useSearch } from "@/lib/navigation";
import { usePortal } from "@/lib/portal";

/**
 * A host for a portal module's UI: a screen that a separately deployed service brings to the portal and Core
 * serves (`/api/portal/<module>/ui/entry.js`), such as Fleet Management. The same approach as the admin portal's Fleet
 * page: the page imports the module from this origin, checks that it speaks this page's contract version
 * (`@mentra/workspace-contract/portal-module-ui`), and mounts it into an open shadow root, which keeps the
 * module's styles and the portal's apart. The module calls its API through `apiBase`, with the portal's session
 * cookie, and Core decides what each request may do.
 *
 * The route is the portal's own address (its path and query), because that is where the module lives: it reads
 * what it needs from it (a return from checkout, say) and asks the page to go elsewhere through `navigate`. The
 * module is told the route when it mounts; after that a change reaches it through the `setRoute` of the handle
 * it returned, and a module without one is unmounted and mounted again, in one synchronous step, in the same
 * shadow root. The module is imported once: a route change or a Retry after a failed mount reuses it.
 *
 * The Licenses page and the personal Billing page are not modules: `@mentra/workspace-ui` draws them from billing's
 * data (`portalBillingApi` in lib/portal). The one module is Fleet Management's UI, which no page mounts yet.
 */

/** The modules the portal can host. */
export type PortalModuleName = "fleet";

const MODULE_LABELS: Record<PortalModuleName, string> = {
  fleet: "Fleet Management",
};

type ModuleRoute = PortalModuleContext["route"];

/** Where the module's API is, as it is told it. Core forwards it to the module for the people it is offered to. */
export function portalModuleApiBase(name: PortalModuleName): string {
  return `/api/portal/${name}`;
}

/** The module's entry, served by Core from the module's service. Same origin, never a client-chosen URL. */
export function portalModuleEntryUrl(name: PortalModuleName): string {
  return `${portalModuleApiBase(name)}/ui/entry.js`;
}

/**
 * What the module is told about the caller: the contract's fields and nothing else the portal knows. The
 * contract names the Core user id `mentraUserId`; `/api/portal/me` calls it `user.id`, so `/me` is mapped, not
 * passed through.
 */
export function portalModuleMe(me: PortalMe): PortalModuleMe {
  return {
    authenticated: true,
    user: { mentraUserId: me.user.id, email: me.user.email, emailVerified: me.user.emailVerified },
  };
}

/** The longest address a module may send the page to. Nothing the portal shows needs more; a longer one is taken for junk. */
const MAX_PORTAL_PATH_LENGTH = 2048;

/**
 * Whether `value` is an address of this portal: a path from the root (`/account/billing`, with a query if it
 * has one). A module asks the page to go somewhere, so it never names another origin (`https://…`, `//host/…`),
 * and a control character or an excessive length is taken for junk.
 */
export function isPortalPath(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" && value.length <= MAX_PORTAL_PATH_LENGTH && /^\/(?!\/)/.test(value) && !/[\u0000-\u001f\u007f\\]/.test(value);
}

/** The module cannot be shown: it is missing, down, unreadable or for another contract version. */
export class PortalModuleUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PortalModuleUnavailableError";
  }
}

/** Imports an ES module by URL. Tests supply their own. */
export type ModuleEntryImporter = (specifier: string) => Promise<unknown>;

/**
 * The real import. The URL arrives as a parameter, not a literal, so the bundler cannot resolve it and leaves
 * `import()` for the browser to run against Core. (A `const` URL would be inlined and then fail to resolve;
 * build.ts also marks `/api/*` external, whatever the bundler does.) `new Function` would hide it too, but
 * it needs `unsafe-eval`, which the portal's CSP does not give.
 */
export const importModuleEntry: ModuleEntryImporter = specifier => import(specifier);

/**
 * The entry's URL. A retry adds a token that no earlier attempt used. The browser keeps the result of an
 * import by URL (a loaded module in every browser, a failed one in some), so without it Retry would be answered
 * from that memory and could never pick up a module that has come back or been upgraded.
 */
function entryUrl(name: PortalModuleName, retry: number | undefined): string {
  return retry === undefined ? portalModuleEntryUrl(name) : `${portalModuleEntryUrl(name)}?retry=${retry}`;
}

/**
 * Imports the module and checks it: a failed import (the 404 and 503 Core answers while the module is not
 * installed, is not offered to this person or cannot answer), an entry without a module as its default export,
 * and a module built for another contract version all give {@link PortalModuleUnavailableError}.
 */
export async function loadPortalModule(
  name: PortalModuleName,
  importEntry: ModuleEntryImporter = importModuleEntry,
  retry?: number,
): Promise<PortalModule> {
  const label = MODULE_LABELS[name];
  let entry: unknown;
  try {
    entry = await importEntry(entryUrl(name, retry));
  } catch (cause) {
    throw new PortalModuleUnavailableError(`The ${label} module could not be loaded.`, { cause });
  }
  const candidate = (typeof entry === "object" && entry !== null ? (entry as { default?: unknown }).default : undefined) as
    | Partial<PortalModule>
    | null
    | undefined;
  if (typeof candidate !== "object" || candidate === null || typeof candidate.contractVersion !== "number" || typeof candidate.mount !== "function") {
    throw new PortalModuleUnavailableError(`The ${label} module is not one this portal can run.`);
  }
  if (candidate.contractVersion !== PORTAL_MODULE_CONTRACT_VERSION) {
    throw new PortalModuleUnavailableError(
      `The ${label} module uses version ${candidate.contractVersion} of the module interface and this portal uses version ${PORTAL_MODULE_CONTRACT_VERSION}.`,
    );
  }
  return candidate as PortalModule;
}

export type ModulePhase = { status: "loading" } | { status: "ready" } | { status: "unavailable"; reason: string };

const LOADING: ModulePhase = { status: "loading" };
const READY: ModulePhase = { status: "ready" };

/** What the host reads from the page each time it needs it, so a re-render never has to restart the module. */
interface HostInputs {
  me: PortalMe;
  navigate: PortalModuleContext["navigate"];
  onSessionExpired(): void;
}

export interface PortalModuleHostHandle {
  /** Imports the module and mounts it. Settles once it is mounted or known to be unavailable. */
  start(): Promise<void>;
  /** The page's route changed. */
  setRoute(route: ModuleRoute): void;
  /** The Retry button. */
  retry(): Promise<void>;
  /** The page was left (or its host element changed): unmounts and stops reporting. */
  dispose(): void;
}

/**
 * Everything the page does with the module, outside React: import it, mount it, tell it the route, unmount it.
 * One host serves one open page. After {@link PortalModuleHostHandle.dispose} nothing it started touches the page.
 */
export function createPortalModuleHost(options: {
  name: PortalModuleName;
  element: HTMLElement;
  importEntry: ModuleEntryImporter;
  /** What the page covers: one workspace, or the person's own. */
  scope: PortalModuleScope;
  /** The route at the time the page opened. */
  route: ModuleRoute;
  inputs(): HostInputs;
  onPhase(phase: ModulePhase): void;
}): PortalModuleHostHandle {
  const { name, element, importEntry, scope, inputs, onPhase } = options;
  const label = MODULE_LABELS[name];
  // False once disposed: then nothing already started (an import, a callback from the module) may touch the page.
  let live = true;
  let route = options.route;
  // The module once it has been imported and checked. It is evaluated once; a Retry after a failed mount mounts
  // this one again (a module with import-time side effects, a customElements.define say, would throw if it were
  // evaluated a second time under a new URL), and only a failed import is attempted again.
  let loaded: PortalModule | null = null;
  let loading = false;
  let mounted: ReturnType<PortalModule["mount"]> | null = null;
  // Identifies the mount whose context may move the page; zero when none does.
  let active = 0;
  let mounts = 0;

  /** Mounts the loaded module for the current route. Synchronous. */
  function mountLoaded(module: PortalModule): void {
    const id = ++mounts;
    active = id;
    let shadow: ShadowRoot | null = null;
    try {
      // attachShadow throws on an element that has one, so a shadow root from an earlier mount is reused.
      shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
      const context: PortalModuleContext = {
        apiBase: portalModuleApiBase(name),
        me: portalModuleMe(inputs().me),
        scope,
        route,
        navigate: (to, opts) => {
          // Only the module on screen may move the page, and only to an address of this portal.
          if (live && active === id && isPortalPath(to)) inputs().navigate(to, opts);
        },
        // The session is the caller's, not this mount's, so a 401 that lands late is still true.
        onSessionExpired: () => inputs().onSessionExpired(),
      };
      mounted = module.mount(shadow, context);
      onPhase(READY);
    } catch (error) {
      console.error(`The ${label} module failed to mount.`, error);
      active = 0;
      shadow?.replaceChildren();
      onPhase({ status: "unavailable", reason: `${label} could not start.` });
    }
  }

  /** Unmounts what is mounted and empties the shadow root, which stays with the element for the next mount. */
  function unmountMounted(): void {
    active = 0;
    const handle = mounted;
    mounted = null;
    try {
      handle?.unmount();
    } catch (error) {
      console.error(`The ${label} module failed to unmount.`, error);
    }
    // Whatever the module left behind goes too.
    element.shadowRoot?.replaceChildren();
  }

  async function load(retry?: number): Promise<void> {
    loading = true;
    onPhase(LOADING);
    try {
      const module = await loadPortalModule(name, importEntry, retry);
      if (!live) return;
      loaded = module;
      mountLoaded(module);
    } catch (error) {
      if (live) {
        onPhase({
          status: "unavailable",
          reason: error instanceof PortalModuleUnavailableError ? error.message : `${label} could not start.`,
        });
      }
    } finally {
      loading = false;
    }
  }

  return {
    start: () => load(),
    setRoute(next) {
      if (next.path === route.path && next.query === route.query) return;
      route = next;
      // Nothing is mounted while the module is loading (it mounts at `route` when it arrives) or after a failure
      // (Retry mounts at `route`).
      const handle = mounted;
      if (!live || !handle || !loaded) return;
      if (typeof handle.setRoute === "function") {
        try {
          handle.setRoute(next);
          return;
        } catch (error) {
          console.error(`The ${label} module failed to change route; mounting it again.`, error);
        }
      }
      // One synchronous step, so no frame is painted between the old mount and the new one.
      unmountMounted();
      mountLoaded(loaded);
    },
    async retry() {
      if (!live || loading) return;
      if (loaded) {
        // The import was fine and the mount was not: mount the same module again.
        unmountMounted();
        mountLoaded(loaded);
      } else {
        // The import failed, and the browser may remember that for the URL: ask for one it has not seen.
        await load(Date.now());
      }
    },
    dispose() {
      live = false;
      unmountMounted();
    },
  };
}

export interface PortalModuleHostProps {
  module: PortalModuleName;
  /** The signed-in person, as `/api/portal/me` answered. The module is told {@link portalModuleMe} of it. */
  me: PortalMe;
  scope: PortalModuleScope;
  /** Imports the module. Tests only. */
  importEntry?: ModuleEntryImporter;
}

/** The module on a page: Loading, the module itself once mounted, or the unavailable state with Retry. */
export function PortalModuleHost({ module: name, me, scope, importEntry = importModuleEntry }: PortalModuleHostProps) {
  const label = MODULE_LABELS[name];
  const element = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<ModulePhase>(LOADING);
  const portal = usePortal();
  const path = usePathname();
  const query = useSearch();
  const latest = useRef({ me, route: { path, query }, onSessionExpired: portal.sessionExpired });
  useEffect(() => {
    latest.current = { me, route: { path, query }, onSessionExpired: portal.sessionExpired };
  });
  const host = useRef<PortalModuleHostHandle | null>(null);
  // A host serves one scope: another workspace's page is another host.
  const scopeKey = scope.kind === "workspace" ? `workspace:${scope.workspaceId}` : "person";

  // One host per open page (and per module, scope and importer): it imports and mounts the module once.
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const created = createPortalModuleHost({
      name,
      element: target,
      importEntry,
      scope,
      route: latest.current.route,
      inputs: () => ({
        me: latest.current.me,
        navigate,
        onSessionExpired: () => latest.current.onSessionExpired(),
      }),
      onPhase: setPhase,
    });
    host.current = created;
    void created.start();
    return () => {
      created.dispose();
      host.current = null;
    };
    // `scope` is stood for by `scopeKey`: a new object for the same scope must not restart the module.
  }, [name, importEntry, scopeKey]);

  useEffect(() => {
    host.current?.setRoute({ path, query });
  }, [path, query]);

  return (
    <section aria-label={label}>
      {phase.status === "loading" ? (
        <div role="status" className="text-muted-foreground flex items-center gap-2.5 text-sm">
          <Spinner /> {`Loading ${label}`}
        </div>
      ) : null}
      {phase.status === "unavailable" ? (
        <PortalModuleUnavailable label={label} reason={phase.reason} onRetry={() => void host.current?.retry()} />
      ) : null}
      <div ref={element} hidden={phase.status === "unavailable"} />
    </section>
  );
}

export function PortalModuleUnavailable({ label, reason, onRetry }: { label: string; reason: string; onRetry(): void }) {
  return (
    <div role="alert" className="bg-card rounded-card flex min-h-[190px] flex-col items-center justify-center border p-6 text-center">
      <CircleAlert aria-hidden="true" className="text-muted-foreground size-8" />
      <h2 className="mt-4 text-lg font-semibold">{`${label} is unavailable`}</h2>
      <p className="text-muted-foreground mt-2 max-w-md text-sm leading-6">{reason}</p>
      <Button type="button" variant="secondary" className="mt-4" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
