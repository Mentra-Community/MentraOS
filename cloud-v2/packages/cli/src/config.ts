/**
 * @fileoverview What the CLI talks to, from the environment (`--core-url` sets
 * the same variable for one run).
 *
 * - `MENTRA_CORE_URL`: the Core the CLI signs in to and asks about your
 *   workspace; default production Core. A Mentra Private Cloud names its own.
 * - `MENTRA_CLI_OIDC_ISSUER` and `MENTRA_CLI_CLIENT_ID`: the sign-in server and
 *   CLI client, when both are set. Otherwise the CLI asks Core
 *   (`/api/cli/config`).
 */

/** Production Core. */
export const DEFAULT_CORE_URL = "https://core.mentraglass.com"

export interface CliConfig {
  /** The Core every request goes to. */
  coreUrl: string
  /** `MENTRA_CLI_OIDC_ISSUER`, or "" to ask Core. */
  oidcIssuer: string
  /** `MENTRA_CLI_CLIENT_ID`, or "" to ask Core. */
  cliClientId: string
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

function setting(value: string | undefined): string {
  return (value ?? "").trim()
}

export function getConfig(): CliConfig {
  return {
    coreUrl: normalizeUrl(setting(process.env.MENTRA_CORE_URL) || DEFAULT_CORE_URL, "MENTRA_CORE_URL"),
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
