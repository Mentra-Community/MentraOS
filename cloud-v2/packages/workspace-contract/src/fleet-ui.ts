/// <reference lib="dom" />
/**
 * The contract between a host page and the Fleet UI module that the Fleet integration serves
 * (`/api/admin/fleet/ui/entry.js`). The host, an admin portal page, imports the module, checks
 * `contractVersion`, and calls `mount` with a {@link FleetUiContext}. Types and one constant only,
 * so the host and the module can both import it in the browser.
 *
 * Import it from `@mentra/workspace-contract/fleet-ui`, not the package root: the contract names DOM
 * types, which server packages do not have.
 */

/** The version of this contract. A host and a module that disagree on it must not be mounted together. */
export const FLEET_UI_CONTRACT_VERSION = 1

/** What the host knows about the caller. */
export interface FleetUiMe {
  authenticated: true
  /** The signed-in Mentra user, or null when the caller is not signed in as one. */
  user: {mentraUserId: string; email: string | null} | null
  organization: {capabilities: string[]}
  /**
   * The workspaces the caller may use Fleet Management in, each with the caller's capabilities there. A person
   * belongs to at most one workspace, so this has at most one entry, except for an Organization Admin: on the
   * workspace portal it names exactly the workspace the page is open on, whether or not they are a member.
   * Optional for a host that predates it (the admin portal's organization view).
   */
  workspaces?: Array<{workspaceId: string; name: string; capabilities: string[]}>
  fleet: {installed: boolean}
}

/** Everything the host hands the module when it mounts. */
export interface FleetUiContext {
  contractVersion: 1
  /** Where the module sends its API requests, e.g. `/api/admin/fleet`. */
  apiBase: string
  me: FleetUiMe
  /** The host's route when the module mounts. Later changes reach the module as the {@link FleetUiModule.mount} doc says. */
  route: {path: string; query: string}
  /** Asks the host to go to `path`; with `replace`, the current history entry is replaced instead of a new one added. */
  navigate(path: string, opts?: {replace?: boolean}): void
  /** Tells the host the caller's session has ended (the API answered 401), so it can send them to sign in. */
  onSessionExpired(): void
}

/** What the Fleet UI entry exports. */
export interface FleetUiModule {
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
    ctx: FleetUiContext,
  ): {unmount(): void; setRoute?(route: {path: string; query: string}): void}
}
