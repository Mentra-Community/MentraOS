/**
 * A development build runs the way an installed bundle does: from a copy of its `bundle.zip` on the phone, whose
 * screen loads from a development origin the Mentra App serves (with the package's own files under it). `mentra-miniapp
 * dev` serves that ZIP and names its SHA-256 in the `miniapp.json` it serves; each launch and each saved change fetch it
 * into `lmas/<pkg>/dev-<ms>/` when the hash changed, and the newest copy stays, so the miniapp still opens from it
 * once the laptop is gone.
 */

import appRegistry from "../services/AppRegistry"
import {createDevSnapshotRequest} from "./devSnapshotRequests"
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
  | {kind: "live"; resolvedUrl: string; manifest: DevManifest; version: string}
  | {kind: "snapshot"; version: string}
  | {kind: "none"}

type SnapshotRequest = ReturnType<typeof createDevSnapshotRequest>

/** The snapshot each package's development server last gave this app, by the SHA-256 of its ZIP. */
const fetched = new Map<string, {sha256: string; version: string}>()
const inFlight = new Map<string, {sha256: string | null; promise: Promise<string | null>; isCurrent: () => boolean}>()

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

/** The SHA-256 the served `miniapp.json` names for its `bundle.zip`, if it names a valid one. */
export function servedBundleSha256(manifest: DevManifest | null | undefined): string | null {
  const bundle = manifest?.bundle as {sha256?: unknown} | undefined
  const sha256 = typeof bundle?.sha256 === "string" ? bundle.sha256.toLowerCase() : null
  return sha256 && /^[a-f0-9]{64}$/.test(sha256) ? sha256 : null
}

function storedSidecarPort(packageName: string): number | undefined {
  const stored = storage.load<number>(`${packageName}_dev_port`)
  return stored.is_ok() && Number.isFinite(stored.value) ? stored.value : undefined
}

/**
 * The snapshot of what the development server at `baseUrl` serves now: the one this app already fetched when its
 * hash is `sha256`, else a new one, which replaces the older snapshots. Concurrent calls for the same ZIP share one
 * download. Null when the download fails or a release installation superseded it.
 */
export function ensureDevSnapshot(
  packageName: string,
  baseUrl: string,
  sha256: string | null,
  request: SnapshotRequest = createDevSnapshotRequest(packageName),
): Promise<string | null> {
  if (!packageName || !baseUrl || !request.isCurrent()) return Promise.resolve(null)
  const known = fetched.get(packageName)
  if (sha256 && known?.sha256 === sha256 && appRegistry.getLatestDevSnapshotVersion(packageName) === known.version) {
    return Promise.resolve(known.version)
  }
  const pending = inFlight.get(packageName)
  if (pending && pending.sha256 === sha256 && pending.isCurrent()) return pending.promise
  const promise = installDevSnapshot(packageName, baseUrl, sha256, request).finally(() => {
    if (inFlight.get(packageName)?.promise === promise) inFlight.delete(packageName)
  })
  inFlight.set(packageName, {sha256, promise, isCurrent: request.isCurrent})
  return promise
}

async function installDevSnapshot(
  packageName: string,
  baseUrl: string,
  sha256: string | null,
  request: SnapshotRequest,
): Promise<string | null> {
  let lastError: unknown
  for (const url of snapshotCandidateUrls(baseUrl, storedSidecarPort(packageName))) {
    if (!request.isCurrent()) return null
    const version = `dev-${Date.now()}`
    const res = await appRegistry.installFromUrl(url, {
      expectedPackageName: packageName,
      beforeActivate: request.beforeActivate,
      versionOverride: version,
      releaseIdentity: {source: "dev_snapshot"},
      ...(sha256 ? {expectedBundleSha256: sha256} : {}),
    })
    if (!request.isCurrent()) return null
    if (res.is_ok()) {
      appRegistry.gcDevVersions(packageName, 1)
      if (sha256) fetched.set(packageName, {sha256, version})
      else fetched.delete(packageName)
      return version
    }
    lastError = res.error
  }
  console.warn(`Dev snapshot failed for ${packageName}:`, lastError)
  return null
}

/**
 * Reachability first; if the laptop is down, open the last local snapshot. A reachable server starts fetching its
 * bundle, which the launch then waits for.
 */
export async function decideDevOpenRoute(
  packageName: string,
  devUrl: string,
  options?: DecideDevLaunchOptions,
): Promise<DevOpenDecision> {
  const request = createDevSnapshotRequest(packageName)
  const route = await decideDevLaunchRoute(packageName, devUrl, options)
  if (route.decision === "live") {
    void ensureDevSnapshot(packageName, route.resolvedUrl, servedBundleSha256(route.manifest), request)
    return route
  }
  if (packageName && appRegistry.hasDevSnapshot(packageName)) {
    return {decision: "cached"}
  }
  return {decision: "offline"}
}

/**
 * The snapshot MiniappLauncher runs a development build from: the server's current bundle when it answers, else the
 * last one on disk.
 */
export async function resolveDevBundleSource(
  packageName: string,
  devUrl: string,
  options?: DecideDevLaunchOptions,
): Promise<DevBundleSource> {
  const request = createDevSnapshotRequest(packageName)
  const route: DevLaunchResult = await decideDevLaunchRoute(packageName, devUrl, options)
  if (route.decision === "live" && route.manifest) {
    const version = await ensureDevSnapshot(
      packageName,
      route.resolvedUrl,
      servedBundleSha256(route.manifest),
      request,
    )
    if (version) return {kind: "live", resolvedUrl: route.resolvedUrl, manifest: route.manifest, version}
  }
  const version = appRegistry.getLatestDevSnapshotVersion(packageName)
  if (version) return {kind: "snapshot", version}
  return {kind: "none"}
}

/** Tests only. */
export function resetDevSnapshotsForTests(): void {
  fetched.clear()
  inFlight.clear()
}
