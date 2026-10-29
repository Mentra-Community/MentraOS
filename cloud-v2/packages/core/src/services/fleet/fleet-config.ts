/**
 * @fileoverview Whether the optional Fleet integration is installed on this Core, and how to reach it.
 *
 * Fleet is a separately deployed service (MFM). Core stores none of its data: it forwards to Fleet
 * only when Fleet is installed, and the Mentra App sends Fleet nothing until Core says so. This
 * module is the one place that decides, from the environment:
 *
 *  - `CLOUD_CORE_FLEET_URL`: Fleet's base URL, with an optional path prefix. Unset or blank means
 *    Fleet is not installed. `https` is accepted everywhere. Plain `http` is accepted on a local or
 *    test Core for any host, and on a deployed Core (`isDeployedEnvironment()`: `NODE_ENV=production`
 *    or `CLOUD_CORE_ENVIRONMENT` dev, staging, prod or production) only for `localhost` and
 *    `127.0.0.1`. No credentials, query or fragment.
 *  - `CLOUD_CORE_FLEET_SECRET`: the shared secret that signs what Core sends. Required when the URL
 *    is set. A secret without a URL is inert.
 *  - `CLOUD_CORE_ENABLED_FEATURES`: how a Private Cloud switches first-party features on, a
 *    comma-separated list of `feature[:package+package]` entries. Blank (the hosted Core) leaves
 *    Fleet's installation to the two settings above. Set, it must list `fleet.managed` for Fleet to
 *    be installed. A value of nothing but separators is a set value that lists no feature, so it
 *    does not install Fleet. Only the feature names are read here.
 *  - `CLOUD_CORE_FLEET_MAX_BODY_BYTES` (default 1048576), `CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES`
 *    (default 10485760), `CLOUD_CORE_FLEET_TIMEOUT_MS` (default 10000) and
 *    `CLOUD_CORE_FLEET_MAX_ASSET_BYTES` (default 26214400): the largest request body Core reads, the
 *    largest upstream response body Core buffers, how long an upstream answer may take, and the
 *    largest Fleet UI asset Core relays. A value that is not a positive integer falls back to the
 *    default, and a timeout above 2147483647 ms (the longest a timer holds) is clamped to it.
 *
 * Three states, never conflated:
 *  - `not_installed`: no URL, or `CLOUD_CORE_ENABLED_FEATURES` is set without `fleet.managed`. Core
 *    answers 404 and the admin portal hides the Fleet page;
 *  - `misconfigured`: the URL is set but unusable, or the secret is missing. Fleet is installed but
 *    unavailable, and the admin portal says so rather than hiding a broken install. The reason names
 *    the variable and never carries a value;
 *  - `ready`: Core may forward.
 *
 * Everything is read from the environment on each call, so a changed setting takes effect on the
 * next request and tests can pass their own. A problem is logged once per process, naming the
 * variable and never its value. That includes a `CLOUD_CORE_FLEET_URL` that
 * `CLOUD_CORE_ENABLED_FEATURES` switches off (a warning that names both variables).
 */

import {createLogger} from "@mentra/cloud-shared"
import {DEFAULT_FORWARDING_LIMITS, parseUpstreamUrl, type ForwardingLimits} from "../forwarding/upstream-url"
import {enabledFeaturesConfigured, parseEnabledFeatures} from "../licenses/enabled-features"
import {isDeployedEnvironment} from "../signin/config"

const logger = createLogger("core").child({service: "fleet-config"})

/** The feature a Private Cloud lists in `CLOUD_CORE_ENABLED_FEATURES` once it has bought Fleet. */
const FLEET_FEATURE = "fleet.managed"

/** The longest a timer holds: past 2^31 - 1 ms some runtimes fire at once, which would fail every request. */
const MAX_TIMEOUT_MS = 2_147_483_647

export type FleetConfig =
  | {state: "not_installed"}
  | {state: "misconfigured"; reason: string}
  | {state: "ready"; baseUrl: URL; secret: string}

/** The byte and time limits on Core's side of the Fleet seam. */
export type FleetLimits = ForwardingLimits

/**
 * The settings this module reads, taken from the process now. Each variable is read as a literal
 * `process.env` property so the production config contract check
 * (`.github/scripts/validate-production-cloud-config.mjs`) sees it.
 */
function processEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    CLOUD_CORE_ENVIRONMENT: process.env.CLOUD_CORE_ENVIRONMENT,
    CLOUD_CORE_ENABLED_FEATURES: process.env.CLOUD_CORE_ENABLED_FEATURES,
    CLOUD_CORE_FLEET_URL: process.env.CLOUD_CORE_FLEET_URL,
    CLOUD_CORE_FLEET_SECRET: process.env.CLOUD_CORE_FLEET_SECRET,
    CLOUD_CORE_FLEET_MAX_BODY_BYTES: process.env.CLOUD_CORE_FLEET_MAX_BODY_BYTES,
    CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: process.env.CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES,
    CLOUD_CORE_FLEET_TIMEOUT_MS: process.env.CLOUD_CORE_FLEET_TIMEOUT_MS,
    CLOUD_CORE_FLEET_MAX_ASSET_BYTES: process.env.CLOUD_CORE_FLEET_MAX_ASSET_BYTES,
  }
}

/** A problem is logged once per process and distinct message, so a request path that asks again stays quiet. */
const reported = new Set<string>()

function reportOnce(level: "error" | "warn", variable: string, message: string): void {
  const key = `${level}:${variable}:${message}`
  if (reported.has(key)) return
  reported.add(key)
  logger[level]({variable}, message)
}

/**
 * The feature names `CLOUD_CORE_ENABLED_FEATURES` lists, or `null` when it is blank (the hosted Core).
 * The setting's syntax and parser are `services/licenses/enabled-features.ts`; the package lists are
 * ignored here.
 */
function listedFeatures(env: NodeJS.ProcessEnv): Set<string> | null {
  if (!enabledFeaturesConfigured(env)) return null
  return new Set(parseEnabledFeatures(env).keys())
}

/** The feature names of `CLOUD_CORE_ENABLED_FEATURES`: empty when the setting is blank or lists none. */
export function enabledFeatures(env: NodeJS.ProcessEnv = processEnvironment()): Set<string> {
  return listedFeatures(env) ?? new Set()
}

/** Whether Fleet is installed on this Core, and when it is, whether Core can reach it. */
export function fleetConfig(env: NodeJS.ProcessEnv = processEnvironment()): FleetConfig {
  const rawUrl = (env.CLOUD_CORE_FLEET_URL ?? "").trim()
  // The URL decides whether Fleet is installed; a secret without one is inert.
  if (!rawUrl) return {state: "not_installed"}

  // A Private Cloud that did not buy Fleet is not installed, however its Fleet settings look. A URL that
  // the feature list switches off is usually a list that forgot `fleet.managed`, and the 404 every phone
  // then gets says nothing of it, so the operator is told once.
  const features = listedFeatures(env)
  if (features && !features.has(FLEET_FEATURE)) {
    reportOnce(
      "warn",
      "CLOUD_CORE_ENABLED_FEATURES",
      `CLOUD_CORE_FLEET_URL is set but CLOUD_CORE_ENABLED_FEATURES does not list ${FLEET_FEATURE}; Fleet is not installed`,
    )
    return {state: "not_installed"}
  }

  const problems: string[] = []
  const baseUrl = parseUpstreamUrl(rawUrl, isDeployedEnvironment(env))
  if (!baseUrl) {
    const message =
      "CLOUD_CORE_FLEET_URL is not a usable Fleet URL (an http(s) URL without credentials, query or fragment; a deployed Core requires https except on localhost)"
    problems.push(message)
    reportOnce("error", "CLOUD_CORE_FLEET_URL", `${message}; refusing Fleet requests`)
  }
  const secret = env.CLOUD_CORE_FLEET_SECRET ?? ""
  if (!secret.trim()) {
    const message = "CLOUD_CORE_FLEET_SECRET is required when CLOUD_CORE_FLEET_URL is set"
    problems.push(message)
    reportOnce("error", "CLOUD_CORE_FLEET_SECRET", `${message}; refusing Fleet requests`)
  }
  if (!baseUrl || problems.length > 0) return {state: "misconfigured", reason: problems.join("; ")}
  return {state: "ready", baseUrl, secret}
}

/** Whether Fleet is installed: true for a broken install too, which the admin portal reports as unavailable. */
export function fleetInstalled(env: NodeJS.ProcessEnv = processEnvironment()): boolean {
  return fleetConfig(env).state !== "not_installed"
}

/** A positive integer from the environment, or `fallback` when it is unset, blank or not one. */
function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (/^\d+$/.test(raw) && Number.isSafeInteger(value) && value > 0) return value
  reportOnce("warn", name, `${name} is not a positive integer; using the default of ${fallback}`)
  return fallback
}

/** The timeout, never above what a timer can hold. */
function timeoutMs(env: NodeJS.ProcessEnv): number {
  const value = positiveInteger(env, "CLOUD_CORE_FLEET_TIMEOUT_MS", DEFAULT_FORWARDING_LIMITS.timeoutMs)
  if (value <= MAX_TIMEOUT_MS) return value
  reportOnce(
    "warn",
    "CLOUD_CORE_FLEET_TIMEOUT_MS",
    `CLOUD_CORE_FLEET_TIMEOUT_MS is above ${MAX_TIMEOUT_MS} ms, the longest a timer holds; using ${MAX_TIMEOUT_MS}`,
  )
  return MAX_TIMEOUT_MS
}

/** The byte and time limits on Core's side of the Fleet seam. */
export function fleetLimits(env: NodeJS.ProcessEnv = processEnvironment()): FleetLimits {
  return {
    maxBodyBytes: positiveInteger(env, "CLOUD_CORE_FLEET_MAX_BODY_BYTES", DEFAULT_FORWARDING_LIMITS.maxBodyBytes),
    maxResponseBytes: positiveInteger(env, "CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES", DEFAULT_FORWARDING_LIMITS.maxResponseBytes),
    timeoutMs: timeoutMs(env),
    maxAssetBytes: positiveInteger(env, "CLOUD_CORE_FLEET_MAX_ASSET_BYTES", DEFAULT_FORWARDING_LIMITS.maxAssetBytes),
  }
}
