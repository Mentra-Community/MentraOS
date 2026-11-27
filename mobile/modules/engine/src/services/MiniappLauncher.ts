/**
 * MiniappLauncher — headless launch/teardown of a local miniapp's background
 * JS context.
 *
 * This is the one piece of "run a miniapp" that used to live inside the
 * `LocalMiniappView` React component (resolve the bundle → read the manifest →
 * `spawnAndRegister`), triggered only when the Compositor mounted that
 * component on foreground. Pulling it into the runtime means:
 *
 *   - `start()` can actually spawn an app even when nothing foregrounds it
 *     (e.g. a system app launching another miniapp via `session.miniapps`).
 *   - the action broker can wake a stopped target headlessly — no UI at all.
 *   - every launch path shares one resolve+spawn recipe.
 *
 * The launcher is **headless**: no React, no RN components. The engine-owned
 * MiniappEngine hands it the {@link MentraJSRouter} instance once during
 * engine construction. OEMs embedding the runtime drive miniapp lifecycle
 * through the engine facade and stores, not a separate launcher configure API.
 *
 * Boundary: the launcher owns the **background** context. WebView *rendering*
 * (the UI layer) stays with the host — the launcher just hands back the
 * resolved UI entry so the host can mount its `<WebView>`.
 *
 * Fleet: every path that makes a local miniapp execute as user activity comes
 * through here, so the launcher reports each such launch (and each that fails
 * once past the availability gate) — a restore, a miniapp started by another
 * miniapp or an action, a screen opened directly, a restart after a reinstall.
 * A launch the apps store's `start` makes is reported by `start` itself
 * (`fleetEvents.claimLaunch`); a context already executing, or one a hidden
 * action wake keeps out of the running tray, is no launch.
 *
 * Updates: every launch path comes through here, so this is where a miniapp that isn't running waits for its update
 * check before it starts ({@link MiniappLauncher.waitForUpdate}): another build installs while the miniapp is still
 * stopped, instead of asking to restart it once it runs.
 *
 * Age ratings: every launch path comes through here, so this is where a miniapp rated above the host app's own
 * rating meets the age gate as it opens, whether it was installed with the sheet or headlessly (a Fleet assignment,
 * a system miniapp). A launch the person makes in front of the app may ask their age once; any other launch needs it
 * declared already.
 */

import type {FleetLaunchFailureReason} from "@mentra/cloud-protocol"
import {File} from "expo-file-system"
import {AppState, Platform} from "react-native"

import {
  getConfigValues,
  isDevMiniappAllowed,
  isMiniappAvailable,
  type MiniappAvailabilityMode,
} from "../runtime/bootstrap"
import {MiniappRunningError} from "../utils/storeInstallRuntime"
import appRegistry, {getLocalAppRunningState, saveLocalAppRunningState} from "./AppRegistry"
import devServerBridge from "./DevServerBridge"
import {fleetEvents} from "./fleet/fleetEvents"
import localMiniappRuntime, {type InstalledMiniappManifest} from "./LocalMiniappRuntime"
import {checkManifestVersions} from "./manifestVersionGate"
import type {MentraJSRouter} from "./MentraJSRouter"
import {checkMiniappAge, type AgeGateVerdict, type AgeRatedMiniapp} from "./miniappAgeGate"
import {developmentOriginName, miniappOrigin, miniappOriginUrl, type MiniappOriginPlatform} from "./miniappOrigin"
import {recordMiniappScreenOrigin} from "./miniappScreenOrigin"
import {isHostTrustedSystemMiniapp} from "./SystemMiniappPolicy"
import {honoredMiniappVariant} from "./miniappVariant"

/** The miniapp's server no longer admits this account (Fleet revocation): it cannot launch until access returns. */
export class MiniappAccessRevokedError extends Error {
  constructor(readonly packageName: string) {
    super(`MiniappLauncher: access to ${packageName} was revoked`)
    this.name = "MiniappAccessRevokedError"
  }
}

/**
 * The miniapp is rated above the host app's own rating and the person's declared age doesn't let it open (see
 * {@link AgeGateVerdict}). A person opening it in front of the app was asked their age, or told why.
 */
export class MiniappAgeRestrictedError extends Error {
  constructor(readonly packageName: string, readonly verdict: Exclude<AgeGateVerdict, "allowed">) {
    super(`MiniappLauncher: ${packageName} is age-rated and did not open (${verdict})`)
    this.name = "MiniappAgeRestrictedError"
  }
}

/**
 * The bundle needs a newer Mentra App, or a Mentra Miniapp SDK this one doesn't run: the rule installs refuse by,
 * checked again as it launches. A release a newer Mentra App installed stays on disk when an older one replaces it (a
 * development build replaced from TestFlight), and would otherwise start against features this one lacks. The message
 * is for logs; a screen explains it in the person's language, as an install refused by the same rule does.
 */
export class MiniappIncompatibleHostError extends Error {
  constructor(readonly packageName: string, readonly miniappName: string, readonly reason: string) {
    super(`${miniappName} can't run on this phone: ${reason}`)
    this.name = "MiniappIncompatibleHostError"
  }
}

/** Stopped while its start waited for its update check: nothing started. */
export class MiniappStartCancelledError extends Error {
  constructor(readonly packageName: string) {
    super(`MiniappLauncher: ${packageName} was stopped before it started`)
    this.name = "MiniappStartCancelledError"
  }
}

/** What a start waits for before the miniapp runs: its update check, or the update that check found, installing. */
export type MiniappStartWait = "check" | "update"

/**
 * The check a start waits for (the URL updater's `checkBeforeStart`). Resolves once the start may go on: the check
 * is done or its time is up. Calls `onInstalling` when it found another build and waits for that to install.
 */
export type UpdateCheckBeforeStart = (packageName: string, onInstalling: () => void) => Promise<void>

/** One wait before a start, shared by every start of the package meanwhile. */
interface PendingStartWait {
  phase: MiniappStartWait
  cancelled: boolean
  cancel(): void
  /** Settles when the start may go on, or was cancelled. Never rejects. */
  done: Promise<void>
}

interface LauncherDeps {
  /** The host-constructed router (needs the native Crust binding). */
  router: MentraJSRouter
}

/** Hints the host may pass from a view's props to avoid re-deriving them. */
export interface LaunchHints {
  /** Retained for caller compatibility; launches use the committed active version. */
  version?: string
}

export interface RuntimeLaunchOptions {
  /** False for an invocation-scoped wake that must not enter the running tray. */
  projectRunning?: boolean
  /**
   * Who started the miniapp, for the Fleet launch this call makes, if it makes one: the person (a screen they opened)
   * or the platform (a restore, another miniapp, a restart). Defaults to automatic.
   */
  trigger?: "user" | "automatic"
  /**
   * False for a launch that doesn't wait for the package's update check: its caller waited already
   * ({@link MiniappLauncher.waitForUpdate}), or it restarts a miniapp around an install.
   */
  checkForUpdate?: boolean
}

function availabilityMode(options?: RuntimeLaunchOptions): MiniappAvailabilityMode {
  return options?.projectRunning === false ? "background" : "interactive"
}

/** Everything the launcher resolved for a package — bg source + UI entry. */
export interface ResolvedBundle {
  bgSource: string
  /** Where the screen loads from. See {@link LaunchResult.uiUri}. */
  uiUri: string | null
  /** The origin `uiUri` belongs to. See {@link LaunchResult.uiOrigin}. */
  uiOrigin: string | null
  /** The bundle root the package's origin serves. See {@link LaunchResult.uiRootDir}. */
  uiRootDir: string | null
  /** The name the origin is for. See {@link LaunchResult.uiOriginName}. */
  uiOriginName: string | null
  /** A development build: one installed from a local address. */
  devBuild: boolean
  declaredPermissions: string[]
  installedManifest?: InstalledMiniappManifest
  /** What the bundle's `miniapp.json` declares as `ageRating`; null when it declares none. */
  ageRating: unknown
  /** Build-owned SYSTEM trust derived from install provenance, never the manifest. */
  hostTrustedSystem: boolean
  /** The bundle's version directory: a release's version, or a development build's `dev-<ms>`. */
  version: string
  /**
   * A local build's console connection (`reloadUrl` in its release identity): it gets the miniapp's logs and says
   * when a new build is ready (`DevServerBridge`). Null for any other build.
   */
  reloadUrl: string | null
}

/** What the host needs back to render the UI layer. */
export interface LaunchResult {
  /**
   * Where the screen loads from. An installed release loads from its
   * package's own origin: `miniapp://<packageName>/<ui entry>` on iOS and
   * `https://<host>.miniapp.invalid/<ui entry>` on Android (see
   * {@link miniappOriginUrl}), a development build from the origin of its
   * {@link uiOriginName}. Null when there is no screen to load.
   */
  uiUri: string | null
  /** The origin `uiUri` belongs to, for the WebView's `originWhitelist`. */
  uiOrigin: string | null
  /**
   * The root of the active version's bundle, which the package's origin
   * serves (the WebView's `miniappOrigin.rootDir`). Null with `uiUri`.
   */
  uiRootDir: string | null
  /**
   * The name the origin serves `uiRootDir` under (the WebView's
   * `miniappOrigin.packageName`): the package name for a release, and
   * {@link developmentOriginName} for a development build, so a development
   * build never shares web storage with a release of its name. Null with
   * `uiRootDir`.
   */
  uiOriginName: string | null
  /** A development build: one installed from a local address. */
  devBuild: boolean
}

const NO_UI: LaunchResult = {uiUri: null, uiOrigin: null, uiRootDir: null, uiOriginName: null, devBuild: false}

function launchResultOf(resolved: ResolvedBundle | null | undefined): LaunchResult {
  if (!resolved) return NO_UI
  return {
    uiUri: resolved.uiUri,
    uiOrigin: resolved.uiOrigin,
    uiRootDir: resolved.uiRootDir,
    uiOriginName: resolved.uiOriginName,
    devBuild: resolved.devBuild,
  }
}

/** The platform whose origin shape the Mentra App's WebView serves. */
function originPlatform(): MiniappOriginPlatform {
  return Platform.OS === "android" ? "android" : "ios"
}

/**
 * Why a launch failed, as the code Fleet takes (Phase 12): never the error's text. A bundle that cannot be found is
 * `bundle_missing`; one that needs a newer Mentra App `incompatible_host`; a deployment, age or access block
 * `policy_blocked`; a context that did not start `spawn_failed`.
 */
export function launchFailureReason(error: unknown): FleetLaunchFailureReason {
  if (error instanceof MiniappIncompatibleHostError) return "incompatible_host"
  if (error instanceof MiniappAgeRestrictedError || error instanceof MiniappAccessRevokedError) return "policy_blocked"
  const message = error instanceof Error ? error.message : ""
  if (message.includes("cannot resolve bundle")) return "bundle_missing"
  if (message.includes("by deployment policy")) return "policy_blocked"
  if (message.includes("spawn failed")) return "spawn_failed"
  return "unknown"
}

class MiniappLauncher {
  private deps: LauncherDeps | null = null

  /**
   * In-flight launches keyed by packageName. Both apps.ts start() and the
   * WebView mount call ensureRunning() before the first spawnAndRegister
   * resolves — without this, neither sees the package in registeredPackages()
   * yet and both spawn the same context (a clobber/double-spawn). Concurrent
   * callers share the same promise.
   */
  private readonly inFlight = new Map<string, Promise<LaunchResult>>()
  /** In-flight launches that keep their context out of the running tray (a hidden action wake). */
  private readonly hiddenInFlight = new Set<string>()

  /**
   * Installs hold new launches of their package until they commit or roll
   * back: explicit installs for the whole install, automatic updates only while
   * their files change.
   */
  private readonly installing = new Map<string, Promise<void>>()

  /** The update check a start waits for; null until the engine wires the URL updater in. */
  private updateCheck: UpdateCheckBeforeStart | null = null
  /** The starts waiting for their update check, by package. */
  private readonly startWaits = new Map<string, PendingStartWait>()
  private readonly startWaitListeners = new Set<() => void>()

  /**
   * Run an automatic update only while the miniapp is idle. `install` prepares
   * the release, then calls `beforeActivate` immediately before files change:
   * a launch during preparation wins and the update defers with
   * {@link MiniappRunningError}; a launch during activation waits for the
   * commit or rollback and then reads the resulting bundle.
   */
  async installWhenIdle<T>(packageName: string, install: (beforeActivate: () => void) => Promise<T>): Promise<T> {
    const assertIdle = () => {
      if (this.isRunning(packageName) || this.inFlight.has(packageName)) throw new MiniappRunningError(packageName)
    }
    assertIdle()
    let release: (() => void) | undefined
    try {
      return await install(() => {
        assertIdle()
        release = this.reserveInstall(packageName)
      })
    } finally {
      release?.()
    }
  }

  /** Stabilize existing launches and hold new ones until an explicit install finishes. */
  async pauseLaunches(packageName: string): Promise<() => void> {
    const release = this.reserveInstall(packageName)
    // Launches already resolving a bundle must settle before the installer
    // decides whether a context needs stopping/restarting. A failed launch is also settled.
    await this.inFlight.get(packageName)?.catch(() => {})
    return release
  }

  private reserveInstall(packageName: string): () => void {
    if (this.installing.has(packageName)) throw new Error(`An install is already activating ${packageName}`)
    let resume!: () => void
    const pending = new Promise<void>((resolve) => {
      resume = resolve
    })
    this.installing.set(packageName, pending)
    return () => {
      if (this.installing.get(packageName) !== pending) return
      this.installing.delete(packageName)
      resume()
    }
  }

  /**
   * The name and age rating of the installed bundle a launch of `packageName` runs (the version `getActiveVersion`
   * chooses, a development build included), read without waiting. The apps store checks it before it opens the
   * screen or stops other miniapps, so a refusal changes nothing.
   */
  installedAgeRating(packageName: string): AgeRatedMiniapp {
    const version = appRegistry.peekActiveVersion(packageName)
    const manifest = version
      ? (appRegistry.getMiniappManifest(packageName, version) as {name?: unknown; ageRating?: unknown} | null)
      : null
    const name = typeof manifest?.name === "string" && manifest.name ? manifest.name : packageName
    return {packageName, name, ageRating: manifest?.ageRating ?? null}
  }

  /** Wire the router in. Called once from MiniappEngine construction. */
  configure(deps: LauncherDeps): void {
    this.deps = deps
  }

  /** Wire in the update check a start waits for. Called once, where the URL updater is built. */
  setUpdateCheck(check: UpdateCheckBeforeStart | null): void {
    this.updateCheck = check
  }

  /**
   * Before a miniapp that isn't running starts: wait for its update check, so that another build installs while it
   * is still stopped, silently, instead of asking to restart it once it runs. The check bounds the wait (the
   * updater's `START_UPDATE_LIMITS`) and skips it when there is nothing to learn; past it, the miniapp starts as it
   * is. Starts of one package share one wait. A miniapp already running, launching or being installed doesn't wait.
   *
   * Resolves false when the start was cancelled meanwhile ({@link cancelStart}): nothing starts. Never throws.
   */
  async waitForUpdate(packageName: string): Promise<boolean> {
    const check = this.updateCheck
    if (!check || !this.waitsForUpdate(packageName)) return true
    let wait = this.startWaits.get(packageName)
    if (!wait) {
      let cancel!: () => void
      // When the check found an update and began installing it: logged with how long it took, as the splash's
      // "Updating…" can be too brief to see.
      let updateFoundAt: number | null = null
      const cancelled = new Promise<void>((resolve) => {
        cancel = resolve
      })
      const pending: PendingStartWait = {
        phase: "check",
        cancelled: false,
        cancel: () => {
          pending.cancelled = true
          cancel()
        },
        done: Promise.resolve(),
      }
      const checked = Promise.resolve()
        .then(() =>
          check(packageName, () => {
            if (this.startWaits.get(packageName) !== pending) return
            pending.phase = "update"
            updateFoundAt = Date.now()
            console.log(`MiniappLauncher: installing an update to ${packageName} before it starts`)
            this.notifyStartWait()
          }),
        )
        .catch((error) => console.warn(`MiniappLauncher: the update check before ${packageName} starts failed`, error))
      pending.done = Promise.race([checked, cancelled]).then(() => {
        if (updateFoundAt !== null) {
          // The updater's wait ends when the install does, or at its limit: the start goes on either way.
          const outcome = pending.cancelled ? "was cancelled" : "ended"
          console.log(
            `MiniappLauncher: the wait for ${packageName}'s update ${outcome} after ${Date.now() - updateFoundAt} ms`,
          )
        }
        if (this.startWaits.get(packageName) !== pending) return
        this.startWaits.delete(packageName)
        this.notifyStartWait()
      })
      this.startWaits.set(packageName, pending)
      this.notifyStartWait()
      wait = pending
    }
    await wait.done
    return !wait.cancelled
  }

  /**
   * Whether a start of the package has a check to wait for: it isn't running or launching yet, and no install is
   * putting its files in place (the launch waits for that one instead).
   */
  private waitsForUpdate(packageName: string): boolean {
    return (
      this.updateCheck !== null &&
      !this.isRunning(packageName) &&
      !this.inFlight.has(packageName) &&
      !this.installing.has(packageName)
    )
  }

  /**
   * The miniapp was stopped, or the person left it, before it started: starts of it still waiting for their update
   * check ({@link waitForUpdate}) start nothing. The check itself carries on, as any check does.
   */
  cancelStart(packageName: string): void {
    const wait = this.startWaits.get(packageName)
    if (!wait) return
    // Removed now, so a start that follows the stop at once begins a wait of its own.
    this.startWaits.delete(packageName)
    wait.cancel()
    this.notifyStartWait()
  }

  /** What a start of `packageName` waits for right now, or null when none waits. */
  startWait(packageName: string): MiniappStartWait | null {
    return this.startWaits.get(packageName)?.phase ?? null
  }

  /** Called whenever {@link startWait} changes for any package. Returns an unsubscribe. */
  onStartWaitChanged(listener: () => void): () => void {
    this.startWaitListeners.add(listener)
    return () => {
      this.startWaitListeners.delete(listener)
    }
  }

  private notifyStartWait(): void {
    for (const listener of [...this.startWaitListeners]) {
      try {
        listener()
      } catch (error) {
        console.warn("MiniappLauncher: start wait listener threw", error)
      }
    }
  }

  private requireRouter(): MentraJSRouter {
    if (!this.deps) {
      throw new Error("MiniappLauncher not configured — ensureMiniappEngine() has not run")
    }
    return this.deps.router
  }

  /** True iff the package's background JS context is currently spawned. */
  isRunning(packageName: string): boolean {
    return this.deps?.router.registeredPackages().includes(packageName) ?? false
  }

  /** True iff the live context is projected as normal user activity. */
  isProjectedRunning(packageName: string): boolean {
    return this.deps?.router.isProjectedRunning(packageName) ?? false
  }

  /**
   * Resolve the background JS source + UI entry + declared permissions for a
   * package: the active installed version, a release or a development build,
   * from disk. Reads disk/storage; does NOT spawn. Returns null when the bundle
   * can't be resolved (missing entry, no installed version).
   */
  async resolveBundle(
    packageName: string,
    _hints?: LaunchHints,
    runtimeOptions?: RuntimeLaunchOptions,
  ): Promise<ResolvedBundle | null> {
    if (!isMiniappAvailable(packageName, availabilityMode(runtimeOptions))) return null
    // A view can retain its old version prop across an install or rollback.
    // Resolve the committed pointer here, including after an installation wait.
    const version = await appRegistry.getActiveVersion(packageName)
    if (!version) return null
    return this.resolveInstalledBundle(packageName, version)
  }

  private async resolveInstalledBundle(packageName: string, version: string): Promise<ResolvedBundle | null> {
    const entryPaths = appRegistry.getMiniappEntryPaths(packageName, version)
    if (!entryPaths?.background) return null

    const manifest = appRegistry.getMiniappManifest(packageName, version) as {
      packageName?: string
      name?: string
      version?: string
      minHostVersion?: string
      minApiLevel?: number
      type?: string
      ageRating?: unknown
      entry?: {background?: string; ui?: string}
      permissions?: Array<{type: string; required?: boolean; description?: string}>
      hardwareRequirements?: Array<{type: string; level: string; description?: string}>
      actions?: Array<{
        id?: unknown
        description?: unknown
        parameters?: unknown
        outputSchema?: unknown
        lifecycle?: unknown
        audience?: unknown
      }>
      variant?: unknown
    } | null
    const releaseIdentity = appRegistry.getReleaseIdentity(packageName, version)
    // A variant stamp counts only on a release the deployment's manifest pinned by digest.
    const variant = honoredMiniappVariant(packageName, version, manifest?.variant, releaseIdentity ?? null)
    const declaredPermissions = (manifest?.permissions ?? [])
      .map((p) => p.type)
      .filter((t): t is string => typeof t === "string")
    const installedManifest: InstalledMiniappManifest | undefined = manifest
      ? {
          packageName: manifest.packageName ?? packageName,
          name: manifest.name,
          version: manifest.version ?? version,
          minHostVersion: manifest.minHostVersion,
          minApiLevel: manifest.minApiLevel,
          type: manifest.type,
          entry: manifest.entry,
          permissions: manifest.permissions,
          hardwareRequirements: manifest.hardwareRequirements,
          actions: manifest.actions,
          ...(variant ? {variant} : {}),
        }
      : undefined

    let bgSource: string
    try {
      bgSource = new File(entryPaths.background).textSync()
    } catch {
      return null
    }

    // The screen loads from the package's own origin, which serves only this
    // version's bundle and never grants file access. A development build
    // claims its name without proof, so it loads from a development origin of
    // that name instead and never sees a release's web storage. A package name
    // that can't have an origin gets no screen rather than a file:// page.
    const devBuild = version.startsWith("dev-")
    const originName = devBuild ? developmentOriginName(packageName) : packageName
    const platform = originPlatform()
    const uiUri = entryPaths.uiPath ? miniappOriginUrl(originName, entryPaths.uiPath, platform) : null
    if (entryPaths.uiPath && !uiUri) {
      console.warn(`MiniappLauncher: ${packageName} can't have an origin of its own, so its screen doesn't load`)
    }

    return {
      bgSource,
      uiUri,
      uiOrigin: uiUri ? miniappOrigin(originName, platform) : null,
      uiRootDir: uiUri ? entryPaths.rootDir : null,
      uiOriginName: uiUri ? originName : null,
      devBuild,
      declaredPermissions,
      installedManifest,
      ageRating: manifest?.ageRating ?? null,
      // A development build never runs with the build's privileges, whatever name it claims.
      hostTrustedSystem: !devBuild && isHostTrustedSystemMiniapp(packageName, releaseIdentity),
      version,
      reloadUrl: devBuild && releaseIdentity?.source === "local" ? releaseIdentity.reloadUrl ?? null : null,
    }
  }

  /** Throws {@link MiniappIncompatibleHostError} when this Mentra App can't run the resolved bundle. */
  assertRunsOnPhone(packageName: string, resolved: ResolvedBundle): void {
    const manifest = resolved.installedManifest
    if (!manifest) return
    const versions = checkManifestVersions(manifest, {hostVersion: getConfigValues().hostVersion})
    if (!versions.ok) throw new MiniappIncompatibleHostError(packageName, manifest.name || packageName, versions.reason)
  }

  /**
   * Ensure a miniapp's background JS context is spawned. Idempotent — if the
   * context is already alive this is a no-op spawn-wise (it still resolves the
   * UI entry so a re-mounting host gets its `<WebView>` source back).
   *
   * Resolves once the context is SPAWNED. It does NOT block on the context's
   * CONNECT handshake — the host's WebView mount shouldn't wait on background
   * JS. Callers that need the context to be connected and ready to receive
   * messages (the action broker) follow up with
   * {@link LocalMiniappRuntime.waitForConnect}.
   */
  async ensureRunning(
    packageName: string,
    hints?: LaunchHints,
    runtimeOptions?: RuntimeLaunchOptions,
  ): Promise<LaunchResult> {
    const projectRunning = runtimeOptions?.projectRunning ?? true
    // A miniapp that isn't running is checked for an update before it starts, whoever starts it. A hidden action
    // wake is not an open and doesn't wait, nor does a package that won't launch anyway. With nothing to wait for
    // there is no await here: a launch still begins in the call that asked for it.
    if (projectRunning && runtimeOptions?.checkForUpdate !== false && this.waitsForUpdate(packageName)) {
      this.assertMayLaunch(packageName, runtimeOptions)
      if (!(await this.waitForUpdate(packageName))) throw new MiniappStartCancelledError(packageName)
    }
    // An install holds launches until its files and metadata commit or roll
    // back; the launch then resolves whichever bundle is active.
    const installation = this.installing.get(packageName)
    if (installation) await installation
    this.assertMayLaunch(packageName, runtimeOptions)
    const router = this.requireRouter()

    // Already spawned: best-effort resolve for the UI entry, never throw.
    // A user launch promotes a context a transient action woke.
    if (router.registeredPackages().includes(packageName)) {
      const promoted = projectRunning && this.promote(packageName)
      const existing = await this.resolveBundle(packageName, hints, runtimeOptions).catch(() => null)
      if (promoted) this.reportLaunch(packageName, "started", runtimeOptions, existing?.installedManifest)
      return launchResultOf(existing)
    }

    // Coalesce concurrent launches of the same package onto one promise.
    const pending = this.inFlight.get(packageName)
    if (pending) {
      const joinedHidden = this.hiddenInFlight.has(packageName)
      let result: LaunchResult
      try {
        result = await pending
      } catch (error) {
        // A visible launch reports its own failure; one joined to a hidden wake fails with it.
        if (projectRunning && joinedHidden)
          this.reportLaunch(packageName, "failed", runtimeOptions, undefined, launchFailureReason(error))
        throw error
      }
      if (projectRunning && this.promote(packageName)) this.reportLaunch(packageName, "started", runtimeOptions)
      return result
    }

    const launch = this.spawn(packageName, hints, {...runtimeOptions, projectRunning})
    this.inFlight.set(packageName, launch)
    if (!projectRunning) this.hiddenInFlight.add(packageName)
    try {
      return await launch
    } catch (error) {
      if (projectRunning)
        this.reportLaunch(packageName, "failed", runtimeOptions, undefined, launchFailureReason(error))
      throw error
    } finally {
      this.inFlight.delete(packageName)
      this.hiddenInFlight.delete(packageName)
    }
  }

  /** Throws when deployment policy or a revoked access keeps the package from launching. */
  private assertMayLaunch(packageName: string, runtimeOptions?: RuntimeLaunchOptions): void {
    if (
      !isMiniappAvailable(packageName, availabilityMode(runtimeOptions)) ||
      !appRegistry.isPackageAllowed(packageName)
    ) {
      throw new Error(`MiniappLauncher: ${packageName} is disabled by deployment policy`)
    }
    if (appRegistry.isMiniappAccessRevoked(packageName)) throw new MiniappAccessRevokedError(packageName)
  }

  /** Projects a context already spawned as user activity: true if this made it so. */
  private promote(packageName: string): boolean {
    const router = this.requireRouter()
    if (router.isProjectedRunning(packageName)) return false
    router.projectRunning(packageName)
    return router.isProjectedRunning(packageName)
  }

  /** Reports a launch this call made to Fleet, unless the apps store's `start` is making it and reports it itself. */
  private reportLaunch(
    packageName: string,
    outcome: "started" | "failed",
    runtimeOptions?: RuntimeLaunchOptions,
    manifest?: InstalledMiniappManifest,
    failureReason?: FleetLaunchFailureReason,
  ): void {
    fleetEvents.launchUnlessClaimed({
      packageName,
      ...(manifest?.name ? {miniappName: manifest.name} : {}),
      ...(manifest?.version ? {versionName: manifest.version} : {}),
      start: runtimeOptions?.trigger ?? "automatic",
      outcome,
      ...(outcome === "failed" ? {failureReason: failureReason ?? "unknown"} : {}),
    })
  }

  /** Resolve the bundle and spawn the context. Serialized via {@link inFlight}. */
  private async spawn(
    packageName: string,
    hints?: LaunchHints,
    runtimeOptions?: RuntimeLaunchOptions,
  ): Promise<LaunchResult> {
    const router = this.requireRouter()
    const resolved = await this.resolveBundle(packageName, hints, runtimeOptions)
    if (!resolved) {
      throw new Error(`MiniappLauncher: cannot resolve bundle for ${packageName}`)
    }
    // Before the age gate, so a miniapp this app can't run never asks the person's age.
    this.assertRunsOnPhone(packageName, resolved)
    const version = resolved.installedManifest?.version
    const projectRunning = runtimeOptions?.projectRunning ?? true
    // The age gate, before the deployment checks below, which then see the state after any question the person
    // answered. Only a launch the person makes in front of the app may ask.
    const verdict = await checkMiniappAge(
      {packageName, name: resolved.installedManifest?.name || packageName, ageRating: resolved.ageRating},
      {interactive: projectRunning && AppState.currentState === "active"},
    )
    if (verdict !== "allowed") throw new MiniappAgeRestrictedError(packageName, verdict)
    if (
      // Availability may change while the bundle resolves.
      !isMiniappAvailable(packageName, availabilityMode(runtimeOptions)) ||
      (resolved.devBuild ? !isDevMiniappAllowed(packageName) : !appRegistry.isReleaseAllowed(packageName, version))
    ) {
      throw new Error(`MiniappLauncher: ${packageName} bundle is not authorized by deployment policy`)
    }

    // Re-check after the async resolve: a different path may have spawned it
    // while we were fetching/reading the bundle.
    if (router.registeredPackages().includes(packageName)) {
      if (projectRunning && this.promote(packageName)) {
        this.reportLaunch(packageName, "started", runtimeOptions, resolved.installedManifest)
      }
    } else {
      // A local build's console gets its logs from the first line it runs, and says when a new build is ready.
      if (resolved.reloadUrl) devServerBridge.connect(packageName, resolved.reloadUrl)
      else devServerBridge.disconnect(packageName)
      const ok = await router.spawnAndRegister(packageName, resolved.bgSource, {
        permissions: resolved.declaredPermissions,
        installedManifest: resolved.installedManifest,
        hostTrustedSystem: resolved.hostTrustedSystem,
        projectRunning,
        developmentBuild: resolved.devBuild,
      })
      if (!ok) {
        devServerBridge.disconnect(packageName)
        throw new Error(`MiniappLauncher: spawn failed for ${packageName}`)
      }
      if (projectRunning) this.reportLaunch(packageName, "started", runtimeOptions, resolved.installedManifest)
    }

    // Where this launch's screen would load from, for the URLs of the package's own files. A screen that opens
    // records its own (MiniappView), which is why the already-running path of ensureRunning doesn't: a headless
    // caller resolves with other hints than the screen.
    recordMiniappScreenOrigin(packageName, resolved.uiOrigin)
    return launchResultOf(resolved)
  }

  /**
   * Re-spawn local miniapps that were running when the app was last killed.
   *
   * Every miniapp runs as local JavaScript in the Mentra App on the phone.
   * A host-process kill tears down its JSContext, so without this restoration
   * it stays stopped on the next launch even though the user left it running.
   *
   * Each local miniapp persists its running flag to disk on start/stop
   * (`saveLocalAppRunningState`, via the applet's `onStart`/`onStop`). We read
   * those flags back and re-spawn the background context headlessly (no
   * foreground, no navigation) — the spawn registers the package so the home
   * tray/switcher project it as running, exactly as a normal start would. The
   * WebView, if any, re-attaches lazily when the user opens the app.
   *
   * Before they start, each is checked for an update, all at once ({@link waitForUpdate}): one found installs while
   * its miniapp is still stopped, silently. Offline or on a slow host, they start as they are.
   *
   * Idempotent and best-effort: skips already-spawned contexts and clears the
   * persisted running flag if ensureRunning fails (for example, bundle resolution,
   * deployment policy, or context spawning) so it does not retry every boot.
   * Each restore is an automatic launch to Fleet, reported by ensureRunning.
   * Not gated on the glasses' hardware: a previously-running background app shouldn't be
   * dropped just because glasses are momentarily disconnected at boot — it
   * resumes when they reconnect, same as mid-session. A release this Mentra App
   * can't run is refused like any launch (see {@link assertRunsOnPhone}).
   */
  async autostartLocalMiniapps(): Promise<void> {
    const apps = await appRegistry.getInstalledMiniapps()
    // Only phone-hosted miniapps have a JSContext to re-spawn. Offline
    // built-ins (`local:false, offline:true`) restore their native running
    // state elsewhere and have no bundle to launch.
    const toStart = apps.filter(
      (app) => app.local && getLocalAppRunningState(app.packageName) && !this.isRunning(app.packageName),
    )
    if (toStart.length === 0) return
    // Checked together, so that one slow host doesn't hold the others up for its whole limit.
    await Promise.all(toStart.map((app) => this.waitForUpdate(app.packageName)))
    for (const app of toStart) {
      // The person may have started or stopped it while it was checked: what they did stands.
      if (this.isRunning(app.packageName) || !getLocalAppRunningState(app.packageName)) continue
      try {
        // Restoring what was running is the platform's doing, never the user's.
        await this.ensureRunning(app.packageName, undefined, {trigger: "automatic", checkForUpdate: false})
      } catch (e) {
        console.warn(`MiniappLauncher: autostart failed for ${app.packageName} — clearing stale running flag`, e)
        saveLocalAppRunningState(app.packageName, false)
      }
    }
  }

  /**
   * Ensure the context is running AND has completed its CONNECT handshake.
   * Used by the action broker, which must not deliver to a context that hasn't
   * come up yet. Throws on spawn failure or connect timeout.
   */
  async ensureConnected(
    packageName: string,
    connectTimeoutMs = 10_000,
    hints?: LaunchHints,
    runtimeOptions?: RuntimeLaunchOptions,
  ): Promise<void> {
    await this.ensureRunning(packageName, hints, runtimeOptions)
    await localMiniappRuntime.waitForConnect(packageName, connectTimeoutMs)
  }

  /** Tear down a miniapp's background JS context. */
  async stop(packageName: string): Promise<void> {
    // If a launch is in flight, let it finish first. Otherwise unregister()
    // no-ops on the not-yet-registered package and the pending spawn then
    // re-registers the context — leaving it running despite the stop.
    const pending = this.inFlight.get(packageName)
    if (pending) {
      try {
        await pending
      } catch {
        // Launch failed — nothing got registered, so nothing to tear down.
      }
    }
    await this.deps?.router.unregister(packageName)
    devServerBridge.disconnect(packageName)
    console.log(`MiniappLauncher: stopped ${packageName}`)
  }
}

export const miniappLauncher = new MiniappLauncher()
