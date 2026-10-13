import {
  FLEET_UI_CONTRACT_VERSION,
  type FleetUiContext,
  type FleetUiMe,
  type FleetUiModule,
} from "@mentra/workspace-contract/fleet-ui";
import { AlertCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LoadingIndicator } from "../components/loading-indicator";
import { Button } from "../components/ui/button";
import type { AdminMe } from "../lib/admin-access";

/**
 * The Fleet page: a host for the Fleet UI module that the Fleet integration serves through Core.
 *
 * The page imports the module from this origin (`/api/admin/fleet/ui/entry.js`, so the portal's
 * `script-src 'self'` allows it), checks that it speaks this page's contract version, and mounts it into an
 * open shadow root, which keeps the module's styles and the portal's apart. The module calls Fleet through
 * `apiBase`, with the portal's session cookie.
 *
 * The page owns the route. It lives in `?fleet=<path>` (see {@link readFleetPath}), so a Fleet screen has a
 * link and Back and Forward work. `mount` is the module's only way in, so the module is told the route once,
 * when it mounts: a different route (the module calling `navigate`, or Back and Forward) unmounts it and mounts
 * it again in the same shadow root.
 */

/** Where Fleet's API is, as the module is told it. Core forwards it to Fleet for Organization Admins. */
export const FLEET_API_BASE = "/api/admin/fleet";

/** The module's entry, served by Core from the Fleet integration. Same origin, never a client-chosen URL. */
export const FLEET_MODULE_URL = "/api/admin/fleet/ui/entry.js";

/** The longest route kept in the address. Nothing Fleet shows needs more; a longer one is taken for junk. */
const MAX_FLEET_PATH_LENGTH = 2048;

/** The address bar parameter that holds the Fleet route. */
const FLEET_PARAM = "fleet";

/**
 * A route as a path from the root, query included (`/devices?tab=phones`). It is only ever handed back to the
 * module, never followed as a URL, but it is held to a plain path anyway: leading slashes collapse to one,
 * and a control character or an excessive length gives the overview.
 */
export function normalizeFleetPath(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (value.length > MAX_FLEET_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return "/";
  return `/${value.replace(/^\/+/, "")}`;
}

/** The Fleet route in an address's query string, or null when the address names no Fleet route. A blank one is the overview. */
export function readFleetPath(search: string): string | null {
  const value = new URLSearchParams(search).get(FLEET_PARAM);
  return value === null ? null : normalizeFleetPath(value);
}

/** The route as the contract gives it to a module: the path, and the query with its `?` (or ""). */
export function fleetRoute(fleetPath: string): FleetUiContext["route"] {
  const path = normalizeFleetPath(fleetPath);
  const queryStart = path.indexOf("?");
  if (queryStart === -1) return { path, query: "" };
  const query = path.slice(queryStart);
  return { path: path.slice(0, queryStart) || "/", query: query === "?" ? "" : query };
}

/** The address (path, query and hash) that holds `fleetPath`, with the rest of `href` kept. */
export function fleetLocation(href: string, fleetPath: string): string {
  const url = new URL(href);
  url.searchParams.set(FLEET_PARAM, normalizeFleetPath(fleetPath));
  return `${url.pathname}${url.search}${url.hash}`;
}

/** What the module is told about the caller: the contract's fields, and nothing else the portal knows. */
export function fleetUiMe(me: AdminMe): FleetUiMe {
  return {
    authenticated: true,
    user: me.user ? { mentraUserId: me.user.mentraUserId, email: me.user.email } : null,
    organization: { capabilities: [...me.organization.capabilities] },
    fleet: { installed: me.fleet?.installed === true },
  };
}

/** Fleet cannot be shown: the module is missing, down, unreadable or for another contract version. */
export class FleetUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FleetUnavailableError";
  }
}

/** Imports an ES module by URL. Tests supply their own. */
export type FleetEntryImporter = (specifier: string) => Promise<unknown>;

/**
 * The real import. The URL arrives as a parameter, not a literal, so the bundler cannot resolve it and leaves
 * `import()` for the browser to run against Core. (A `const` URL would be inlined and then fail to resolve;
 * build.ts also marks `/api/*` external, whatever the bundler does.) `new Function` would hide it too, but
 * it needs `unsafe-eval`, which the portal's CSP does not give.
 */
export const importFleetEntry: FleetEntryImporter = specifier => import(specifier);

/**
 * The entry's URL. A retry adds a token that no earlier attempt used. The browser keeps the result of an
 * import by URL (a loaded module in every browser, a failed one in some), so without it Retry would be answered
 * from that memory and could never pick up a Fleet that has come back or been upgraded.
 */
function fleetModuleUrl(retry: number | undefined): string {
  return retry === undefined ? FLEET_MODULE_URL : `${FLEET_MODULE_URL}?retry=${retry}`;
}

/**
 * Imports the Fleet module and checks it: a failed import (the 404 and 503 Core answers while Fleet is not
 * installed or cannot answer), an entry without a module as its default export, and a module built for another
 * contract version all give {@link FleetUnavailableError}.
 */
export async function loadFleetModule(importEntry: FleetEntryImporter = importFleetEntry, retry?: number): Promise<FleetUiModule> {
  let entry: unknown;
  try {
    entry = await importEntry(fleetModuleUrl(retry));
  } catch (cause) {
    throw new FleetUnavailableError("The Fleet module could not be loaded.", { cause });
  }
  const candidate = (typeof entry === "object" && entry !== null ? (entry as { default?: unknown }).default : undefined) as
    | Partial<FleetUiModule>
    | null
    | undefined;
  if (typeof candidate !== "object" || candidate === null || typeof candidate.contractVersion !== "number" || typeof candidate.mount !== "function") {
    throw new FleetUnavailableError("The Fleet module is not one this portal can run.");
  }
  if (candidate.contractVersion !== FLEET_UI_CONTRACT_VERSION) {
    throw new FleetUnavailableError(
      `The Fleet module uses version ${candidate.contractVersion} of the Fleet interface and this portal uses version ${FLEET_UI_CONTRACT_VERSION}.`,
    );
  }
  return candidate as FleetUiModule;
}

export interface FleetPageProps {
  me: AdminMe;
  /** The Fleet route, from `?fleet=`. A change unmounts the module and mounts it again for the new route. */
  path: string;
  /** The module asked to go to `path` (a clean route). The caller records it in history and passes the new `path` back. */
  onNavigate(path: string, opts?: { replace?: boolean }): void;
  /** Fleet answered 401: the caller's session has ended. */
  onSessionExpired(): void;
  /** Imports the module. Tests only. */
  importEntry?: FleetEntryImporter;
}

type Phase = { status: "loading" } | { status: "ready" } | { status: "unavailable"; reason: string };

function reasonFor(error: unknown): string {
  return error instanceof FleetUnavailableError ? error.message : "Fleet could not start.";
}

export function FleetPage({ me, path, onNavigate, onSessionExpired, importEntry = importFleetEntry }: FleetPageProps) {
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  // Set by Retry. It only changes the URL the module is imported from.
  const [retry, setRetry] = useState<number | undefined>(undefined);
  // The module keeps the context it was mounted with for as long as it runs, so a re-render of this page must
  // not remount it just to hand it newer handlers: it reaches the latest ones through here.
  const latest = useRef({ me, onNavigate, onSessionExpired });
  useEffect(() => {
    latest.current = { me, onNavigate, onSessionExpired };
  });

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    // False once this effect has ended (another route, a retry, the page left): then nothing it started may
    // touch the page.
    let live = true;
    let mounted: { unmount(): void } | null = null;
    // A module that is already showing stays on screen while it is mounted again for another route.
    setPhase(current => (current.status === "ready" ? current : { status: "loading" }));

    loadFleetModule(importEntry, retry).then(
      module => {
        if (!live) return;
        let shadow: ShadowRoot | null = null;
        try {
          // attachShadow throws on an element that has one, so a shadow root from an earlier mount is reused.
          shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
          const context: FleetUiContext = {
            contractVersion: FLEET_UI_CONTRACT_VERSION,
            apiBase: FLEET_API_BASE,
            me: fleetUiMe(latest.current.me),
            route: fleetRoute(path),
            navigate: (to, opts) => {
              // Only the module on screen may move the page.
              if (live) latest.current.onNavigate(normalizeFleetPath(to), opts);
            },
            // The session is the caller's, not this route's, so a 401 that lands late is still true.
            onSessionExpired: () => latest.current.onSessionExpired(),
          };
          mounted = module.mount(shadow, context);
          setPhase({ status: "ready" });
        } catch (error) {
          console.error("The Fleet module failed to mount.", error);
          shadow?.replaceChildren();
          setPhase({ status: "unavailable", reason: "Fleet could not start." });
        }
      },
      error => {
        if (live) setPhase({ status: "unavailable", reason: reasonFor(error) });
      },
    );

    return () => {
      live = false;
      const handle = mounted;
      mounted = null;
      try {
        handle?.unmount();
      } catch (error) {
        console.error("The Fleet module failed to unmount.", error);
      }
      // The shadow root stays with the element for the next mount; whatever the module left in it does not.
      element.shadowRoot?.replaceChildren();
    };
  }, [path, retry, importEntry]);

  return (
    <section aria-label="Fleet">
      {phase.status === "loading" ? <LoadingIndicator label="Loading Fleet" /> : null}
      {phase.status === "unavailable" ? <FleetUnavailable reason={phase.reason} onRetry={() => setRetry(Date.now())} /> : null}
      <div ref={host} hidden={phase.status === "unavailable"} />
    </section>
  );
}

export function FleetUnavailable({ reason, onRetry }: { reason: string; onRetry(): void }) {
  return (
    <div
      role="alert"
      className="flex min-h-[190px] flex-col items-center justify-center rounded-[24px] border border-[#e0e4de] bg-white p-6 text-center shadow-[0_1px_2px_rgba(20,21,27,0.06)]"
    >
      <AlertCircle aria-hidden="true" className="size-8 text-[#879088]" />
      <h2 className="mt-4 text-lg font-bold">Fleet is unavailable</h2>
      <p className="mt-2 max-w-md text-sm leading-6 text-[#68746d]">{reason}</p>
      <Button type="button" variant="secondary" className="mt-4" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
