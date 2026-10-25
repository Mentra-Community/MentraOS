/**
 * @fileoverview Which portal modules are installed on this Core and how to reach them.
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
 * An installed module is for every signed-in person, on every Core, alike. What a person may do inside it is the
 * module's own decision, through Core's `/authorize`; a workspace path needs a member of that workspace or an
 * Organization Admin, which the API checks.
 *
 * Public reads. A module's `publicReads` are for anyone, signed in or not, on every Core: what it says there is
 * marketing content (billing: a product's name, for the sign-in page). Each names a family of
 * `GET public/<family>/<key>`, with exactly one key after it of 1 to 100 lowercase letters, digits, `.`, `_` and
 * `-`, not only dots, matched as received (billing: `products`). `HEAD` and every other method, another case, an
 * encoding, a dot segment, a trailing slash or a deeper path are not one, and `portalModulePublicAccess` answers
 * `hidden` for them. Core forwards a public read with the `public` principal, which names no person, so it opens
 * nothing under a workspace or `ui/`.
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

interface PortalModuleSettings {
  urlVariable: string
  secretVariable: string
  /** The families under `public/` whose `GET public/<family>/<key>` anyone may make, signed in or not. */
  publicReads: readonly string[]
}

const REGISTRY: Record<PortalModuleName, PortalModuleSettings> = {
  billing: {
    urlVariable: "CLOUD_CORE_BILLING_URL",
    secretVariable: "CLOUD_CORE_BILLING_SECRET",
    publicReads: ["products"],
  },
}

/** The one key after a public read's family: lowercase letters, digits, `.`, `_` and `-`, 1 to 100 of them. */
const PUBLIC_READ_KEY = /^[a-z0-9._-]{1,100}$/
/** A key of dots alone is a dot segment (`.`, `..`) or looks like one, and is no key. */
const ONLY_DOTS = /^\.+$/

/**
 * A request under a module's `public/`, as far as whether it is a public read is concerned: its method and the
 * rest of its path after `public/`, exactly as received (not decoded, no leading "/", no query):
 * `products/mentra.call.unlimited` for `/public/products/mentra.call.unlimited`.
 */
export interface PortalModulePublicRequest {
  method: string
  rest: string
}

/** Whether `request` is one of the reads `name` leaves open to anyone (see the file header). Exact, so anything unlisted is not. */
function isPublicRead(name: PortalModuleName, request: PortalModulePublicRequest): boolean {
  if (request.method !== "GET") return false
  const segments = request.rest.split("/")
  if (segments.length !== 2) return false
  const [family, key] = segments as [string, string]
  return REGISTRY[name].publicReads.includes(family) && PUBLIC_READ_KEY.test(key) && !ONLY_DOTS.test(key)
}

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
 * What a signed-in person can reach of module `name` on this Core, decided once for everything that asks (the
 * routes, the request-body limit before them, and `/me`), so they cannot drift. It is the same for every person:
 *  - `hidden`: the module is not installed. Core answers as if it did not exist;
 *  - `unavailable`: it is installed, but its settings are unusable;
 *  - `ready`: Core may forward, to `baseUrl`, signing with `secret`.
 */
export type PortalModuleAccess =
  | {state: "hidden"}
  | {state: "unavailable"}
  | {state: "ready"; baseUrl: URL; secret: string}

export function portalModuleAccess(
  name: PortalModuleName,
  env: NodeJS.ProcessEnv = processEnvironment(),
  log: ConfigLog = logger,
): PortalModuleAccess {
  const config = portalModuleConfig(name, env, log)
  if (config.state === "not_installed") return {state: "hidden"}
  if (config.state === "misconfigured") return {state: "unavailable"}
  return {state: "ready", baseUrl: config.baseUrl, secret: config.secret}
}

/**
 * What anyone, signed in or not, can reach of module `name` with `request`, a request under its `public/`, on
 * every Core:
 *  - `hidden`: the module is not installed, or the request is not one of its public reads (see the file header);
 *  - `unavailable`: it is a public read, but the module's settings are unusable;
 *  - `ready`: Core may forward, to `baseUrl`, signing with `secret`.
 */
export function portalModulePublicAccess(
  name: PortalModuleName,
  request: PortalModulePublicRequest,
  env: NodeJS.ProcessEnv = processEnvironment(),
  log: ConfigLog = logger,
): PortalModuleAccess {
  const config = portalModuleConfig(name, env, log)
  if (config.state === "not_installed" || !isPublicRead(name, request)) return {state: "hidden"}
  if (config.state === "misconfigured") return {state: "unavailable"}
  return {state: "ready", baseUrl: config.baseUrl, secret: config.secret}
}

/** What `/me` says the portal can offer. */
export interface PortalModuleAvailability {
  /** Billing is installed and usable: its pages, its catalog and everything it does are offered. */
  billing: boolean
}

/** For each module, whether the portal should offer it: the module is installed and usable on this Core. */
export function portalModuleAvailability(
  env: NodeJS.ProcessEnv = processEnvironment(),
  log: ConfigLog = logger,
): PortalModuleAvailability {
  return {billing: portalModuleAccess("billing", env, log).state === "ready"}
}
