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
  | {decision: "live"; manifest: DevManifest}
  | {decision: "offline"; manifest: null}

/**
 * GET <devUrl>/miniapp.json with a hard timeout. Returns the parsed
 * manifest on success ("live") or null ("offline").
 *
 * Side effect: on success, writes <packageName>_dev_last_reachable so
 * the dev-offline screen can show "Last reached: N min ago" the next
 * time the user lands there.
 *
 * The fetch doubles as the reachability probe AND the manifest source —
 * one request per launch attempt instead of two.
 */
export async function decideDevLaunchRoute(
  packageName: string,
  devUrl: string,
): Promise<DevLaunchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS)
  try {
    const res = await fetch(`${devUrl.replace(/\/$/, "")}/miniapp.json`, {
      method: "GET",
      signal: controller.signal,
    })
    if (!res.ok) return {decision: "offline", manifest: null}
    const manifest = (await res.json()) as DevManifest
    if (packageName) {
      storage.save(`${packageName}_dev_last_reachable`, Date.now())
    }
    return {decision: "live", manifest}
  } catch {
    return {decision: "offline", manifest: null}
  } finally {
    clearTimeout(timer)
  }
}
