/**
 * decideDevLaunchRoute — pre-flight reachability + manifest fetch for dev
 * miniapp launches.
 *
 * Every entry point that wants to launch a dev miniapp (home tile, QR
 * scan, URL screen, dev-offline "Try again" button) calls this BEFORE
 * navigating, so:
 *
 *   1. We land on the right destination in a single transition
 *      (live mount vs offline takeover) — no flash through /applet/local.
 *   2. Callers that need the manifest (permission gate, name/icon read)
 *      get it in the same round trip — no second fetch.
 *
 * Pre-flighting at the call site keeps /applet/local a pure mount route.
 *
 * When the laptop's Wi-Fi IP changes, the URL stored from the last QR scan
 * goes stale. We then retry alternate hosts (Metro / EXPO_PUBLIC_LOCAL_MINIAPP_HOST,
 * plus an mDNS name captured at scan time) and persist the working URL so
 * the next launch doesn't need a re-scan.
 */

import {configuredDevHost} from "./configuredDevHost"
import {storage} from "./storage/storage"

const REACHABILITY_TIMEOUT_MS = 1500

// A single dropped DNS lookup or momentary Wi-Fi blip (AP roam, DHCP renewal,
// phone hopping to cellular for a beat) looks identical to a dead dev server —
// both throw out of fetch(). Retrying once absorbs that transient case instead
// of bouncing straight to the offline screen. We do NOT retry a real HTTP
// response (res.ok === false): that's the server telling us something
// definitive, not a network-layer hiccup.
const REACHABILITY_MAX_ATTEMPTS = 2
const REACHABILITY_RETRY_DELAY_MS = 400

export type DevManifest = {
  packageName?: string
  name?: string
  /** First-found of `icon` / `iconUrl` / `logoUrl` (relative or absolute). */
  icon?: string
  permissions?: unknown
  hardwareRequirements?: unknown
  [key: string]: unknown
}

export type DevLaunchResult =
  | {decision: "live"; manifest: DevManifest; resolvedUrl: string}
  | {decision: "offline"; manifest: null; resolvedUrl?: undefined}

export type DecideDevLaunchOptions = {
  /** Extra hostnames / IPs to try if `devUrl` is unreachable (no scheme/port). */
  alternateHosts?: string[]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Single GET <devUrl>/miniapp.json attempt with a hard timeout. */
async function fetchManifestOnce(devUrl: string): Promise<DevManifest | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS)
  try {
    const res = await fetch(`${devUrl.replace(/\/$/, "")}/miniapp.json`, {
      method: "GET",
      signal: controller.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as DevManifest
  } finally {
    clearTimeout(timer)
  }
}

function rewriteHost(devUrl: string, host: string): string | null {
  const trimmed = host.trim()
  if (!trimmed) return null
  try {
    const url = new URL(devUrl)
    if (url.hostname === trimmed) return null
    url.hostname = trimmed
    return url.toString().replace(/\/$/, "")
  } catch {
    return null
  }
}

/**
 * Point an http(s) icon at the host that actually answered. Cached dev icons are
 * local `file://` paths and third-party icons live on unrelated hosts, so only
 * icons still served by the stale dev host are rewritten.
 */
function rewriteIconHost(iconUrl: string, staleDevUrl: string, resolvedDevUrl: string): string | null {
  try {
    const icon = new URL(iconUrl)
    if (icon.protocol !== "http:" && icon.protocol !== "https:") return null
    const stale = new URL(staleDevUrl)
    const resolved = new URL(resolvedDevUrl)
    // Compare host (hostname+port) so an icon on the same hostname but a
    // different service port is left alone.
    if (icon.host !== stale.host) return null
    icon.host = resolved.host
    return icon.toString()
  } catch {
    return null
  }
}

function collectAlternateHosts(packageName: string, extra?: string[]): string[] {
  const hosts: string[] = []
  const push = (h: string | undefined | null) => {
    const v = h?.trim()
    if (v && !hosts.includes(v)) hosts.push(v)
  }

  push(configuredDevHost())

  if (packageName) {
    const mdns = storage.load<string>(`${packageName}_dev_mdns`)
    if (mdns.is_ok()) push(mdns.value)
  }

  for (const h of extra ?? []) push(h)
  return hosts
}

async function probeUrl(devUrl: string): Promise<DevManifest | null | "network-error"> {
  for (let attempt = 1; attempt <= REACHABILITY_MAX_ATTEMPTS; attempt++) {
    try {
      const manifest = await fetchManifestOnce(devUrl)
      // Definitive HTTP failure — do not retry this URL further.
      if (!manifest) return null
      return manifest
    } catch {
      if (attempt < REACHABILITY_MAX_ATTEMPTS) {
        await delay(REACHABILITY_RETRY_DELAY_MS)
        continue
      }
      return "network-error"
    }
  }
  return "network-error"
}

/**
 * GET <devUrl>/miniapp.json with a hard timeout, retrying once on a
 * network-layer failure (DNS/connection/abort) before trying alternate
 * hosts (Metro laptop IP, mDNS name from the QR). Returns the parsed
 * manifest on success ("live") or null ("offline").
 *
 * Side effects on success:
 *   - writes <packageName>_dev_last_reachable
 *   - if an alternate host worked, rewrites <packageName>_dev_url so the
 *     next launch skips the stale IP
 */
export async function decideDevLaunchRoute(
  packageName: string,
  devUrl: string,
  options?: DecideDevLaunchOptions,
): Promise<DevLaunchResult> {
  const candidates: string[] = [devUrl]
  for (const host of collectAlternateHosts(packageName, options?.alternateHosts)) {
    const rewritten = rewriteHost(devUrl, host)
    if (rewritten && !candidates.includes(rewritten)) candidates.push(rewritten)
  }

  for (const candidate of candidates) {
    const result = await probeUrl(candidate)
    if (result === "network-error" || result === null) continue

    if (packageName) {
      storage.save(`${packageName}_dev_last_reachable`, Date.now())
      if (candidate !== devUrl) {
        storage.save(`${packageName}_dev_url`, candidate)
        // Keep _dev_meta.devUrl in sync when present so home-tile reads match.
        const metaRes = storage.load<string>(`${packageName}_dev_meta`)
        if (metaRes.is_ok()) {
          try {
            const meta = JSON.parse(metaRes.value) as {devUrl?: string; iconUrl?: string}
            meta.devUrl = candidate
            if (typeof meta.iconUrl === "string") {
              const rewritten = rewriteIconHost(meta.iconUrl, devUrl, candidate)
              if (rewritten) meta.iconUrl = rewritten
            }
            storage.save(`${packageName}_dev_meta`, JSON.stringify(meta))
          } catch {
            /* ignore malformed meta */
          }
        }
      }
    }
    return {decision: "live", manifest: result, resolvedUrl: candidate}
  }

  return {decision: "offline", manifest: null}
}
