/**
 * Dev miniapp snapshot — keep a local copy of the last live-dev bundle so
 * walking away from the laptop still opens the miniapp while Mentra App is
 * running (and after, as long as the on-disk `dev-*` snapshot remains).
 *
 * Live launches load HTTP off `mentra-miniapp dev` for hot reload. After a
 * successful reachability probe we fire-and-forget `${devUrl}/bundle.zip`
 * into `lmas/<pkg>/dev-<ms>/`. When the laptop is unreachable, launch
 * routes and MiniappLauncher fall back to that snapshot instead of the
 * "Dev server offline" dead-end.
 */

import appRegistry from "../services/AppRegistry"
import {storage} from "./storage/storage"
import {
  decideDevLaunchRoute,
  type DecideDevLaunchOptions,
  type DevLaunchResult,
  type DevManifest,
} from "./devMiniappLaunch"

export type DevOpenDecision =
  | {decision: "live"; manifest: DevManifest; resolvedUrl: string}
  | {decision: "cached"}
  | {decision: "offline"}

export type DevBundleSource =
  | {kind: "live"; resolvedUrl: string; manifest: DevManifest}
  | {kind: "snapshot"; version: string}
  | {kind: "none"}

const snapshotInFlight = new Map<string, Promise<void>>()

/** Candidate zip URLs: same-origin `/bundle.zip`, then the sidecar path. */
export function snapshotCandidateUrls(baseUrl: string, sidecarPort?: number | null): string[] {
  const trimmed = baseUrl.replace(/\/$/, "")
  const urls = [`${trimmed}/bundle.zip`]
  try {
    const url = new URL(trimmed)
    const userPort = Number(url.port) || (url.protocol === "https:" ? 443 : 80)
    const sidecar = sidecarPort && sidecarPort > 0 ? sidecarPort : userPort + 1
    url.port = String(sidecar)
    const sidecarZip = `${url.origin}/__mentra_dev/bundle.zip`
    if (!urls.includes(sidecarZip)) urls.push(sidecarZip)
  } catch {
    /* ignore malformed base */
  }
  return urls
}

function storedSidecarPort(packageName: string): number | undefined {
  const stored = storage.load<number>(`${packageName}_dev_port`)
  return stored.is_ok() && Number.isFinite(stored.value) ? stored.value : undefined
}

/**
 * Download the current live-dev zip into `lmas/<pkg>/dev-<ms>/` and keep
 * only the newest snapshot. Coalesces concurrent calls per package.
 */
export function queueDevSnapshot(packageName: string, baseUrl: string, sidecarPort?: number | null): void {
  if (!packageName || !baseUrl) return
  if (snapshotInFlight.has(packageName)) return
  const promise = installDevSnapshot(packageName, baseUrl, sidecarPort ?? storedSidecarPort(packageName)).finally(() => {
    snapshotInFlight.delete(packageName)
  })
  snapshotInFlight.set(packageName, promise)
}

async function installDevSnapshot(packageName: string, baseUrl: string, sidecarPort?: number | null): Promise<void> {
  let lastError: unknown
  for (const url of snapshotCandidateUrls(baseUrl, sidecarPort)) {
    const res = await appRegistry.installFromUrl(url, {
      versionOverride: `dev-${Date.now()}`,
      releaseIdentity: {source: "dev_snapshot"},
    })
    if (res.is_ok()) {
      appRegistry.gcDevVersions(packageName, 1)
      return
    }
    lastError = res.error
  }
  console.warn(`Dev snapshot failed for ${packageName}:`, lastError)
}

/** Reachability first; if the laptop is down, open the last local snapshot. */
export async function decideDevOpenRoute(
  packageName: string,
  devUrl: string,
  options?: DecideDevLaunchOptions,
): Promise<DevOpenDecision> {
  const route = await decideDevLaunchRoute(packageName, devUrl, options)
  if (route.decision === "live") {
    queueDevSnapshot(packageName, route.resolvedUrl)
    return route
  }
  if (packageName && appRegistry.hasDevSnapshot(packageName)) {
    return {decision: "cached"}
  }
  return {decision: "offline"}
}

/**
 * Same live-vs-snapshot choice MiniappLauncher uses to resolve a bundle.
 * Live also kicks a background snapshot so the next offline open has a copy.
 */
export async function resolveDevBundleSource(
  packageName: string,
  devUrl: string,
  options?: DecideDevLaunchOptions,
): Promise<DevBundleSource> {
  const route: DevLaunchResult = await decideDevLaunchRoute(packageName, devUrl, options)
  if (route.decision === "live" && route.manifest) {
    queueDevSnapshot(packageName, route.resolvedUrl)
    return {kind: "live", resolvedUrl: route.resolvedUrl, manifest: route.manifest}
  }
  const version = appRegistry.getLatestDevSnapshotVersion(packageName)
  if (version) return {kind: "snapshot", version}
  return {kind: "none"}
}
