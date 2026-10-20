/// <reference lib="dom" />
/**
 * The contract between a host page and the UI module that a portal module serves through Core
 * (`/api/portal/<module>/ui/entry.js`, for example the billing module's). The host, a workspace portal
 * page, imports the module, checks `contractVersion`, and calls `mount` with a {@link PortalModuleContext}.
 * Types and one constant only, so the host and the module can both import it in the browser.
 *
 * Import it from `@mentra/workspace-contract/portal-module-ui`, not the package root: the contract names DOM
 * types, which server packages do not have.
 */

import type {ForwardedScope} from "./types"

/** The version of this contract. A host and a module that disagree on it must not be mounted together. */
export const PORTAL_MODULE_CONTRACT_VERSION = 1

/** What the host knows about the caller: a signed-in person, since the portal serves nobody else. */
export interface PortalModuleMe {
  authenticated: true
  user: {mentraUserId: string; email: string | null; emailVerified: boolean}
}

/**
 * What the page the module is mounted on covers: one workspace's, or the person's own account. It
 * names which of the module's two API roots to call (`<apiBase>/workspaces/<workspaceId>/...` or
 * `<apiBase>/account/...`). Core decides what a request may do from the session, never from this value.
 */
export type PortalModuleScope = Extract<ForwardedScope, {kind: "workspace" | "person"}>

/** Everything the host hands the module when it mounts. */
export interface PortalModuleContext {
  /** Where the module sends its API requests, e.g. `/api/portal/billing`. */
  apiBase: string
  me: PortalModuleMe
  scope: PortalModuleScope
  /** The host's route when the module mounts. Later changes reach the module as the {@link PortalModule.mount} doc says. */
  route: {path: string; query: string}
  /** Asks the host to go to `path`; with `replace`, the current history entry is replaced instead of a new one added. */
  navigate(path: string, opts?: {replace?: boolean}): void
  /** Tells the host the caller's session has ended (the API answered 401), so it can send them to sign in. */
  onSessionExpired(): void
}

/** What a portal module's UI entry exports. */
export interface PortalModule {
  contractVersion: number
  /**
   * Renders into `element`; the returned handle removes everything the module added.
   *
   * `ctx.route` is the route at mount. If the handle provides `setRoute`, the host calls it on every later
   * route change (including after the module's own `navigate` and Back/Forward) instead of remounting;
   * otherwise the host unmounts and mounts again.
   */
  mount(
    element: HTMLElement | ShadowRoot,
    ctx: PortalModuleContext,
  ): {unmount(): void; setRoute?(route: {path: string; query: string}): void}
}
