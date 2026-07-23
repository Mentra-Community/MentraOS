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
 */

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

export type DevLaunchResult = {decision: "live"; manifest: DevManifest} | {decision: "offline"; manifest: null}

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

/**
 * GET <devUrl>/miniapp.json with a hard timeout, retrying once on a
 * network-layer failure (DNS/connection/abort) before declaring the dev
 * server offline. Returns the parsed manifest on success ("live") or
 * null ("offline").
 *
 * Side effect: on success, writes <packageName>_dev_last_reachable so
 * the dev-offline screen can show "Last reached: N min ago" the next
 * time the user lands there.
 *
 * The fetch doubles as the reachability probe AND the manifest source —
 * one request per attempt instead of two.
 */
export async function decideDevLaunchRoute(packageName: string, devUrl: string): Promise<DevLaunchResult> {
  for (let attempt = 1; attempt <= REACHABILITY_MAX_ATTEMPTS; attempt++) {
    try {
      const manifest = await fetchManifestOnce(devUrl)
      if (!manifest) return {decision: "offline", manifest: null}
      if (packageName) {
        storage.save(`${packageName}_dev_last_reachable`, Date.now())
      }
      return {decision: "live", manifest}
    } catch {
      if (attempt < REACHABILITY_MAX_ATTEMPTS) {
        await delay(REACHABILITY_RETRY_DELAY_MS)
        continue
      }
      return {decision: "offline", manifest: null}
    }
  }
  return {decision: "offline", manifest: null}
}
