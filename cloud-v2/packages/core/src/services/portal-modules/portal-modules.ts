/**
 * @fileoverview Which portal modules are installed on this Core, how to reach them, and who may see them.
 *
 * A portal module is a separately deployed service that brings its own API and its own UI to the workspace
 * portal: Core authenticates the person, decides what the request covers, signs a statement of that and
 * forwards it (`api/portal/portal-modules.api.ts`), and the portal mounts the module's UI bundle. The
 * modules are a fixed registry, one entry per module, each with the two settings that install it:
 *
 *  - `billing`: `CLOUD_CORE_BILLING_URL`, the module's base URL with an optional path prefix, and
 *    `CLOUD_CORE_BILLING_SECRET`, the shared secret that signs what Core sends. It is the Mentra Miniapp
 *    Store's billing module and exists on the hosted Core only.
 *
 * The URL rules and the three states are Fleet's (`services/fleet/fleet-config.ts`), per module:
 *  - `not_installed`: no URL. A secret without a URL is inert;
 *  - `misconfigured`: the URL is set but unusable (`parseUpstreamUrl`: `https` anywhere, plain `http` on a
 *    local or test Core for any host and on a deployed Core only for `localhost` and `127.0.0.1`, no
 *    credentials, query or fragment), or the secret is missing. The reason names the variable and never
 *    carries a value;
 *  - `ready`: Core may forward.
 *
 * Everything is read from the environment on each call, so a changed setting takes effect on the next request
 * and tests can pass their own. A problem is logged once per process, naming the variable and never its value.
 *
 * Staff-only (billing). Billing sells with a test key on every Core but the production one, so there it is
 * visible only to staff: an Organization Admin, as `isOrganizationAdminEmail` decides from
 * `CLOUD_CORE_ADMIN_EMAILS` and `CLOUD_CORE_ADMIN_EMAIL_DOMAINS` and the forwarded principal carries as
 * `isOrganizationAdmin`. Billing is visible to everyone only when `CLOUD_CORE_ENVIRONMENT` is exactly `prod`,
 * the value the production release contract requires. Anything else (`dev`, `staging`, `production`, a
 * misspelling, nothing at all) is staff-only: a Core that is not known to be production never shows a test-mode
 * checkout to the public.
 *
 * Open reads. Staff-only is for what a person can do with billing, not for what it sells: a member of a
 * workspace who is not staff still sees what a license is, so the Members list can name the licenses people
 * hold. A module's `openReads` name the few requests that stay open to everyone who may reach the module's
 * scope, however staff-only it is, and `portalModuleAccess` answers `ready` for exactly those and nothing else:
 *  - `scopePaths`: `GET` of `/workspaces/<id>/<path>` and of `/account/<path>`, the path matched exactly as
 *    received (billing: `catalog`). `HEAD` and every other method, a trailing slash, another case, an encoded
 *    letter or a deeper path are not it;
 *  - `assetPrefixes`: `GET` and `HEAD` of `/ui/<prefix><file>`, with one file name after the prefix (billing:
 *    `icons/`). The rest of `ui/`, a module's `entry.js` above all, is not open.
 * The scope is untouched: a workspace path still needs a member or an Organization Admin, which the API checks
 * after this, and a person who may not see the module at all gets what an absent one gives for anything else.
 * An open read of a module that is not installed is as hidden as any other, and one of a module whose settings
 * are unusable is `unavailable`.
 */

import {createLogger, type Logger} from "@mentra/cloud-shared"
import {isDeployedEnvironment} from "../signin/config"
import {parseUpstreamUrl} from "../forwarding/upstream-url"

/** Where a misconfiguration is reported. Core's logger unless a caller (a test) passes its own. */
export type ConfigLog = Pick<Logger, "error">

const logger: ConfigLog = createLogger("core").child({service: "portal-modules"})

/** The portal modules Core knows. */
export const PORTAL_MODULE_NAMES = ["billing"] as const
export type PortalModuleName = (typeof PORTAL_MODULE_NAMES)[number]

/** The requests a staff-only module still answers to everyone who reaches it (see the file header). */
interface OpenReads {
  /** Paths under a scope (`/workspaces/<id>/<path>`, `/account/<path>`) whose `GET` is open, matched exactly as received. */
  scopePaths: readonly string[]
  /** Prefixes under `ui/` whose `GET` and `HEAD` are open, for one file name after the prefix. */
  assetPrefixes: readonly string[]
}

interface PortalModuleSettings {
  urlVariable: string
  secretVariable: string
  /** Visible to Organization Admins only, unless `CLOUD_CORE_ENVIRONMENT` is `prod`. */
  staffOnlyUnlessProd: boolean
  /** What a person the module is hidden from may still read. */
  openReads: OpenReads
}

const REGISTRY: Record<PortalModuleName, PortalModuleSettings> = {
  billing: {
    urlVariable: "CLOUD_CORE_BILLING_URL",
    secretVariable: "CLOUD_CORE_BILLING_SECRET",
    staffOnlyUnlessProd: true,
    openReads: {scopePaths: ["catalog"], assetPrefixes: ["icons/"]},
  },
}

/**
 * A request to a module, as far as who may make it is concerned: its method, the family of path it is for and
 * the rest of the path after that family's scope, exactly as received (not decoded, no leading "/", no query):
 * `catalog` for `/workspaces/ws_1/catalog` and for `/account/catalog`, `icons/a.png` for `/ui/icons/a.png`.
 */
export interface PortalModuleRequest {
  method: string
  route: {kind: "workspace" | "account" | "ui"}
  rest: string
}

/** One file name: the characters an icon's file may have, and not only dots. It is the contract's rule for an icon. */
const OPEN_ASSET_FILE = /^(?!\.+$)[A-Za-z0-9._-]{1,255}$/

/** Whether `request` is one of the reads `name` leaves open to everyone (see the file header). Exact, so anything unlisted is not. */
function isOpenRead(name: PortalModuleName, request: PortalModuleRequest): boolean {
  const {scopePaths, assetPrefixes} = REGISTRY[name].openReads
  const {method, route, rest} = request
  if (route.kind === "ui") {
    if (method !== "GET" && method !== "HEAD") return false
    return assetPrefixes.some(prefix => rest.startsWith(prefix) && OPEN_ASSET_FILE.test(rest.slice(prefix.length)))
  }
  return method === "GET" && scopePaths.includes(rest)
}

/** The value of `CLOUD_CORE_ENVIRONMENT` that makes a Core the production one. */
const PRODUCTION_ENVIRONMENT = "prod"

export type PortalModuleConfig =
  | {state: "not_installed"}
  | {state: "misconfigured"; reason: string}
  | {state: "ready"; baseUrl: URL; secret: string}

/**
 * The settings this module reads, taken from the process now. Each variable is read as a literal
 * `process.env` property so the production config contract check
 * (`.github/scripts/validate-production-cloud-config.mjs`) sees it.
 */
function processEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    CLOUD_CORE_ENVIRONMENT: process.env.CLOUD_CORE_ENVIRONMENT,
    CLOUD_CORE_BILLING_URL: process.env.CLOUD_CORE_BILLING_URL,
    CLOUD_CORE_BILLING_SECRET: process.env.CLOUD_CORE_BILLING_SECRET,
  }
}

/**
 * A problem is logged once per logger and distinct message, so a request path that asks again stays quiet.
 * Keyed by logger, a test that passes its own sees each problem once and Core's logger is not used up by it.
 */
const reported = new WeakMap<ConfigLog, Set<string>>()

function reportOnce(log: ConfigLog, variable: string, message: string): void {
  const key = `${variable}:${message}`
  const seen = reported.get(log) ?? new Set<string>()
  reported.set(log, seen)
  if (seen.has(key)) return
  seen.add(key)
  log.error({variable}, message)
}

/** Whether `name` is installed on this Core, and when it is, whether Core can reach it. */
export function portalModuleConfig(
  name: PortalModuleName,
  env: NodeJS.ProcessEnv = processEnvironment(),
  log: ConfigLog = logger,
): PortalModuleConfig {
  const {urlVariable, secretVariable} = REGISTRY[name]
  const rawUrl = (env[urlVariable] ?? "").trim()
  // The URL decides whether the module is installed; a secret without one is inert.
  if (!rawUrl) return {state: "not_installed"}

  const problems: string[] = []
  const baseUrl = parseUpstreamUrl(rawUrl, isDeployedEnvironment(env))
  if (!baseUrl) {
    const message = `${urlVariable} is not a usable module URL (an http(s) URL without credentials, query or fragment; a deployed Core requires https except on localhost)`
    problems.push(message)
    reportOnce(log, urlVariable, `${message}; refusing ${name} requests`)
  }
  const secret = env[secretVariable] ?? ""
  if (!secret.trim()) {
    const message = `${secretVariable} is required when ${urlVariable} is set`
    problems.push(message)
    reportOnce(log, secretVariable, `${message}; refusing ${name} requests`)
  }
  if (!baseUrl || problems.length > 0) return {state: "misconfigured", reason: problems.join("; ")}
  return {state: "ready", baseUrl, secret}
}

/** The modules that are installed and usable on this Core. A broken install is not offered: the portal could not load its page. */
export function installedPortalModules(
  env: NodeJS.ProcessEnv = processEnvironment(),
  log: ConfigLog = logger,
): PortalModuleName[] {
  return PORTAL_MODULE_NAMES.filter(name => portalModuleConfig(name, env, log).state === "ready")
}

/**
 * Whether `name` may be shown to this person. False only when the module is staff-only on this Core (see the
 * file header) and the person is no Organization Admin. It says nothing of whether the module is installed.
 */
export function portalModuleVisibleTo(
  name: PortalModuleName,
  principal: {isOrganizationAdmin: boolean},
  env: NodeJS.ProcessEnv = processEnvironment(),
): boolean {
  if (!REGISTRY[name].staffOnlyUnlessProd) return true
  return env.CLOUD_CORE_ENVIRONMENT === PRODUCTION_ENVIRONMENT || principal.isOrganizationAdmin
}

/**
 * What a person can reach of module `name` on this Core, decided once for everything that asks (the routes, the
 * request-body limit before them, and `/me`), so they cannot drift:
 *  - `hidden`: the module is not installed, or is not visible to this person (see the file header) and the
 *    request is not an open read. It is indistinguishable from an absent one, a broken install included;
 *  - `unavailable`: it is visible to them, or the request is an open read, but its settings are unusable;
 *  - `ready`: Core may forward, to `baseUrl`, signing with `secret`.
 *
 * `request` is what is being asked. Without one, only what the person may see of the module as a whole counts,
 * so an open read is `hidden` from someone it is hidden from, unless the request says it is one.
 */
export type PortalModuleAccess =
  | {state: "hidden"}
  | {state: "unavailable"}
  | {state: "ready"; baseUrl: URL; secret: string}

export function portalModuleAccess(
  name: PortalModuleName,
  principal: {isOrganizationAdmin: boolean},
  env: NodeJS.ProcessEnv = processEnvironment(),
  log: ConfigLog = logger,
  request?: PortalModuleRequest,
): PortalModuleAccess {
  const config = portalModuleConfig(name, env, log)
  if (config.state === "not_installed") return {state: "hidden"}
  if (!portalModuleVisibleTo(name, principal, env) && !(request && isOpenRead(name, request))) return {state: "hidden"}
  if (config.state === "misconfigured") return {state: "unavailable"}
  return {state: "ready", baseUrl: config.baseUrl, secret: config.secret}
}

/** What `/me` says the portal can offer this person. */
export interface PortalModuleAvailability {
  /** Billing is installed and usable, and visible to this person: its pages, and everything it does, are theirs. */
  billing: boolean
  /** Billing's catalog can be read: installed and usable, whoever asks, because the catalog is an open read. */
  billingCatalog: boolean
}

/** The request `billingCatalog` stands for: a catalog is read the same way under either scope. */
const CATALOG_READ: PortalModuleRequest = {method: "GET", route: {kind: "account"}, rest: "catalog"}

/**
 * For each question the portal asks, whether it should offer it to this person: the module is installed and
 * usable, and visible to them (`billing`), or at least its catalog, an open read, can be reached
 * (`billingCatalog`).
 */
export function portalModuleAvailability(
  principal: {isOrganizationAdmin: boolean},
  env: NodeJS.ProcessEnv = processEnvironment(),
  log: ConfigLog = logger,
): PortalModuleAvailability {
  return {
    billing: portalModuleAccess("billing", principal, env, log).state === "ready",
    billingCatalog: portalModuleAccess("billing", principal, env, log, CATALOG_READ).state === "ready",
  }
}
