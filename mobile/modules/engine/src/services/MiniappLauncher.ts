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
 *   - the dev hot-reload respawn path and the WebView mount path share one
 *     resolve+spawn recipe instead of three copies.
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
 */

import {File} from "expo-file-system"

import {
  isDevMiniappAllowed,
  isInstalledMiniappAllowed,
  isLocalMiniappPackageAllowed,
  isMiniappAvailable,
  type MiniappAvailabilityMode,
} from "../runtime/bootstrap"
import {resolveDevBundleSource} from "../utils/devMiniappSnapshot"
import {storage} from "../utils/storage/storage"
import {MiniappRunningError} from "../utils/storeInstallRuntime"
import appRegistry, {getLocalAppRunningState, saveLocalAppRunningState} from "./AppRegistry"
import devServerBridge from "./DevServerBridge"
import {fleetEvents} from "./fleet/fleetEvents"
import localMiniappRuntime, {type InstalledMiniappManifest} from "./LocalMiniappRuntime"
import type {MentraJSRouter} from "./MentraJSRouter"
import {isHostTrustedSystemMiniapp} from "./SystemMiniappPolicy"

interface LauncherDeps {
  /** The host-constructed router (needs the native Crust binding). */
  router: MentraJSRouter
}

/** Hints the host may pass from a view's props to avoid re-deriving them. */
export interface LaunchHints {
  devUrl?: string
  /** Retained for caller compatibility; released launches use the committed active version. */
  version?: string
  devPort?: string
}

export interface RuntimeLaunchOptions {
  /** False for an invocation-scoped wake that must not enter the running tray. */
  projectRunning?: boolean
  /**
   * Who started the miniapp, for the Fleet launch this call makes, if it makes one: the person (a screen they opened)
   * or the platform (a restore, another miniapp, a restart). Defaults to automatic.
   */
  trigger?: "user" | "automatic"
}

function availabilityMode(options?: RuntimeLaunchOptions): MiniappAvailabilityMode {
  return options?.projectRunning === false ? "background" : "interactive"
}

/** Everything the launcher resolved for a package — bg source + UI entry. */
export interface ResolvedBundle {
  bgSource: string
  uiUri: string | null
  uiBaseDir: string | null
  declaredPermissions: string[]
  installedManifest?: InstalledMiniappManifest
  /** Build-owned SYSTEM trust derived from install provenance, never the manifest. */
  hostTrustedSystem: boolean
  /** Set for dev miniapps (HTTP off the dev server); null for released. */
  devUrl: string | null
  devPort: number | null
}

/** What the host needs back to render the UI layer. */
export interface LaunchResult {
  uiUri: string | null
  uiBaseDir: string | null
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

  /** Wire the router in. Called once from MiniappEngine construction. */
  configure(deps: LauncherDeps): void {
    this.deps = deps
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
   * package. Handles both dev (HTTP off the running dev server) and released
   * (file:// from the installed snapshot). Reads disk/network/storage; does
   * NOT spawn. Returns null when the bundle can't be resolved (dev server
   * unreachable with no on-disk snapshot, missing entry, no installed version).
   */
  async resolveBundle(
    packageName: string,
    hints?: LaunchHints,
    runtimeOptions?: RuntimeLaunchOptions,
  ): Promise<ResolvedBundle | null> {
    if (!isMiniappAvailable(packageName, availabilityMode(runtimeOptions))) return null
    const devAllowed = isDevMiniappAllowed(packageName)
    // Live dev code is unsigned, so it never runs under a package installed with
    // a publisher signature; that package runs its installed bundle instead.
    const liveDevAllowed = devAllowed && !appRegistry.getPublisherKeyFingerprint(packageName)
    const devUrl = liveDevAllowed ? (hints?.devUrl ?? this.storedDevUrl(packageName)) : undefined

    const selectedSnapshot = devAllowed ? appRegistry.getSelectedDevSnapshot(packageName) : null
    if (selectedSnapshot) return this.resolveInstalledBundle(packageName, selectedSnapshot)

    // --- Dev: live HTTP, then the last on-disk snapshot if the laptop is gone. ---
    // A stored URL from a scan that this workspace will not run must fall
    // through to the released bundle, or the home tile disappears.
    if (devUrl && devAllowed) {
      const source = await resolveDevBundleSource(packageName, devUrl)
      if (source.kind === "live") {
        const live = await this.resolveLiveHttp(packageName, source.resolvedUrl, source.manifest, hints)
        if (live) return live
        // Live probe succeeded but the entry fetch failed — still try disk.
      }
      const snapshotVersion =
        source.kind === "snapshot" ? source.version : appRegistry.getLatestDevSnapshotVersion(packageName)
      if (snapshotVersion) {
        const snapshot = await this.resolveInstalledBundle(packageName, snapshotVersion)
        if (snapshot) return snapshot
      }
      return null
    }

    // --- Released: resolve from the installed file:// snapshot. ---
    // A view can retain its old version prop across an install or rollback.
    // Resolve the committed pointer here, including after an installation wait.
    const version = await appRegistry.getActiveVersion(packageName)
    if (!version) return null
    return this.resolveInstalledBundle(packageName, version)
  }

  private async resolveLiveHttp(
    packageName: string,
    resolvedUrl: string,
    manifest: {entry?: unknown; permissions?: unknown; [key: string]: unknown},
    hints?: LaunchHints,
  ): Promise<ResolvedBundle | null> {
    const entry = manifest.entry as {background?: string; ui?: string} | undefined
    if (!entry?.background) return null

    // Use the host that actually answered — may differ from the stored IP
    // after a laptop Wi-Fi change (mDNS / Metro failover inside resolveDevBundleSource).
    const base = resolvedUrl.replace(/\/$/, "")
    // entry.* are bundle-root paths (dist/ stripped); the dev server serves
    // files relative to cwd, so prepend dist/.
    const bgUrl = `${base}/dist/${entry.background.replace(/^\.?\/+/, "")}`
    const uiUri = entry.ui ? `${base}/dist/${entry.ui.replace(/^\.?\/+/, "")}` : null

    const perms = manifest.permissions as Array<{type?: string} | string> | undefined
    const declaredPermissions = (perms ?? [])
      .map((p) => (typeof p === "string" ? p : p?.type))
      .filter((t): t is string => typeof t === "string")
    const installedManifest: InstalledMiniappManifest = {
      packageName: typeof manifest.packageName === "string" ? manifest.packageName : packageName,
      name: typeof manifest.name === "string" ? manifest.name : undefined,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
      sdkVersion: typeof manifest.sdkVersion === "string" ? manifest.sdkVersion : undefined,
      minHostVersion: typeof manifest.minHostVersion === "string" ? manifest.minHostVersion : undefined,
      type: typeof manifest.type === "string" ? manifest.type : undefined,
      entry: manifest.entry as InstalledMiniappManifest["entry"],
      permissions: manifest.permissions as InstalledMiniappManifest["permissions"],
      hardwareRequirements: manifest.hardwareRequirements as InstalledMiniappManifest["hardwareRequirements"],
      actions: manifest.actions as InstalledMiniappManifest["actions"],
    }

    let bgSource: string
    try {
      const res = await fetch(bgUrl)
      if (!res.ok) return null
      bgSource = await res.text()
    } catch {
      return null
    }

    return {
      bgSource,
      uiUri,
      uiBaseDir: uiUri ? uiUri.replace(/\/[^/]+$/, "/") : null,
      declaredPermissions,
      installedManifest,
      // A dev server is never host-trusted, whatever package name it claims.
      hostTrustedSystem: false,
      devUrl: resolvedUrl,
      devPort: this.resolveDevPort(hints?.devPort, packageName),
    }
  }

  private async resolveInstalledBundle(packageName: string, version: string): Promise<ResolvedBundle | null> {
    const entryPaths = appRegistry.getMiniappEntryPaths(packageName, version)
    if (!entryPaths?.background) return null

    const manifest = appRegistry.getMiniappManifest(packageName, version) as {
      packageName?: string
      name?: string
      version?: string
      sdkVersion?: string
      minHostVersion?: string
      type?: string
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
    } | null
    const declaredPermissions = (manifest?.permissions ?? [])
      .map((p) => p.type)
      .filter((t): t is string => typeof t === "string")
    const installedManifest: InstalledMiniappManifest | undefined = manifest
      ? {
          packageName: manifest.packageName ?? packageName,
          name: manifest.name,
          version: manifest.version ?? version,
          sdkVersion: manifest.sdkVersion,
          minHostVersion: manifest.minHostVersion,
          type: manifest.type,
          entry: manifest.entry,
          permissions: manifest.permissions,
          hardwareRequirements: manifest.hardwareRequirements,
          actions: manifest.actions,
        }
      : undefined

    let bgSource: string
    try {
      bgSource = new File(entryPaths.background).textSync()
    } catch {
      return null
    }

    return {
      bgSource,
      uiUri: entryPaths.ui ?? null,
      uiBaseDir: entryPaths.ui ? entryPaths.ui.replace(/\/[^/]+$/, "/") : null,
      declaredPermissions,
      installedManifest,
      hostTrustedSystem: isHostTrustedSystemMiniapp(packageName, appRegistry.getReleaseIdentity(packageName, version)),
      // Snapshot fallback is file:// — do not wire the sidecar; the laptop is gone.
      devUrl: null,
      devPort: null,
    }
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
    // An install holds launches until its files and metadata commit or roll
    // back; the launch then resolves whichever bundle is active.
    const installation = this.installing.get(packageName)
    if (installation) await installation
    if (
      !isMiniappAvailable(packageName, availabilityMode(runtimeOptions)) ||
      !isLocalMiniappPackageAllowed(packageName)
    ) {
      throw new Error(`MiniappLauncher: ${packageName} is disabled by deployment policy`)
    }
    const router = this.requireRouter()
    const projectRunning = runtimeOptions?.projectRunning ?? true

    // Already spawned: best-effort resolve for the UI entry, never throw —
    // a headless caller that doesn't need UI gets {null, null} fast even if
    // the dev server has since dropped. A user launch promotes a context a
    // transient action woke.
    if (router.registeredPackages().includes(packageName)) {
      const promoted = projectRunning && this.promote(packageName)
      const existing = await this.resolveBundle(packageName, hints, runtimeOptions).catch(() => null)
      if (promoted) this.reportLaunch(packageName, "started", runtimeOptions, existing?.installedManifest)
      return {uiUri: existing?.uiUri ?? null, uiBaseDir: existing?.uiBaseDir ?? null}
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
        if (projectRunning && joinedHidden) this.reportLaunch(packageName, "failed", runtimeOptions)
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
      if (projectRunning) this.reportLaunch(packageName, "failed", runtimeOptions)
      throw error
    } finally {
      this.inFlight.delete(packageName)
      this.hiddenInFlight.delete(packageName)
    }
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
  ): void {
    fleetEvents.launchUnlessClaimed({
      packageName,
      ...(manifest?.name ? {miniappName: manifest.name} : {}),
      ...(manifest?.version ? {versionName: manifest.version} : {}),
      start: runtimeOptions?.trigger ?? "automatic",
      outcome,
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
    const version = resolved.installedManifest?.version
    // A live dev server sets devUrl. A snapshot keeps the directory name `dev-*`
    // as the active version. Either one is the scanned build; a release fallback is neither.
    const activeVersion = await appRegistry.getActiveVersion(packageName)
    const devBuild = Boolean(resolved.devUrl) || Boolean(activeVersion?.startsWith("dev-"))
    if (
      // Availability may change while the bundle resolves.
      !isMiniappAvailable(packageName, availabilityMode(runtimeOptions)) ||
      (devBuild
        ? !isDevMiniappAllowed(packageName)
        : !isInstalledMiniappAllowed(
            packageName,
            version,
            version ? appRegistry.getReleaseIdentity(packageName, version) : null,
          ))
    ) {
      throw new Error(`MiniappLauncher: ${packageName} bundle is not authorized by deployment policy`)
    }

    // Re-check after the async resolve: a different path may have spawned it
    // while we were fetching/reading the bundle.
    const projectRunning = runtimeOptions?.projectRunning ?? true
    if (router.registeredPackages().includes(packageName)) {
      if (projectRunning && this.promote(packageName)) {
        this.reportLaunch(packageName, "started", runtimeOptions, resolved.installedManifest)
      }
    } else {
      const ok = await router.spawnAndRegister(packageName, resolved.bgSource, {
        permissions: resolved.declaredPermissions,
        installedManifest: resolved.installedManifest,
        hostTrustedSystem: resolved.hostTrustedSystem,
        projectRunning,
      })
      if (!ok) {
        throw new Error(`MiniappLauncher: spawn failed for ${packageName}`)
      }

      // Dev: wire the hot-reload + log-forwarding sidecar. No-op in prod
      // (devServerBridge silently drops when no sidecar is up).
      if (resolved.devUrl && resolved.devPort != null) {
        devServerBridge.connect(packageName, resolved.devUrl, resolved.devPort)
      } else if (resolved.devUrl) {
        // Dev miniapp with no resolvable port — it still launches, but hot
        // reload + log forwarding won't connect. Surface it instead of failing
        // silently (the old inline path hard-failed with "no dev port").
        console.warn(`MiniappLauncher: ${packageName} has no dev port — hot reload + log forwarding disabled`)
      }
      if (projectRunning) this.reportLaunch(packageName, "started", runtimeOptions, resolved.installedManifest)
    }

    return {uiUri: resolved.uiUri, uiBaseDir: resolved.uiBaseDir}
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
   * Idempotent and best-effort: skips already-spawned contexts and clears the
   * persisted running flag if ensureRunning fails (for example, bundle resolution,
   * deployment policy, or context spawning) so it does not retry every boot.
   * Each restore is an automatic launch to Fleet, reported by ensureRunning.
   * Not compatibility-gated: a previously-running background app shouldn't be
   * dropped just because glasses are momentarily disconnected at boot — it
   * resumes when they reconnect, same as mid-session.
   */
  async autostartLocalMiniapps(): Promise<void> {
    const apps = await appRegistry.getInstalledMiniapps()
    for (const app of apps) {
      // Only phone-hosted miniapps have a JSContext to re-spawn. Offline
      // built-ins (`local:false, offline:true`) restore their native running
      // state elsewhere and have no bundle to launch.
      if (!app.local) continue
      if (!getLocalAppRunningState(app.packageName)) continue
      if (this.isRunning(app.packageName)) continue
      try {
        // Restoring what was running is the platform's doing, never the user's.
        await this.ensureRunning(app.packageName, undefined, {trigger: "automatic"})
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
  }

  // --- internals -----------------------------------------------------------

  private storedDevUrl(packageName: string): string | undefined {
    const r = storage.load<string>(`${packageName}_dev_url`)
    return r.is_ok() ? r.value : undefined
  }

  /** resolveDevPort — moved verbatim from the old LocalMiniappView helper. */
  private resolveDevPort(searchParam: string | undefined, packageName: string): number | null {
    if (searchParam) {
      const n = parseInt(searchParam, 10)
      if (Number.isFinite(n)) return n
    }
    const stored = storage.load<number>(`${packageName}_dev_port`)
    if (stored.is_ok()) return stored.value
    return null
  }
}

export const miniappLauncher = new MiniappLauncher()
