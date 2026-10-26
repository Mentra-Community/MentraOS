/**
 * Automatic updates from each installed miniapp's own URL.
 *
 * A miniapp URL serves `miniapp.json`: a copy of the manifest inside the
 * miniapp's current ZIP, plus `bundle: {url, sha256}` naming that ZIP. The
 * engine checks each installed miniapp's URL and hands a newer release to the
 * shared installer, which binds it to the package and version, verifies the
 * hash, and applies the signer and version rules. Mentra's own bundled
 * miniapps update from `<firstPartyMiniappsUrl><packageName>/`.
 *
 * Each check:
 * 1. Refreshes the registry status of every installed URL once the cached answer has expired: one batch call to Core,
 *    kept (`miniapp_registry_status:v1`) for as long as Core says. If Core can't be reached, the check carries on
 *    with what is cached. An archived URL is never updated, or even fetched; its installed copy keeps running.
 * 2. Makes one conditional request for `miniapp.json`, answering a sign-in challenge for that package only.
 *    Redirects come back to the updater instead of being followed:
 *    - a permanent one (`301`, `308`) to `<url>miniapp.json` on the same registrable domain moves the miniapp: its
 *      release records the new URL, which is registered, and it updates from there;
 *    - a temporary one within the domain is followed for this check only;
 *    - one to another domain, or away from HTTPS, is a failure.
 * 3. Hands a newer release the phone can run to the shared installer, downloading the ZIP with the same challenge
 *    rule.
 */
import {
  MINIAPP_REGISTRY_STATUS_MAX_ENTRIES,
  type MiniappRegistryUrlStatus,
  type RegistryRegisterRequest,
  type RegistryRegisterResponse,
  type RegistryStatusRequest,
  type RegistryStatusResponse,
} from "@mentra/cloud-protocol/miniapp-registry"
import {
  normalizeMiniappUrl,
  registrableDomain,
  ServedMiniappManifestSchema,
  type MiniappAgeRating,
} from "@mentra/cloud-protocol/miniapp-url"
import semver from "semver"

import {isPackageNameAllowedForUrl} from "./miniappDomainRule"
import type {MiniappJsonResult} from "./miniappFetch"
import {checkMiniappRunsOnPhone, type MiniappVersionPolicy} from "./miniappInstallCompatibility"
import type {InstallableReleaseIdentity, MiniappReleaseIdentity} from "./AppRegistry"
import type {ReleaseInstallOptions} from "./miniappReleaseInstall"

/** A newly opened miniapp is checked again only after this long. */
export const OPEN_CHECK_INTERVAL_MS = 60_000
/** Failed checks back off from this delay, doubling up to {@link MAX_BACKOFF_MS}. */
export const BASE_BACKOFF_MS = 5 * 60_000
export const MAX_BACKOFF_MS = 6 * 60 * 60_000
/** Where the last registry status answer is kept. */
export const REGISTRY_STATUS_KEY = "miniapp_registry_status:v1"
/** After a status call fails, the next waits this long. */
export const REGISTRY_STATUS_RETRY_MS = 5 * 60_000
/** The longest a status answer is kept, whatever Core says. */
export const MAX_REGISTRY_STATUS_TTL_SECONDS = 7 * 24 * 60 * 60
/** The most redirects one check follows, as Core's fetcher. */
export const MAX_MANIFEST_REDIRECTS = 3

export interface HostedMiniappManifest {
  packageName: string
  version: string
  name: string
  ageRating?: MiniappAgeRating
  minHostVersion?: string
  sdkVersion?: string
  hardwareRequirements?: unknown
  bundle: {url: string; sha256: string}
}

/** What a `miniapp.json` request answered (`fetchMiniappJson` in `miniappFetch.ts`). */
export type ManifestFetchResult = MiniappJsonResult

/** Where the status answer persists: an MMKV instance logout leaves alone, so an archived URL stays archived. */
export interface RegistryStatusStore {
  get(): string | undefined
  set(value: string): void
}

export interface MiniappUrlUpdaterDependencies {
  installedPackages(): Promise<string[]>
  activeVersion(packageName: string): Promise<string | undefined>
  releaseIdentity(packageName: string, version: string): MiniappReleaseIdentity | null
  isSystemPackage(packageName: string): boolean
  /** `<firstPartyMiniappsUrl><packageName>/` for a bundled package, or undefined. */
  firstPartyUrl(packageName: string): string | undefined
  hasDevelopmentSelection(packageName: string): boolean
  compatibilityPolicy(): MiniappVersionPolicy | null
  /**
   * `miniapp.json`, conditional on `etag`, answering a sign-in challenge for `packageName` only, and answering a
   * redirect with its `location` instead of following it (`fetchMiniappJson` with `redirect: "manual"`). Throws
   * `MiniappFetchError` when nothing usable answered or the challenge can't be answered.
   */
  fetchManifest(url: string, options: {etag?: string; packageName: string}): Promise<ManifestFetchResult>
  /** The ZIP, checked against its SHA-256, answering a sign-in challenge for `packageName` only. */
  fetchBundle(url: string, options: {packageName: string; sha256: string; onChallenge: () => void}): Promise<Uint8Array>
  install(bundleUrl: string, options: ReleaseInstallOptions): Promise<void>
  /** Keep only these versions of the package (the new release and the one it replaced). */
  keepVersions(packageName: string, versions: string[]): Promise<void>
  isRunningError(error: unknown): boolean
  /** Changes when the engine session ends; an update started before then must not activate. */
  installSession(): number
  /** The engine's `requireRegistry`. Off, nothing calls the registry and no URL counts as archived. */
  requireRegistry(): boolean
  /** The Core in use, whose registry answers, or null without one. An answer kept from another Core is not used. */
  registryCore(): string | null
  /**
   * `POST /api/client/registry/status` to `core`'s registry and only to it. Null, asking nothing, when no client
   * speaks for that Core right now (it isn't built yet, or the deployment is switching). Rejects when Core can't be
   * reached or refuses the call.
   */
  registryStatus(core: string, request: RegistryStatusRequest): Promise<RegistryStatusResponse | null>
  /** `POST /api/client/registry/register`, for the URL a miniapp moved to. Rejects like `registryStatus`. */
  register(request: RegistryRegisterRequest): Promise<RegistryRegisterResponse>
  statusStore: RegistryStatusStore
  /** Record that a `url` release now updates from `sourceUrl`; false when it no longer records `fromUrl`. */
  setReleaseSourceUrl(packageName: string, version: string, fromUrl: string, sourceUrl: string): boolean
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
    name: manifest.name,
    ...(manifest.ageRating ? {ageRating: manifest.ageRating} : {}),
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
  return updateSource(packageName, identity, deps)?.url
}

/** Where a release updates from, and whether that URL is the release's own (`sourceUrl`), which a move may change. */
function updateSource(
  packageName: string,
  identity: MiniappReleaseIdentity | null,
  deps: Pick<MiniappUrlUpdaterDependencies, "isSystemPackage" | "firstPartyUrl">,
): {url: string; recorded: boolean} | undefined {
  if (!identity) return undefined
  const firstParty =
    identity.source === "url" ||
    identity.source === "bundled_asset" ||
    identity.source === "preinstalled_registry" ||
    identity.source === "system_store"
  if (firstParty && deps.isSystemPackage(packageName)) {
    const url = deps.firstPartyUrl(packageName)
    return url ? {url, recorded: false} : undefined
  }
  if (identity.source === "url" && identity.sourceUrl) return {url: identity.sourceUrl, recorded: true}
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
  /** Its server asked for sign-in. */
  private: boolean
}

/** Core's last status answer, as kept in {@link REGISTRY_STATUS_KEY}. */
interface StoredRegistryStatus {
  /** The Core that answered. */
  core: string
  fetchedAt: number
  validForSeconds: number
  /** By normalized miniapp URL. */
  statuses: Record<string, MiniappRegistryUrlStatus>
}

const PERMANENT_REDIRECTS = new Set([301, 308])

export class MiniappUrlUpdater {
  private readonly manifests = new Map<string, CachedManifest>()
  private readonly backoff = new Map<string, Backoff>()
  private readonly lastCheckedAt = new Map<string, number>()
  private readonly inFlight = new Map<string, {session: number; check: Promise<void>}>()
  /** The kept status answer: undefined until read. */
  private status: StoredRegistryStatus | null | undefined
  /** The refresh in flight, and the Core it asks. */
  private statusRefresh: {core: string; done: Promise<void>} | null = null
  /** After a failed refresh, when that Core may be asked again. */
  private statusRetry: {core: string; at: number} | null = null

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
    const source = updateSource(packageName, this.deps.releaseIdentity(packageName, version), this.deps)
    if (!source || !isPackageNameAllowedForUrl(packageName, source.url)) return
    let sourceUrl = source.url

    await this.refreshRegistryStatus()
    if (isCancelled()) return
    if (this.isArchived(sourceUrl)) {
      this.deps.log(`${packageName}: ${sourceUrl} is archived, so it doesn't update`)
      return
    }

    this.lastCheckedAt.set(packageName, now)
    const manifestUrl = new URL("miniapp.json", sourceUrl).href
    const domain = hostDomain(sourceUrl)
    let requestUrl = manifestUrl
    // The URL the miniapp moved to: set while every redirect so far was a permanent move to a miniapp URL.
    let movedTo: string | undefined
    let moving = source.recorded
    let result: ManifestFetchResult
    for (let redirects = 0; ; redirects++) {
      try {
        result = await this.deps.fetchManifest(requestUrl, {etag: this.manifests.get(requestUrl)?.etag, packageName})
      } catch (error) {
        this.fail(packageName, `could not fetch ${requestUrl}`, error)
        return
      }
      if (result.location === undefined) break
      const target = result.location
      if (redirects >= MAX_MANIFEST_REDIRECTS) {
        this.fail(packageName, `${manifestUrl} redirected more than ${MAX_MANIFEST_REDIRECTS} times`)
        return
      }
      if (!domain || hostDomain(target) !== domain || !isPackageNameAllowedForUrl(packageName, target)) {
        this.fail(packageName, `${requestUrl} redirected to ${target}, which isn't an HTTPS URL on ${domain}`)
        return
      }
      // A redirect doesn't reach around an archive: it must not lead into an archived miniapp URL.
      if (this.leadsIntoArchived(target)) {
        this.fail(packageName, `${requestUrl} redirected to ${target}, which is archived`)
        return
      }
      const moved = moving && PERMANENT_REDIRECTS.has(result.status) ? miniappUrlOf(target) : null
      if (moved) movedTo = moved
      else moving = false
      requestUrl = target
    }
    if (isCancelled()) return

    // A 304 is the manifest seen before. Its release is evaluated again: it may
    // have waited for the miniapp to stop, failed, or needed a newer Mentra App than this phone had.
    const cached = this.manifests.get(requestUrl)
    let served: {url: string; manifest: HostedMiniappManifest; private: boolean}
    if (result.status === 304 && cached) {
      // A server that asks for sign-in now makes the release private, whatever it served before.
      if (result.challenge && !cached.private) cached.private = true
      served = cached
    } else {
      if (result.status < 200 || result.status >= 300 || result.body === undefined) {
        // A challenge answered with a token the server then refused: its access ended, so updates stop.
        const refused = result.challenge && (result.status === 401 || result.status === 403)
        const answered = refused ? `refused the token for ${packageName}` : `answered ${result.status}`
        this.fail(packageName, `${requestUrl} ${answered}`, undefined, result.retryAfterMs)
        return
      }
      if (!isPackageNameAllowedForUrl(packageName, result.url)) {
        this.fail(packageName, `${requestUrl} was served from ${result.url}, which can't serve ${packageName}`)
        return
      }
      try {
        served = {
          url: result.url,
          manifest: parseHostedManifest(result.body, packageName),
          private: Boolean(result.challenge),
        }
      } catch (error) {
        this.fail(packageName, `${requestUrl} is not a valid miniapp.json`, error)
        return
      }
      if (result.etag) this.manifests.set(requestUrl, {etag: result.etag, ...served})
      else this.manifests.delete(requestUrl)
    }
    const {manifest} = served

    if (movedTo && movedTo !== sourceUrl) {
      if (!(await this.recordMove(packageName, version, sourceUrl, movedTo, manifest))) return
      if (isCancelled()) return
      sourceUrl = movedTo
    }

    // Failures stay counted until there is nothing left to install.
    if (!semver.gt(manifest.version, version)) {
      this.backoff.delete(packageName)
      return
    }

    const policy = this.deps.compatibilityPolicy()
    if (!policy) return
    const compatibility = checkMiniappRunsOnPhone(manifest, policy)
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
      this.fail(packageName, `${requestUrl} names an unusable bundle URL`, error)
      return
    }

    // The installer reads the identity after the download, so a ZIP whose server alone asked for sign-in is recorded
    // as private too.
    const releaseIdentity: InstallableReleaseIdentity = {
      source: "url",
      sourceUrl,
      bundleSha256: manifest.bundle.sha256,
      ...(served.private ? {private: true} : {}),
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
        downloadBundle: (url) =>
          this.deps.fetchBundle(url, {
            packageName,
            sha256: manifest.bundle.sha256,
            onChallenge: () => {
              releaseIdentity.private = true
            },
          }),
        releaseIdentity,
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

  /**
   * The miniapp moved to `movedTo`: register the new URL, then record it on the installed release. False, after
   * counting a failure, when Core answers that the new URL is archived or isn't a miniapp. Core not answering doesn't
   * stop the move, as it doesn't stop an install.
   */
  private async recordMove(
    packageName: string,
    version: string,
    fromUrl: string,
    movedTo: string,
    manifest: HostedMiniappManifest,
  ): Promise<boolean> {
    if (this.deps.requireRegistry()) {
      let answer: RegistryRegisterResponse | undefined
      try {
        answer = await this.deps.register({
          url: movedTo,
          reported: {
            packageName,
            name: manifest.name,
            version: manifest.version,
            ...(manifest.ageRating ? {ageRating: manifest.ageRating} : {}),
          },
        })
      } catch (error) {
        this.deps.warn(`Could not register ${movedTo}, where ${packageName} moved; moving it anyway`, error)
      }
      if (answer?.result === "archived" || answer?.result === "not_a_miniapp") {
        const why = answer.result === "archived" ? "is archived" : `is not a miniapp (${answer.reason})`
        this.fail(packageName, `${fromUrl} moved to ${movedTo}, which Core says ${why}`)
        return false
      }
    }
    try {
      if (this.deps.setReleaseSourceUrl(packageName, version, fromUrl, movedTo)) {
        this.deps.log(`${packageName} moved from ${fromUrl} to ${movedTo}`)
      }
    } catch (error) {
      this.deps.warn(`Could not record that ${packageName} moved to ${movedTo}`, error)
    }
    return true
  }

  /** Whether Core's last answer, from the Core in use, archives this URL. */
  private isArchived(url: string): boolean {
    if (!this.deps.requireRegistry()) return false
    const status = this.currentStatus()
    const key = normalizeMiniappUrl(url)?.url
    return Boolean(status && key && status.statuses[key] === "archived")
  }

  /**
   * Whether a redirect target lies in an archived miniapp URL: is it, is it without its final `/`, or is under it,
   * whatever shape the target's path has (`/v2`, `/v2/`, `/v2/miniapp.json`). The target is spelled the way the
   * registry's URLs are (`normalizeMiniappUrl`: case, default port, a host's final dot); one that can't be is refused.
   */
  private leadsIntoArchived(target: string): boolean {
    if (!this.deps.requireRegistry()) return false
    const status = this.currentStatus()
    if (!status) return false
    const within = redirectScope(target)
    if (!within) return true
    return Object.entries(status.statuses).some(([url, verdict]) => verdict === "archived" && within.startsWith(url))
  }

  /** The kept answer, if the Core in use gave it. */
  private currentStatus(): StoredRegistryStatus | null {
    if (this.status === undefined) this.status = readStoredStatus(this.deps.statusStore)
    const core = this.deps.registryCore()
    return this.status && core && this.status.core === core ? this.status : null
  }

  /** Step 1: refresh the status of every installed URL once the kept answer has expired. Never throws. */
  private refreshRegistryStatus(): Promise<void> {
    try {
      if (!this.deps.requireRegistry()) return Promise.resolve()
      const core = this.deps.registryCore()
      if (!core) return Promise.resolve()
      if (this.statusRefresh?.core === core) return this.statusRefresh.done
      const now = this.deps.now()
      const status = this.currentStatus()
      if (status && !statusExpired(status, now)) return Promise.resolve()
      if (this.statusRetry?.core === core && now < this.statusRetry.at) return Promise.resolve()
      const done = this.fetchRegistryStatus(core).finally(() => {
        if (this.statusRefresh?.done === done) this.statusRefresh = null
      })
      this.statusRefresh = {core, done}
      return done
    } catch (error) {
      this.deps.warn("Could not refresh the miniapp registry status", error)
      return Promise.resolve()
    }
  }

  /**
   * One refresh, bound to one Core: every batch asks `core`, and the answer is kept only if `core` is still the Core
   * in use once every batch has answered. A switch on the way discards it, and costs the new Core no wait.
   */
  private async fetchRegistryStatus(core: string): Promise<void> {
    const stillCurrent = () => this.deps.registryCore() === core
    try {
      const entries = await this.installedUrls()
      if (entries.length === 0) return
      const statuses: Record<string, MiniappRegistryUrlStatus> = {}
      let validForSeconds = MAX_REGISTRY_STATUS_TTL_SECONDS
      for (let start = 0; start < entries.length; start += MINIAPP_REGISTRY_STATUS_MAX_ENTRIES) {
        if (!stillCurrent()) return
        const batch = entries.slice(start, start + MINIAPP_REGISTRY_STATUS_MAX_ENTRIES)
        const answer = await this.deps.registryStatus(core, {entries: batch})
        // No client speaks for this Core now: nothing was asked, so nothing is kept and nothing waits.
        if (!answer) return
        batch.forEach((entry, index) => {
          const status = answer.statuses[index]?.status
          if (status === "active" || status === "archived" || status === "unknown") statuses[entry.url] = status
        })
        validForSeconds = Math.min(validForSeconds, answer.validForSeconds)
      }
      if (!stillCurrent()) return
      const stored: StoredRegistryStatus = {core, fetchedAt: this.deps.now(), validForSeconds, statuses}
      this.status = stored
      if (this.statusRetry?.core === core) this.statusRetry = null
      try {
        this.deps.statusStore.set(JSON.stringify(stored))
      } catch (error) {
        this.deps.warn("Could not keep the miniapp registry status", error)
      }
    } catch (error) {
      // Core can't be reached, or refused: carry on with what is kept, and ask that Core again later.
      if (stillCurrent()) this.statusRetry = {core, at: this.deps.now() + REGISTRY_STATUS_RETRY_MS}
      this.deps.warn("Could not refresh the miniapp registry status; using the last answer", error)
    }
  }

  /** Every installed miniapp URL with its installed version, once each. */
  private async installedUrls(): Promise<Array<{url: string; version: string}>> {
    const byUrl = new Map<string, string>()
    for (const packageName of await this.deps.installedPackages()) {
      const version = await this.deps.activeVersion(packageName)
      if (!version || !semver.valid(version)) continue
      const url = this.updateUrlFor(packageName, this.deps.releaseIdentity(packageName, version))
      const normalized = url ? normalizeMiniappUrl(url) : null
      if (normalized?.kind === "public" && !byUrl.has(normalized.url)) byUrl.set(normalized.url, version)
    }
    return [...byUrl].map(([url, version]) => ({url, version}))
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

/**
 * A redirect target as the miniapp URL it reads like, spelled as registry URLs are: its path with a final `/`, and no
 * query or fragment. Null when it can't be spelled that way.
 */
function redirectScope(target: string): string | null {
  try {
    const parsed = new URL(target)
    const path = parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`
    return normalizeMiniappUrl(`${parsed.protocol}//${parsed.host}${path}`)?.url ?? null
  } catch {
    return null
  }
}

/** An HTTPS URL's registrable domain, or null. */
function hostDomain(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" ? registrableDomain(parsed.hostname) : null
  } catch {
    return null
  }
}

/** The miniapp URL a redirect names: `<url>miniapp.json`, with no query or fragment, is `<url>`. */
function miniappUrlOf(target: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return null
  }
  if (parsed.search || parsed.hash || !parsed.pathname.endsWith("/miniapp.json")) return null
  const normalized = normalizeMiniappUrl(new URL("./", parsed).href)
  return normalized?.kind === "public" ? normalized.url : null
}

function statusExpired(status: StoredRegistryStatus, now: number): boolean {
  const ttlMs = Math.min(status.validForSeconds, MAX_REGISTRY_STATUS_TTL_SECONDS) * 1000
  // A clock that went back can't make an answer last longer.
  return now < status.fetchedAt || now - status.fetchedAt >= ttlMs
}

function readStoredStatus(store: RegistryStatusStore): StoredRegistryStatus | null {
  try {
    const raw = store.get()
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<StoredRegistryStatus> | null
    if (
      !value ||
      typeof value.core !== "string" ||
      typeof value.fetchedAt !== "number" ||
      typeof value.validForSeconds !== "number" ||
      !value.statuses ||
      typeof value.statuses !== "object"
    ) {
      return null
    }
    return value as StoredRegistryStatus
  } catch {
    return null
  }
}
