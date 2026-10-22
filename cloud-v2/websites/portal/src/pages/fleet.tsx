/**
 * Fleet Management in the workspace portal: `/w/<workspaceId>/fleet?fleet=<path>`.
 *
 * A host for the Fleet UI module that the Fleet integration serves through Core
 * (`/api/portal/fleet/ui/entry.js`, same origin, so the portal's `script-src 'self'` allows it). The page
 * checks that the module speaks this page's contract version, mounts it into an open shadow root, and tells it
 * the route (the `?fleet=` query). The module's API base is this one workspace, so Core takes the workspace from
 * the path and never from the module. The module is imported once; a route change reaches it through
 * `setRoute`, or remounts it, and leaving the page unmounts it.
 *
 * `me` is read for this workspace (`/api/portal/me?workspaceId=`), so for an Organization Admin who is not a
 * member it names exactly this workspace, with an Owner's capabilities.
 */

import {
  FLEET_UI_CONTRACT_VERSION,
  type FleetUiContext,
  type FleetUiMe,
  type FleetUiModule,
} from "@mentra/workspace-contract/fleet-ui";
import { useQuery } from "@tanstack/react-query";
import { Button, Spinner } from "@mentra/workspace-ui";
import { AlertCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { fetchPortalMe, PortalApiError, type PortalMe } from "@/lib/api";
import { navigate, useSearch } from "@/lib/navigation";
import { usePortal } from "@/lib/portal";
import { fleetPath } from "@/lib/routes";

/** The module's entry, served by Core from the Fleet integration. Same origin, never a client-chosen URL. */
export const FLEET_MODULE_URL = "/api/portal/fleet/ui/entry.js";

/** Where the module sends its API requests: Core forwards it to Fleet scoped to this workspace. */
export function fleetApiBase(workspaceId: string): string {
  return `/api/portal/fleet/workspaces/${encodeURIComponent(workspaceId)}`;
}

/** The longest route kept in the address. Nothing Fleet shows needs more; a longer one is taken for junk. */
const MAX_FLEET_PATH_LENGTH = 2048;
const FLEET_PARAM = "fleet";

/** A route as a path from the root, query included. A control character or an excessive length gives the overview. */
export function normalizeFleetPath(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (value.length > MAX_FLEET_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return "/";
  return `/${value.replace(/^\/+/, "")}`;
}

/** The Fleet route in an address's query string. A missing or blank one is the overview. */
export function readFleetPath(search: string): string {
  return normalizeFleetPath(new URLSearchParams(search).get(FLEET_PARAM) ?? "");
}

/** The route as the contract gives it to a module: the path, and the query with its `?` (or ""). */
export function fleetRoute(fleetRoutePath: string): FleetUiContext["route"] {
  const path = normalizeFleetPath(fleetRoutePath);
  const queryStart = path.indexOf("?");
  if (queryStart === -1) return { path, query: "" };
  const query = path.slice(queryStart);
  return { path: path.slice(0, queryStart) || "/", query: query === "?" ? "" : query };
}

/** The portal address that holds the module's route `to` for this workspace. */
export function fleetLocation(workspaceId: string, to: string): string {
  const base = fleetPath(workspaceId).split("?")[0];
  return `${base}?${FLEET_PARAM}=${encodeURIComponent(normalizeFleetPath(to).replace(/^\//, ""))}`.replace(/%2F/g, "/");
}

/** What the module is told about the caller: the contract's fields, and nothing else the portal knows. */
export function fleetUiMe(me: PortalMe): FleetUiMe {
  return {
    authenticated: true,
    user: { mentraUserId: me.user.mentraUserId ?? me.user.id, email: me.user.email },
    organization: { capabilities: [...(me.organization?.capabilities ?? [])] },
    workspaces: (me.workspaces ?? []).map(workspace => ({ ...workspace, capabilities: [...workspace.capabilities] })),
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

/** The real import. The URL is a parameter so the bundler leaves `import()` to the browser. */
export const importFleetEntry: FleetEntryImporter = specifier => import(specifier);

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

type Phase = { status: "loading" } | { status: "ready" } | { status: "unavailable"; reason: string };
const LOADING: Phase = { status: "loading" };
const READY: Phase = { status: "ready" };

interface FleetHostInputs {
  me: PortalMe;
  onNavigate(path: string, opts?: { replace?: boolean }): void;
  onSessionExpired(): void;
}

interface FleetHost {
  start(): void;
  setPath(path: string): void;
  retry(): void;
  dispose(): void;
}

/**
 * Everything the page does with the module, outside React: import it, mount it, tell it the route, unmount it.
 * One host serves one open Fleet page. After `dispose` nothing it started touches the page.
 */
export function createFleetHost(options: {
  element: HTMLElement;
  workspaceId: string;
  importEntry: FleetEntryImporter;
  path: string;
  inputs(): FleetHostInputs;
  onPhase(phase: Phase): void;
}): FleetHost {
  const { element, workspaceId, importEntry, inputs, onPhase } = options;
  let live = true;
  let path = options.path;
  let loaded: FleetUiModule | null = null;
  let loading = false;
  let mounted: ReturnType<FleetUiModule["mount"]> | null = null;
  let active = 0;
  let mounts = 0;

  function mountLoaded(module: FleetUiModule): void {
    const id = ++mounts;
    active = id;
    let shadow: ShadowRoot | null = null;
    try {
      shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
      const context: FleetUiContext = {
        contractVersion: FLEET_UI_CONTRACT_VERSION,
        apiBase: fleetApiBase(workspaceId),
        me: fleetUiMe(inputs().me),
        route: fleetRoute(path),
        navigate: (to, opts) => {
          // Only the module on screen may move the page.
          if (live && active === id) inputs().onNavigate(normalizeFleetPath(to), opts);
        },
        onSessionExpired: () => inputs().onSessionExpired(),
      };
      mounted = module.mount(shadow, context);
      onPhase(READY);
    } catch (error) {
      console.error("The Fleet module failed to mount.", error);
      active = 0;
      shadow?.replaceChildren();
      onPhase({ status: "unavailable", reason: "Fleet could not start." });
    }
  }

  function unmountMounted(): void {
    active = 0;
    const handle = mounted;
    mounted = null;
    try {
      handle?.unmount();
    } catch (error) {
      console.error("The Fleet module failed to unmount.", error);
    }
    element.shadowRoot?.replaceChildren();
  }

  async function load(retry?: number): Promise<void> {
    loading = true;
    onPhase(LOADING);
    try {
      const module = await loadFleetModule(importEntry, retry);
      if (!live) return;
      loaded = module;
      mountLoaded(module);
    } catch (error) {
      if (live) {
        onPhase({
          status: "unavailable",
          reason: error instanceof FleetUnavailableError ? error.message : "Fleet could not start.",
        });
      }
    } finally {
      loading = false;
    }
  }

  return {
    start() {
      void load();
    },
    setPath(next) {
      if (next === path) return;
      path = next;
      const handle = mounted;
      if (!handle || !loaded) return;
      if (typeof handle.setRoute === "function") {
        try {
          handle.setRoute(fleetRoute(next));
          return;
        } catch (error) {
          console.error("The Fleet module failed to change route; mounting it again.", error);
        }
      }
      unmountMounted();
      mountLoaded(loaded);
    },
    retry() {
      if (!live || loading) return;
      if (loaded) {
        unmountMounted();
        mountLoaded(loaded);
      } else {
        void load(Date.now());
      }
    },
    dispose() {
      live = false;
      unmountMounted();
    },
  };
}

export interface FleetHostPageProps {
  workspaceId: string;
  me: PortalMe;
  /** The Fleet route, from `?fleet=`. */
  path: string;
  onNavigate(path: string, opts?: { replace?: boolean }): void;
  onSessionExpired(): void;
  /** Imports the module. Tests only. */
  importEntry?: FleetEntryImporter;
}

/** The host element and its Loading and unavailable states. Mounts the module once per workspace and importer. */
export function FleetHostPage({ workspaceId, me, path, onNavigate, onSessionExpired, importEntry = importFleetEntry }: FleetHostPageProps) {
  const element = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>(LOADING);
  const latest = useRef({ me, path, onNavigate, onSessionExpired });
  useEffect(() => {
    latest.current = { me, path, onNavigate, onSessionExpired };
  });
  const host = useRef<FleetHost | null>(null);

  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const created = createFleetHost({
      element: target,
      workspaceId,
      importEntry,
      path: latest.current.path,
      inputs: () => latest.current,
      onPhase: setPhase,
    });
    host.current = created;
    created.start();
    return () => {
      created.dispose();
      host.current = null;
    };
  }, [workspaceId, importEntry]);

  useEffect(() => {
    host.current?.setPath(path);
  }, [path]);

  return (
    <section aria-label="Fleet Management">
      {phase.status === "loading" ? (
        <div role="status" className="text-muted-foreground flex items-center gap-2.5 text-sm">
          <Spinner /> Loading Fleet
        </div>
      ) : null}
      {phase.status === "unavailable" ? <FleetUnavailable reason={phase.reason} onRetry={() => host.current?.retry()} /> : null}
      <div ref={element} hidden={phase.status === "unavailable"} />
    </section>
  );
}

export function FleetUnavailable({ reason, onRetry }: { reason: string; onRetry(): void }) {
  return (
    <div role="alert" className="rounded-notice bg-card flex min-h-[190px] flex-col items-center justify-center p-6 text-center">
      <AlertCircle aria-hidden="true" className="text-muted-foreground size-8" />
      <h2 className="mt-4 text-lg font-bold">Fleet is unavailable</h2>
      <p className="text-muted-foreground mt-2 max-w-md text-sm leading-6">{reason}</p>
      <Button type="button" variant="secondary" className="mt-4" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** Whether a failed read means the session ended (HTTP 401), as opposed to Fleet or Core being down. */
export function endsSession(error: unknown): boolean {
  return error instanceof PortalApiError && error.status === 401;
}

/** The session ended while Fleet was open: tell the portal, which signs the person out and offers sign-in. */
function SessionEnded({ onExpired }: { onExpired(): void }) {
  const told = useRef(false);
  useEffect(() => {
    if (told.current) return;
    told.current = true;
    onExpired();
  }, [onExpired]);
  return (
    <div role="status" className="text-muted-foreground flex items-center gap-2.5 text-sm">
      <Spinner /> Your session ended
    </div>
  );
}

/**
 * The Fleet section of one workspace. Reads `me` for this workspace and hosts the module; a 401 from that read
 * means the session ended. The module's own navigation becomes `?fleet=` in the address.
 */
export function FleetScreen({ workspaceId }: { workspaceId: string }) {
  const portal = usePortal();
  const search = useSearch();
  const me = useQuery({
    queryKey: ["portal-me", "fleet", workspaceId],
    queryFn: () => fetchPortalMe(workspaceId),
    retry: false,
  });
  if (me.isPending) {
    return (
      <div role="status" className="text-muted-foreground flex items-center gap-2.5 text-sm">
        <Spinner /> Loading Fleet
      </div>
    );
  }
  if (me.isError && endsSession(me.error)) {
    return <SessionEnded onExpired={portal.sessionExpired} />;
  }
  if (me.isError || !me.data) {
    return <FleetUnavailable reason="Fleet could not be reached." onRetry={() => void me.refetch()} />;
  }
  return (
    <FleetHostPage
      workspaceId={workspaceId}
      me={me.data}
      path={readFleetPath(search)}
      onNavigate={(to, opts) => navigate(fleetLocation(workspaceId, to), opts)}
      onSessionExpired={portal.sessionExpired}
    />
  );
}
