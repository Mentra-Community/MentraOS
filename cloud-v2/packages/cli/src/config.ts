/**
 * @fileoverview What the CLI talks to, from the environment (`--store-url` and
 * `--core-url` set the same variables for one run).
 *
 * - `MENTRA_STORE_URL`: the Mentra Miniapp Store; default the production
 *   Store. Every Store command goes there.
 * - `MENTRA_CORE_URL`: Core mode, for a Core without a Store (a Mentra Private
 *   Cloud). Only `login`, `logout`, `whoami` and `admin me` work there. Set one
 *   of the two, not both.
 * - `MENTRA_CLI_OIDC_ISSUER` and `MENTRA_CLI_CLIENT_ID`: the sign-in server and
 *   CLI client, when both are set. Otherwise the CLI asks its target (the
 *   Store's `/api/console/auth/cli-config`, or Core's `/api/cli/config`).
 * - `MENTRA_CONSOLE_URL`: the Developer Console, named in messages.
 */

/** The production Mentra Miniapp Store's backend. */
export const DEFAULT_STORE_URL = "https://api.apps.mentraglass.com"
/** The production Developer Console. */
export const DEFAULT_CONSOLE_URL = "https://console.mentraglass.com"

/** Where the CLI's requests go: a Mentra Miniapp Store, or (Core mode) a Core without a Store. */
export type CliTarget = {kind: "store"; url: string} | {kind: "core"; url: string}

export interface CliConfig {
  target: CliTarget
  consoleUrl: string
  /** `MENTRA_CLI_OIDC_ISSUER`, or "" to ask the target. */
  oidcIssuer: string
  /** `MENTRA_CLI_CLIENT_ID`, or "" to ask the target. */
  cliClientId: string
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

function setting(value: string | undefined): string {
  return (value ?? "").trim()
}

export function getConfig(): CliConfig {
  const storeUrl = setting(process.env.MENTRA_STORE_URL)
  const coreUrl = setting(process.env.MENTRA_CORE_URL)
  if (storeUrl && coreUrl) {
    throw new Error(
      "MENTRA_STORE_URL and MENTRA_CORE_URL are both set. Set MENTRA_STORE_URL for a Mentra Miniapp Store, or MENTRA_CORE_URL for a Core without a Store, not both.",
    )
  }
  return {
    target: coreUrl
      ? {kind: "core", url: normalizeUrl(coreUrl, "MENTRA_CORE_URL")}
      : {kind: "store", url: normalizeUrl(storeUrl || DEFAULT_STORE_URL, "MENTRA_STORE_URL")},
    consoleUrl: normalizeUrl(setting(process.env.MENTRA_CONSOLE_URL) || DEFAULT_CONSOLE_URL, "MENTRA_CONSOLE_URL"),
    oidcIssuer: setting(process.env.MENTRA_CLI_OIDC_ISSUER),
    cliClientId: setting(process.env.MENTRA_CLI_CLIENT_ID),
  }
}

/** Whether `url` is plain HTTP to this machine, the only place the CLI sends tokens without TLS. */
export function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
}

/**
 * `value` as an origin with an optional path, no trailing slash, query or
 * fragment. HTTPS, or plain HTTP to a loopback address (local development).
 */
export function normalizeUrl(value: string, label = "URL"): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} is not a URL: ${value}`)
  }
  if (url.username || url.password || (url.protocol !== "https:" && !isLoopbackHttp(url))) {
    throw new Error(`${label} must be an HTTPS URL without credentials (plain HTTP only on 127.0.0.1, localhost or [::1])`)
  }
  url.pathname = url.pathname.replace(/\/+$/, "")
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}

/** How a message names the target: "Store" or "Core". */
export function targetLabel(target: CliTarget): string {
  return target.kind === "store" ? "Store" : "Core"
}
