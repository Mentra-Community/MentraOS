/**
 * Automatic updates from each installed miniapp's own URL.
 *
 * A miniapp URL serves `miniapp.json`: a copy of the manifest inside the
 * miniapp's current ZIP, plus `bundle: {url, sha256}` naming that ZIP. The
 * engine checks each installed miniapp's URL and hands a newer release to the
 * shared installer, which binds it to the package and version, verifies the
 * hash, and applies the signer and version rules. Mentra's own bundled
 * miniapps update from `<firstPartyMiniappsUrl><packageName>/`.
 */
import semver from "semver"

import {isPackageNameAllowedForUrl} from "./miniappDomainRule"
import {checkMiniappInstallCompatibility, type MiniappCompatibilityPolicy} from "./miniappInstallCompatibility"
import type {MiniappReleaseIdentity} from "./AppRegistry"
import type {ReleaseInstallOptions} from "./miniappReleaseInstall"

/** A newly opened miniapp is checked again only after this long. */
export const OPEN_CHECK_INTERVAL_MS = 60_000
/** Failed checks back off from this delay, doubling up to {@link MAX_BACKOFF_MS}. */
export const BASE_BACKOFF_MS = 5 * 60_000
export const MAX_BACKOFF_MS = 6 * 60 * 60_000
const FETCH_TIMEOUT_MS = 15_000
const MAX_MANIFEST_BYTES = 64 * 1024

export interface HostedMiniappManifest {
  packageName: string
  version: string
  minHostVersion?: string
  sdkVersion?: string
  hardwareRequirements?: unknown
  bundle: {url: string; sha256: string}
}

export interface ManifestFetchResult {
  status: number
  /** The URL the response came from, after redirects. */
  url: string
  etag?: string
  body?: string
  /** From `Retry-After`, when the host asked us to wait. */
  retryAfterMs?: number
}

export interface MiniappUrlUpdaterDependencies {
  installedPackages(): Promise<string[]>
  activeVersion(packageName: string): Promise<string | undefined>
  releaseIdentity(packageName: string, version: string): MiniappReleaseIdentity | null
  isSystemPackage(packageName: string): boolean
  /** `<firstPartyMiniappsUrl><packageName>/` for a bundled package, or undefined. */
  firstPartyUrl(packageName: string): string | undefined
  hasDevelopmentSelection(packageName: string): boolean
  compatibilityPolicy(): MiniappCompatibilityPolicy | null
  fetchManifest(url: string, etag: string | undefined): Promise<ManifestFetchResult>
  install(bundleUrl: string, options: ReleaseInstallOptions): Promise<void>
  /** Keep only these versions of the package (the new release and the one it replaced). */
  keepVersions(packageName: string, versions: string[]): Promise<void>
  isRunningError(error: unknown): boolean
  now(): number
  log(message: string): void
  warn(message: string, error?: unknown): void
}

export {isPackageNameAllowedForUrl}

const SHA256 = /^[a-f0-9]{64}$/

/** Validate a served `miniapp.json` for `packageName`. */
export function parseHostedManifest(body: string, packageName: string): HostedMiniappManifest {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    throw new Error("miniapp.json is not valid JSON")
  }
  if (!raw || typeof raw !== "object") throw new Error("miniapp.json is not an object")
  const manifest = raw as Record<string, unknown>
  if (manifest.packageName !== packageName) {
    throw new Error(`miniapp.json names ${String(manifest.packageName)}, not ${packageName}`)
  }
  if (typeof manifest.version !== "string" || !semver.valid(manifest.version)) {
    throw new Error("miniapp.json has no valid version")
  }
  const bundle = manifest.bundle as Record<string, unknown> | undefined
  if (!bundle || typeof bundle.url !== "string" || bundle.url.trim() === "") {
    throw new Error("miniapp.json has no bundle URL")
  }
  if (typeof bundle.sha256 !== "string" || !SHA256.test(bundle.sha256.toLowerCase())) {
    throw new Error("miniapp.json has no valid bundle SHA-256")
  }
  return {
    packageName,
    version: manifest.version,
    minHostVersion: typeof manifest.minHostVersion === "string" ? manifest.minHostVersion : undefined,
    sdkVersion: typeof manifest.sdkVersion === "string" ? manifest.sdkVersion : undefined,
    hardwareRequirements: manifest.hardwareRequirements,
    bundle: {url: bundle.url.trim(), sha256: bundle.sha256.toLowerCase()},
  }
}

interface Backoff {
  failures: number
  nextAttemptAt: number
}

export class MiniappUrlUpdater {
  private readonly etags = new Map<string, string>()
  private readonly backoff = new Map<string, Backoff>()
  private readonly lastCheckedAt = new Map<string, number>()
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(private readonly deps: MiniappUrlUpdaterDependencies) {}

  /** The URL an installed release updates from, or undefined when nothing updates it automatically. */
  updateUrlFor(packageName: string, identity: MiniappReleaseIdentity | null): string | undefined {
    if (!identity) return undefined
    // A bundled package, or one an updater replaced, updates from the host this
    // build or workspace names, so it follows the deployment; none, no updates.
    const firstParty =
      identity.source === "url" ||
      identity.source === "bundled_asset" ||
      identity.source === "preinstalled_registry" ||
      identity.source === "system_store"
    if (firstParty && this.deps.isSystemPackage(packageName)) return this.deps.firstPartyUrl(packageName)
    if (identity.source === "url") return identity.sourceUrl
    return undefined
  }

  /** Check every installed miniapp, one at a time. */
  async checkAll(): Promise<void> {
    const packages = await this.deps.installedPackages()
    for (const packageName of packages) await this.check(packageName)
  }

  /** Check a miniapp the user just opened, unless it was checked moments ago. */
  checkOpened(packageName: string): Promise<void> {
    const last = this.lastCheckedAt.get(packageName)
    if (last !== undefined && this.deps.now() - last < OPEN_CHECK_INTERVAL_MS) return Promise.resolve()
    return this.check(packageName)
  }

  check(packageName: string): Promise<void> {
    const running = this.inFlight.get(packageName)
    if (running) return running
    const check = this.run(packageName).finally(() => this.inFlight.delete(packageName))
    this.inFlight.set(packageName, check)
    return check
  }

  private async run(packageName: string): Promise<void> {
    const now = this.deps.now()
    const waiting = this.backoff.get(packageName)
    if (waiting && waiting.nextAttemptAt > now) return

    const version = await this.deps.activeVersion(packageName)
    if (!version || !semver.valid(version)) return
    if (this.deps.hasDevelopmentSelection(packageName)) return
    const sourceUrl = this.updateUrlFor(packageName, this.deps.releaseIdentity(packageName, version))
    if (!sourceUrl || !isPackageNameAllowedForUrl(packageName, sourceUrl)) return

    this.lastCheckedAt.set(packageName, now)
    const manifestUrl = new URL("miniapp.json", sourceUrl).href
    let result: ManifestFetchResult
    try {
      result = await this.deps.fetchManifest(manifestUrl, this.etags.get(manifestUrl))
    } catch (error) {
      this.fail(packageName, `could not fetch ${manifestUrl}`, error)
      return
    }
    if (result.status === 304) {
      this.backoff.delete(packageName)
      return
    }
    if (result.status < 200 || result.status >= 300 || result.body === undefined) {
      this.fail(packageName, `${manifestUrl} answered ${result.status}`, undefined, result.retryAfterMs)
      return
    }
    if (!isPackageNameAllowedForUrl(packageName, result.url)) {
      this.fail(packageName, `${manifestUrl} redirected to ${result.url}, which can't serve ${packageName}`)
      return
    }

    let manifest: HostedMiniappManifest
    try {
      manifest = parseHostedManifest(result.body, packageName)
    } catch (error) {
      this.fail(packageName, `${manifestUrl} is not a valid miniapp.json`, error)
      return
    }
    if (result.etag) this.etags.set(manifestUrl, result.etag)
    this.backoff.delete(packageName)
    if (!semver.gt(manifest.version, version)) return

    const policy = this.deps.compatibilityPolicy()
    if (!policy) return
    const compatibility = checkMiniappInstallCompatibility(manifest, policy)
    if (!compatibility.compatible) {
      this.deps.log(`${packageName}@${manifest.version} is not compatible with this phone: ${compatibility.reason}`)
      return
    }

    let bundleUrl: string
    try {
      const resolved = new URL(manifest.bundle.url, result.url)
      if (resolved.protocol !== "https:") throw new Error("the bundle URL is not HTTPS")
      bundleUrl = resolved.href
    } catch (error) {
      this.fail(packageName, `${manifestUrl} names an unusable bundle URL`, error)
      return
    }

    try {
      await this.deps.install(bundleUrl, {
        expectedPackageName: packageName,
        expectedVersion: manifest.version,
        expectedBundleSha256: manifest.bundle.sha256,
        compatibilityPolicy: policy,
        onlyIfStopped: true,
        askIfRunning: true,
        beforeActivate: () => {
          if (this.deps.hasDevelopmentSelection(packageName)) {
            throw new Error(`${packageName} uses a manually selected build`)
          }
        },
        releaseIdentity: {source: "url", sourceUrl, bundleSha256: manifest.bundle.sha256},
      })
    } catch (error) {
      // A running miniapp's update waits for it to stop, or for the user's answer.
      if (this.deps.isRunningError(error)) return
      this.fail(packageName, `could not install ${packageName}@${manifest.version}`, error)
      return
    }
    this.deps.log(`Updated ${packageName} from ${version} to ${manifest.version}`)
    await this.deps.keepVersions(packageName, [manifest.version, version]).catch((error) => {
      this.deps.warn(`Could not remove older releases of ${packageName}`, error)
    })
  }

  private fail(packageName: string, message: string, error?: unknown, retryAfterMs?: number): void {
    const failures = (this.backoff.get(packageName)?.failures ?? 0) + 1
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
    this.backoff.set(packageName, {
      failures,
      nextAttemptAt: this.deps.now() + Math.max(delay, retryAfterMs ?? 0),
    })
    this.deps.warn(`Miniapp update check for ${packageName}: ${message}`, error)
  }
}

/** `fetch` for `miniapp.json`: conditional, time-limited, and size-bounded. */
export async function fetchHostedManifest(url: string, etag: string | undefined): Promise<ManifestFetchResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        ...(etag ? {"If-None-Match": etag} : {}),
      },
    })
    const retryAfter = Number(response.headers.get("retry-after"))
    const base: ManifestFetchResult = {
      status: response.status,
      url: response.url || url,
      etag: response.headers.get("etag") ?? undefined,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? {retryAfterMs: retryAfter * 1000} : {}),
    }
    if (response.status < 200 || response.status >= 300) return base
    const body = await response.text()
    if (body.length > MAX_MANIFEST_BYTES) throw new Error(`miniapp.json exceeds ${MAX_MANIFEST_BYTES} bytes`)
    return {...base, body}
  } finally {
    clearTimeout(timeout)
  }
}
