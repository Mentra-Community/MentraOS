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
import {ServedMiniappManifestSchema} from "@mentra/cloud-protocol/miniapp-url"
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
export interface HostedMiniappManifest {
  packageName: string
  version: string
  minHostVersion?: string
  sdkVersion?: string
  hardwareRequirements?: unknown
  bundle: {url: string; sha256: string}
}

/** What a `miniapp.json` request answered (`fetchMiniappJson` in `miniappFetch.ts`). */
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
  /** Changes when the engine session ends; an update started before then must not activate. */
  installSession(): number
  now(): number
  log(message: string): void
  warn(message: string, error?: unknown): void
}

export {isPackageNameAllowedForUrl}

/** Validate a served `miniapp.json` for `packageName`, with the schema Core checks registrations with. */
export function parseHostedManifest(body: string, packageName: string): HostedMiniappManifest {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    throw new Error("miniapp.json is not valid JSON")
  }
  const parsed = ServedMiniappManifestSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`miniapp.json is not valid${issue ? `: ${issue.path.join(".") || "root"} ${issue.message}` : ""}`)
  }
  const manifest = parsed.data
  if (manifest.packageName !== packageName) {
    throw new Error(`miniapp.json names ${manifest.packageName}, not ${packageName}`)
  }
  return {
    packageName,
    version: manifest.version,
    minHostVersion: manifest.minHostVersion,
    sdkVersion: manifest.sdkVersion,
    hardwareRequirements: manifest.hardwareRequirements,
    bundle: {url: manifest.bundle.url.trim(), sha256: manifest.bundle.sha256},
  }
}

/**
 * The URL an installed release updates from, or undefined when nothing updates it automatically. A bundled package,
 * or one an updater replaced, updates from the host this build or workspace names, so it follows the deployment;
 * none, no updates.
 */
export function miniappUpdateUrl(
  packageName: string,
  identity: MiniappReleaseIdentity | null,
  deps: Pick<MiniappUrlUpdaterDependencies, "isSystemPackage" | "firstPartyUrl">,
): string | undefined {
  if (!identity) return undefined
  const firstParty =
    identity.source === "url" ||
    identity.source === "bundled_asset" ||
    identity.source === "preinstalled_registry" ||
    identity.source === "system_store"
  if (firstParty && deps.isSystemPackage(packageName)) return deps.firstPartyUrl(packageName)
  if (identity.source === "url") return identity.sourceUrl
  return undefined
}

interface Backoff {
  failures: number
  nextAttemptAt: number
}

/** A validated `miniapp.json`, kept with its ETag so a 304 can be evaluated again. */
interface CachedManifest {
  etag: string
  url: string
  manifest: HostedMiniappManifest
}

export class MiniappUrlUpdater {
  private readonly manifests = new Map<string, CachedManifest>()
  private readonly backoff = new Map<string, Backoff>()
  private readonly lastCheckedAt = new Map<string, number>()
  private readonly inFlight = new Map<string, {session: number; check: Promise<void>}>()

  constructor(private readonly deps: MiniappUrlUpdaterDependencies) {}

  /** The URL an installed release updates from, or undefined when nothing updates it automatically. */
  updateUrlFor(packageName: string, identity: MiniappReleaseIdentity | null): string | undefined {
    return miniappUpdateUrl(packageName, identity, this.deps)
  }

  /** Check every installed miniapp, one at a time. A pass ends with its engine session. */
  async checkAll(): Promise<void> {
    const session = this.deps.installSession()
    const packages = await this.deps.installedPackages()
    for (const packageName of packages) {
      if (this.deps.installSession() !== session) return
      await this.check(packageName, session)
    }
  }

  /** Check a miniapp the user just opened, unless it was checked moments ago. */
  checkOpened(packageName: string): Promise<void> {
    const last = this.lastCheckedAt.get(packageName)
    if (last !== undefined && this.deps.now() - last < OPEN_CHECK_INTERVAL_MS) return Promise.resolve()
    return this.check(packageName)
  }

  /** Check one miniapp. Checks of it during the same engine session share one request. */
  check(packageName: string, session = this.deps.installSession()): Promise<void> {
    const running = this.inFlight.get(packageName)
    if (running?.session === session) return running.check
    const entry = {session, check: Promise.resolve()}
    entry.check = this.run(packageName, session).finally(() => {
      if (this.inFlight.get(packageName) === entry) this.inFlight.delete(packageName)
    })
    this.inFlight.set(packageName, entry)
    return entry.check
  }

  private async run(packageName: string, session: number): Promise<void> {
    // An install started in an ended session must not activate.
    const isCancelled = () => this.deps.installSession() !== session
    if (isCancelled()) return
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
    const cached = this.manifests.get(manifestUrl)
    let result: ManifestFetchResult
    try {
      result = await this.deps.fetchManifest(manifestUrl, cached?.etag)
    } catch (error) {
      this.fail(packageName, `could not fetch ${manifestUrl}`, error)
      return
    }
    // A 304 is the manifest seen before. Its release is evaluated again: it may
    // have waited for the miniapp to stop, failed, or needed hardware since added.
    let served: {url: string; manifest: HostedMiniappManifest}
    if (result.status === 304 && cached) {
      served = cached
    } else {
      if (result.status < 200 || result.status >= 300 || result.body === undefined) {
        this.fail(packageName, `${manifestUrl} answered ${result.status}`, undefined, result.retryAfterMs)
        return
      }
      if (!isPackageNameAllowedForUrl(packageName, result.url)) {
        this.fail(packageName, `${manifestUrl} redirected to ${result.url}, which can't serve ${packageName}`)
        return
      }
      try {
        served = {url: result.url, manifest: parseHostedManifest(result.body, packageName)}
      } catch (error) {
        this.fail(packageName, `${manifestUrl} is not a valid miniapp.json`, error)
        return
      }
      if (result.etag) this.manifests.set(manifestUrl, {etag: result.etag, ...served})
      else this.manifests.delete(manifestUrl)
    }
    const {manifest} = served
    // Failures stay counted until there is nothing left to install.
    if (!semver.gt(manifest.version, version)) {
      this.backoff.delete(packageName)
      return
    }

    const policy = this.deps.compatibilityPolicy()
    if (!policy) return
    const compatibility = checkMiniappInstallCompatibility(manifest, policy)
    if (!compatibility.compatible) {
      this.deps.log(`${packageName}@${manifest.version} is not compatible with this phone: ${compatibility.reason}`)
      this.backoff.delete(packageName)
      return
    }

    let bundleUrl: string
    try {
      const resolved = new URL(manifest.bundle.url, served.url)
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
        isCancelled,
        beforeActivate: () => {
          if (this.deps.hasDevelopmentSelection(packageName)) {
            throw new Error(`${packageName} uses a manually selected build`)
          }
        },
        releaseIdentity: {source: "url", sourceUrl, bundleSha256: manifest.bundle.sha256},
      })
    } catch (error) {
      // The session ended: the next session checks again.
      if (isCancelled()) return
      // A running miniapp's update waits for it to stop, or for the user's answer.
      if (this.deps.isRunningError(error)) return
      this.fail(packageName, `could not install ${packageName}@${manifest.version}`, error)
      return
    }
    this.backoff.delete(packageName)
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
