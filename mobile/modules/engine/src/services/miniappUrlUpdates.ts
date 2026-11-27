/**
 * Automatic updates from each installed miniapp's own URL.
 *
 * A miniapp URL serves `miniapp.json`: a copy of the manifest inside the
 * miniapp's current ZIP, plus `bundle: {url, sha256}` naming that ZIP. The
 * engine checks each installed miniapp's URL and, when it serves another
 * build than the one installed, hands that build to the shared installer,
 * which binds it to the package and version, verifies the hash, and applies
 * the signer rule. Mentra's own system miniapps update from
 * `<firstPartyMiniappsUrl><packageName>/`.
 *
 * The update rule ({@link isServedBuildInstalled}): the served `bundle.sha256`
 * differs from the installed build's. Versions are never compared, so new
 * bytes under an unchanged version update, and a lower version rolls back.
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
 * 3. Hands another build the phone can run to the shared installer, downloading the ZIP with the same challenge
 *    rule. An idle miniapp updates silently. A running one is asked about when the release would start with the
 *    glasses paired now (the installer checks again right before asking); otherwise it updates once it stops.
 *
 * A miniapp that is about to start waits for its check first (`checkBeforeStart`), within {@link START_UPDATE_LIMITS},
 * so that another build installs while it is still stopped and nothing is asked once it runs.
 *
 * A local address (`localhost`, a private address or a `.local` name: a developer's computer, as `mentra dev` serves
 * it) updates a development build by the same rule, with its own (`runLocal`): HTTP is allowed; there is no domain
 * rule, registry or sign-in; a redirect must stay on the local network; the request has {@link LOCAL_CHECK_TIMEOUT_MS};
 * and another build installs and restarts the miniapp without asking. It is never checked by a pass, which would ask a
 * developer's address on every network the phone joins: only when the miniapp starts, and when `mentra dev`'s console
 * connection opens or signals a new build (`checkNow`). Those checks skip neither for the minute rule nor for the
 * failure backoff, so a restarted `mentra dev` is seen at once.
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
  isLocalNetworkHost,
  normalizeMiniappUrl,
  registrableDomain,
  ServedMiniappManifestSchema,
  type MiniappAgeRating,
  type MiniappBuild,
} from "@mentra/cloud-protocol/miniapp-url"
import semver from "semver"

import {isPackageNameAllowedForUrl} from "./miniappDomainRule"
import type {MiniappJsonResult} from "./miniappFetch"
import {checkMiniappRunsOnPhone, type MiniappVersionPolicy} from "./miniappInstallCompatibility"
import {isServedBuildInstalled} from "./miniappInstallIdentity"
import {selectInstallTarget} from "./miniappInstallTarget"
import type {MiniappPinReader} from "./miniappPins"
import type {InstallableReleaseIdentity, MiniappReleaseIdentity} from "./AppRegistry"
import type {LocalBuildInstall} from "./localBuildInstall"
import type {ReleaseInstallOptions} from "./miniappReleaseInstall"

/** A miniapp checked less than this long ago starts without waiting for another check. */
export const OPEN_CHECK_INTERVAL_MS = 60_000
/**
 * How long a miniapp that is about to start waits for its check: `checkMs` to learn whether its URL serves another
 * build, and once it does, `installMs` more for that build to install. Two limits, because they fail differently: a
 * host that doesn't answer costs `checkMs` at most, while a download that started is worth waiting for.
 */
export const START_UPDATE_LIMITS = {checkMs: 5_000, installMs: 30_000}
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
/**
 * How long a local address may take to answer for `miniapp.json`. A developer's computer on the same network answers
 * at once or not at all, and a start waits for this check.
 */
export const LOCAL_CHECK_TIMEOUT_MS = 3_000

export interface HostedMiniappManifest {
  packageName: string
  version: string
  name: string
  ageRating?: MiniappAgeRating
  minHostVersion?: string
  minApiLevel?: number
  hardwareRequirements?: unknown
  bundle: {url: string; sha256: string}
  /** `development.reload`, as served: a local build's console connection, read with {@link developmentReloadUrl}. */
  reload?: string
  /** The versions a pin may hold the miniapp to (`ServedMiniappManifest.versions`). */
  versions?: MiniappBuild[]
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
  /** `<firstPartyMiniappsUrl><packageName>/` for a system package, or undefined. */
  firstPartyUrl(packageName: string): string | undefined
  /**
   * A development build is installed for the package (`AppRegistry.isDevelopmentBuild`): only the person replaces it,
   * so its release isn't updated meanwhile.
   */
  isDevelopmentBuild(packageName: string): boolean
  /** The deployment allows development builds of the package (`isDevMiniappAllowed`). */
  developmentAllowed(packageName: string): boolean
  /** The pin that holds the package to one version, or null for latest (`miniappPins`). */
  pinFor: MiniappPinReader
  compatibilityPolicy(): MiniappVersionPolicy | null
  /** Whether a release declaring these `hardwareRequirements` would pass the launch gate with the glasses paired now. */
  launchesWithPairedGlasses(hardwareRequirements: unknown, packageName: string): boolean
  /**
   * `miniapp.json`, conditional on `etag`, answering a sign-in challenge for `packageName` only, and answering a
   * redirect with its `location` instead of following it (`fetchMiniappJson` with `redirect: "manual"`). Throws
   * `MiniappFetchError` when nothing usable answered or the challenge can't be answered. With `local`, a challenge
   * comes back unanswered and the request has {@link LOCAL_CHECK_TIMEOUT_MS}.
   */
  fetchManifest(url: string, options: {etag?: string; packageName: string; local?: boolean}): Promise<ManifestFetchResult>
  /**
   * The ZIP, checked against its SHA-256, answering a sign-in challenge for `packageName` only; with `local`, never
   * answering one.
   */
  fetchBundle(
    url: string,
    options: {packageName: string; sha256: string; onChallenge: () => void; local?: boolean},
  ): Promise<Uint8Array>
  install(bundleUrl: string, options: ReleaseInstallOptions): Promise<void>
  /** Install a local build, never asking, restarting the miniapp if it runs (`installLocalBuild`). */
  installLocal(bundleUrl: string, install: LocalBuildInstall): Promise<void>
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
  /**
   * Timers for the limits a start waits within. They must also fire while the Mentra App is in the background,
   * where a miniapp can start too (from the glasses' menu, or another miniapp).
   */
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
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
    minApiLevel: manifest.minApiLevel,
    hardwareRequirements: manifest.hardwareRequirements,
    bundle: {url: manifest.bundle.url.trim(), sha256: manifest.bundle.sha256},
    ...(manifest.versions ? {versions: manifest.versions} : {}),
    ...(servedReload(raw) ? {reload: servedReload(raw)} : {}),
  }
}

/** The `development.reload` a served `miniapp.json` names, as served. */
export function servedReload(manifest: unknown): string | undefined {
  const development = (manifest as {development?: unknown} | null)?.development
  if (!development || typeof development !== "object" || Array.isArray(development)) return undefined
  const reload = (development as {reload?: unknown}).reload
  return typeof reload === "string" && reload.trim() ? reload.trim() : undefined
}

/**
 * The console connection a local build's `miniapp.json` names in `development.reload` (as `mentra dev` serves it),
 * resolved against where it was served from: a WebSocket URL on the local network, which the phone forwards the
 * miniapp's logs to and hears of new builds from. Undefined when it names none, or one off the local network.
 */
export function developmentReloadUrl(reload: string | undefined, servedFrom: string): string | undefined {
  if (!reload) return undefined
  try {
    const parsed = new URL(reload, servedFrom)
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return undefined
    return isLocalNetworkHost(parsed.hostname) ? parsed.href : undefined
  } catch {
    return undefined
  }
}

/**
 * The URL an installed release updates from, or undefined when nothing updates it automatically. A system package
 * installed from a Mentra host (or bundled before 3.5) updates from the host this build or workspace names, so it follows the deployment;
 * none, no updates.
 */
export function miniappUpdateUrl(
  packageName: string,
  identity: MiniappReleaseIdentity | null,
  deps: Pick<MiniappUrlUpdaterDependencies, "isSystemPackage" | "firstPartyUrl">,
): string | undefined {
  return updateSource(packageName, identity, deps)?.url
}

/**
 * Where a release updates from, whether that URL is the release's own (`sourceUrl`), which a move may change, and
 * whether it is a local build's address, which updates by `runLocal`.
 */
function updateSource(
  packageName: string,
  identity: MiniappReleaseIdentity | null,
  deps: Pick<MiniappUrlUpdaterDependencies, "isSystemPackage" | "firstPartyUrl">,
): {url: string; recorded: boolean; local?: true} | undefined {
  if (!identity) return undefined
  // A local build updates from its own address only, whatever package it claims: even a system package's name.
  if (identity.source === "local") {
    return identity.sourceUrl && isLocalAddress(identity.sourceUrl)
      ? {url: identity.sourceUrl, recorded: false, local: true}
      : undefined
  }
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

/**
 * A check asks about a running miniapp's update when its restart can succeed; after Not now it asks again only once
 * the miniapp is opened. A miniapp that isn't running is never asked about: its update installs, on any check and
 * before it starts ({@link checkBeforeStart}).
 */
export class MiniappUrlUpdater {
  private readonly manifests = new Map<string, CachedManifest>()
  private readonly backoff = new Map<string, Backoff>()
  private readonly lastCheckedAt = new Map<string, number>()
  /** The miniapps a start is waiting on a check for ({@link checkBeforeStart}), with how many starts wait. */
  private readonly starting = new Map<string, number>()
  /** The miniapps whose update waits for them to stop, or for the person's answer. */
  private readonly waitingToUpdate = new Set<string>()
  /** A check of a local build asked for while one ran ({@link checkNow}): it runs once that one is done. */
  private readonly checkAgain = new Map<string, Promise<void>>()
  /**
   * Each check in flight, `asking`: settled once it waits for the person's answer to its update prompt, and
   * `installing`: settled once it found another build and starts installing it.
   */
  private readonly inFlight = new Map<
    string,
    {session: number; check: Promise<void>; asking: Promise<void>; installing: Promise<void>}
  >()
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

  /**
   * Check every installed miniapp, one at a time, except local builds: a pass never asks a developer's address. A
   * pass ends with its engine session, and moves on from a check that waits for the person's answer. Miniapps whose
   * update waited for them come first: one of them stopping, or being opened again after Not now, is what asks for a
   * pass between the timed ones.
   */
  async checkAll(): Promise<void> {
    const session = this.deps.installSession()
    const installed = await this.deps.installedPackages()
    const packages = [
      ...installed.filter((packageName) => this.waitingToUpdate.has(packageName)),
      ...installed.filter((packageName) => !this.waitingToUpdate.has(packageName)),
    ]
    for (const packageName of packages) {
      if (this.deps.installSession() !== session) return
      if (await this.updatesFromLocalAddress(packageName)) continue
      const entry = this.start(packageName, session)
      await Promise.race([entry.check, entry.asking])
    }
  }

  /**
   * Check a miniapp that is about to start, so that another build installs while it is stopped, silently, rather
   * than once it runs, behind an update prompt. Resolves when the check is done; after `checkMs` when it hasn't found
   * one by then (offline, a slow host); or, once it found one (`onInstalling` is then called), after `installMs` more
   * at most. A check still going on then carries on, as any check does.
   *
   * It resolves at once when there is nothing to learn: the miniapp was checked within the last minute, or its last
   * check failed and its retry time hasn't come, so a host that is down doesn't cost `checkMs` on every start. A check
   * already under way is joined, whichever of the two it is.
   */
  async checkBeforeStart(
    packageName: string,
    limits: {checkMs: number; installMs: number} = START_UPDATE_LIMITS,
    onInstalling?: () => void,
  ): Promise<void> {
    const session = this.deps.installSession()
    if (await this.updatesFromLocalAddress(packageName)) {
      // A local build is checked on every start: the developer's computer may be back, with another build.
      this.forgetChecks(packageName)
    } else if (this.inFlight.get(packageName)?.session !== session && this.checkedLately(packageName)) {
      return
    }
    this.starting.set(packageName, (this.starting.get(packageName) ?? 0) + 1)
    try {
      const entry = this.start(packageName, session)
      const done = entry.check.then(
        () => "done" as const,
        () => "done" as const,
      )
      const found = await this.within(limits.checkMs, [done, entry.installing.then(() => "installing" as const)])
      if (found !== "installing") return
      onInstalling?.()
      await this.within(limits.installMs, [done])
    } finally {
      const others = (this.starting.get(packageName) ?? 1) - 1
      if (others > 0) this.starting.set(packageName, others)
      else this.starting.delete(packageName)
    }
  }

  /** The first of `outcomes` to settle, or "timeout" after `ms`. */
  private async within<T>(ms: number, outcomes: Promise<T>[]): Promise<T | "timeout"> {
    let timer: unknown
    const timeout = new Promise<"timeout">((resolve) => {
      timer = this.deps.setTimeout(() => resolve("timeout"), ms)
    })
    try {
      return await Promise.race([...outcomes, timeout])
    } finally {
      this.deps.clearTimeout(timer)
    }
  }

  /**
   * Whether a check now has nothing to tell a start: one was made within the last minute, or the last one failed and
   * its retry time hasn't come.
   */
  private checkedLately(packageName: string): boolean {
    const now = this.deps.now()
    const last = this.lastCheckedAt.get(packageName)
    if (last !== undefined && now - last < OPEN_CHECK_INTERVAL_MS) return true
    const waiting = this.backoff.get(packageName)
    return waiting !== undefined && waiting.nextAttemptAt > now
  }

  /** Check one miniapp. Checks of it during the same engine session share one request. */
  check(packageName: string, session = this.deps.installSession()): Promise<void> {
    return this.start(packageName, session).check
  }

  /**
   * Check one miniapp now: `mentra dev`'s console connection opened, or it says a new build is ready. For a local
   * build the minute rule and the failure backoff don't apply, and a check already under way is followed by one more,
   * since it may have read the address before this build was ready; several asked for meanwhile share that one. A
   * miniapp of any other source is checked as {@link check} does.
   */
  async checkNow(packageName: string): Promise<void> {
    const session = this.deps.installSession()
    if (!(await this.updatesFromLocalAddress(packageName))) return this.check(packageName, session)
    const running = this.inFlight.get(packageName)
    if (running?.session !== session) {
      this.forgetChecks(packageName)
      return this.start(packageName, session).check
    }
    let again = this.checkAgain.get(packageName)
    if (!again) {
      again = running.check
        .catch(() => {})
        .then(() => {
          this.checkAgain.delete(packageName)
          if (this.deps.installSession() !== session) return
          this.forgetChecks(packageName)
          return this.start(packageName, session).check
        })
      this.checkAgain.set(packageName, again)
    }
    return again
  }

  /** Whether the build the package runs updates from a local address (see the module comment). */
  private async updatesFromLocalAddress(packageName: string): Promise<boolean> {
    try {
      const version = await this.deps.activeVersion(packageName)
      if (!version) return false
      return updateSource(packageName, this.deps.releaseIdentity(packageName, version), this.deps)?.local === true
    } catch {
      return false
    }
  }

  /** A local build's next check runs whenever it was last checked, and whatever the last one did. */
  private forgetChecks(packageName: string): void {
    this.lastCheckedAt.delete(packageName)
    this.backoff.delete(packageName)
  }

  private start(
    packageName: string,
    session: number,
  ): {check: Promise<void>; asking: Promise<void>; installing: Promise<void>} {
    const running = this.inFlight.get(packageName)
    if (running?.session === session) return running
    let onAsking = () => {}
    const asking = new Promise<void>((resolve) => {
      onAsking = resolve
    })
    let onInstalling = () => {}
    const installing = new Promise<void>((resolve) => {
      onInstalling = resolve
    })
    const entry = {session, asking, installing, check: Promise.resolve()}
    entry.check = this.run(packageName, session, onAsking, onInstalling).finally(() => {
      if (this.inFlight.get(packageName) === entry) this.inFlight.delete(packageName)
    })
    this.inFlight.set(packageName, entry)
    return entry
  }

  private async run(
    packageName: string,
    session: number,
    onAsking: () => void,
    onInstalling: () => void = () => {},
  ): Promise<void> {
    // An install started in an ended session must not activate.
    const isCancelled = () => this.deps.installSession() !== session
    if (isCancelled()) return
    this.waitingToUpdate.delete(packageName)
    const now = this.deps.now()
    const waiting = this.backoff.get(packageName)
    if (waiting && waiting.nextAttemptAt > now) return

    const version = await this.deps.activeVersion(packageName)
    if (!version) return
    const installed = this.deps.releaseIdentity(packageName, version)
    const source = updateSource(packageName, installed, this.deps)
    if (source?.local) return this.runLocal(packageName, version, installed, source.url, isCancelled, onInstalling)
    // The person's development build holds the package: its release isn't updated meanwhile.
    if (!semver.valid(version) || this.deps.isDevelopmentBuild(packageName)) return
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

    // The build to hold: `bundle`, or the version a pin holds the package to (`selectInstallTarget`). A pin that can't
    // be met installs nothing and keeps what is installed. A system miniapp updates from its deployment's host, not
    // from the URL an assignment's pin was sealed against, so a pin has no effect on it.
    const target = selectInstallTarget(packageName, manifest, source.recorded ? this.deps.pinFor : null)
    if (!target.ok) {
      this.deps.log(`${packageName} stays as it is: its pin to ${target.pin.version} can't be met (${target.reason})`)
      this.backoff.delete(packageName)
      return
    }
    const {build, pinned} = target

    // The update rule: install the target unless it is the build already installed. The versions are not
    // compared. Failures stay counted until there is nothing left to install.
    const servedBuild = {version: build.version, bundleSha256: build.sha256}
    if (isServedBuildInstalled({version, bundleSha256: installed?.bundleSha256}, servedBuild)) {
      this.backoff.delete(packageName)
      return
    }

    // The served file's top-level fields describe the latest build. A pinned build's compatibility and hardware are
    // known only from its ZIP's own `miniapp.json`, which the installer checks, also before it asks a running miniapp.
    const policy = this.deps.compatibilityPolicy()
    if (!policy) return
    const compatibility = pinned ? null : checkMiniappRunsOnPhone(manifest, policy)
    if (compatibility && !compatibility.compatible) {
      this.deps.log(`${packageName}@${manifest.version} is not compatible with this phone: ${compatibility.reason}`)
      this.backoff.delete(packageName)
      return
    }
    const launches = () => pinned || this.deps.launchesWithPairedGlasses(manifest.hardwareRequirements, packageName)

    // A miniapp about to start keeps the build it has when the paired glasses can't launch the served one, as a
    // running one does: installed now, the start would run a build its glasses refuse. A later check installs it
    // while the miniapp is stopped.
    if (this.starting.has(packageName) && !launches()) {
      return
    }

    let bundleUrl: string
    try {
      const resolved = new URL(build.url.trim(), served.url)
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
      bundleSha256: build.sha256,
      ...(served.private ? {private: true} : {}),
    }
    onInstalling()
    try {
      await this.deps.install(bundleUrl, {
        expectedPackageName: packageName,
        expectedVersion: build.version,
        expectedBundleSha256: build.sha256,
        onlyIfStopped: true,
        // Not asked, a running miniapp's update waits without downloading.
        askIfRunning: launches(),
        onAsking,
        isCancelled,
        downloadBundle: (url) =>
          this.deps.fetchBundle(url, {
            packageName,
            sha256: build.sha256,
            onChallenge: () => {
              releaseIdentity.private = true
            },
          }),
        releaseIdentity,
      })
    } catch (error) {
      // The session ended: the next session checks again.
      if (isCancelled()) return
      // A running miniapp's update waits for it to stop, or for the user's
      // answer. Its next start checks again, however soon.
      if (this.deps.isRunningError(error)) {
        this.lastCheckedAt.delete(packageName)
        this.waitingToUpdate.add(packageName)
        return
      }
      this.fail(packageName, `could not install ${packageName}@${build.version}`, error)
      return
    }
    this.backoff.delete(packageName)
    this.deps.log(
      `Updated ${packageName} from ${version} to ${build.version} (${build.sha256.slice(0, 8)}${pinned ? ", pinned" : ""})`,
    )
    await this.deps.keepVersions(packageName, [build.version, version]).catch((error) => {
      this.deps.warn(`Could not remove other releases of ${packageName}`, error)
    })
  }

  /**
   * Check a local build's address and install what it serves when that is another build (the update rule), never
   * asking: a running miniapp restarts on it. The rules for a local address are the module comment's. Nothing here is
   * registered, archived or moved, and nothing answers a sign-in challenge.
   */
  private async runLocal(
    packageName: string,
    version: string,
    installed: MiniappReleaseIdentity | null,
    sourceUrl: string,
    isCancelled: () => boolean,
    onInstalling: () => void,
  ): Promise<void> {
    if (!this.deps.developmentAllowed(packageName)) return
    this.lastCheckedAt.set(packageName, this.deps.now())
    const manifestUrl = new URL("miniapp.json", sourceUrl).href
    let requestUrl = manifestUrl
    let result: ManifestFetchResult
    for (let redirects = 0; ; redirects++) {
      try {
        result = await this.deps.fetchManifest(requestUrl, {packageName, local: true})
      } catch (error) {
        this.fail(packageName, `could not fetch ${requestUrl}`, error)
        return
      }
      if (result.location === undefined) break
      if (redirects >= MAX_MANIFEST_REDIRECTS) {
        this.fail(packageName, `${manifestUrl} redirected more than ${MAX_MANIFEST_REDIRECTS} times`)
        return
      }
      // Nothing checks a local build's name against a domain, so what it installs must come from the local network.
      if (!isLocalAddress(result.location)) {
        this.fail(packageName, `${requestUrl} redirected to ${result.location}, off the local network`)
        return
      }
      requestUrl = result.location
    }
    if (isCancelled()) return
    if (result.status < 200 || result.status >= 300 || result.body === undefined) {
      this.fail(packageName, `${requestUrl} answered ${result.status}`, undefined, result.retryAfterMs)
      return
    }
    if (!isLocalAddress(result.url)) {
      this.fail(packageName, `${requestUrl} was served from ${result.url}, off the local network`)
      return
    }
    let manifest: HostedMiniappManifest
    try {
      manifest = parseHostedManifest(result.body, packageName)
    } catch (error) {
      this.fail(packageName, `${requestUrl} is not a valid miniapp.json`, error)
      return
    }

    // The update rule. A development build's version is its own (`dev-*`), so only the hash can match.
    const servedBuild = {version: manifest.version, bundleSha256: manifest.bundle.sha256}
    if (isServedBuildInstalled({version, bundleSha256: installed?.bundleSha256}, servedBuild)) {
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
    const bundleUrl = localFileUrl(manifest.bundle.url, result.url)
    if (!bundleUrl) {
      this.fail(packageName, `${requestUrl} names a bundle off the local network`)
      return
    }

    const reloadUrl = developmentReloadUrl(manifest.reload, result.url)
    onInstalling()
    try {
      await this.deps.installLocal(bundleUrl, {
        packageName,
        version: manifest.version,
        sourceUrl,
        sha256: manifest.bundle.sha256,
        ...(reloadUrl ? {reloadUrl} : {}),
        downloadBundle: (url) =>
          this.deps.fetchBundle(url, {packageName, sha256: manifest.bundle.sha256, onChallenge: () => {}, local: true}),
        isCancelled,
      })
    } catch (error) {
      if (isCancelled()) return
      this.fail(packageName, `could not install ${packageName}@${manifest.version} from ${sourceUrl}`, error)
      return
    }
    this.backoff.delete(packageName)
    this.deps.log(`Updated ${packageName} from ${sourceUrl} (${manifest.bundle.sha256.slice(0, 8)})`)
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

/** Whether a URL is on the local network: `localhost`, a private address or a `.local` name. */
function isLocalAddress(url: string): boolean {
  try {
    return isLocalNetworkHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/** A file a local build's `miniapp.json` names, resolved against where it was served from: on the local network only. */
function localFileUrl(path: string, servedFrom: string): string | null {
  try {
    const resolved = new URL(path, servedFrom)
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null
    return isLocalAddress(resolved.href) ? resolved.href : null
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
