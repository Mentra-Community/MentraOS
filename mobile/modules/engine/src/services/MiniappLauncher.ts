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
 */

import {File} from "expo-file-system"

import {isInstalledMiniappAllowed, isLocalMiniappPackageAllowed} from "../runtime/bootstrap"
import {resolveDevBundleSource} from "../utils/devMiniappSnapshot"
import {storage} from "../utils/storage/storage"
import appRegistry, {getLocalAppRunningState, saveLocalAppRunningState} from "./AppRegistry"
import devServerBridge from "./DevServerBridge"
import localMiniappRuntime, {type InstalledMiniappManifest} from "./LocalMiniappRuntime"
import type {MentraJSRouter} from "./MentraJSRouter"

interface LauncherDeps {
  /** The host-constructed router (needs the native Crust binding). */
  router: MentraJSRouter
}

/** Hints the host may pass from a view's props to avoid re-deriving them. */
export interface LaunchHints {
  devUrl?: string
  version?: string
  devPort?: string
}

/** Everything the launcher resolved for a package — bg source + UI entry. */
export interface ResolvedBundle {
  bgSource: string
  uiUri: string | null
  uiBaseDir: string | null
  declaredPermissions: string[]
  installedManifest?: InstalledMiniappManifest
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

  /**
   * Resolve the background JS source + UI entry + declared permissions for a
   * package. Handles both dev (HTTP off the running dev server) and released
   * (file:// from the installed snapshot). Reads disk/network/storage; does
   * NOT spawn. Returns null when the bundle can't be resolved (dev server
   * unreachable with no on-disk snapshot, missing entry, no installed version).
   */
  async resolveBundle(packageName: string, hints?: LaunchHints): Promise<ResolvedBundle | null> {
    const devUrl = hints?.devUrl ?? this.storedDevUrl(packageName)

    // --- Dev: live HTTP, then the last on-disk snapshot if the laptop is gone. ---
    if (devUrl) {
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
    const version = hints?.version ?? (await appRegistry.getActiveVersion(packageName))
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
      actions?: Array<{id?: unknown; description?: unknown; parameters?: unknown; outputSchema?: unknown}>
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
  async ensureRunning(packageName: string, hints?: LaunchHints): Promise<LaunchResult> {
    if (!isLocalMiniappPackageAllowed(packageName)) {
      throw new Error(`MiniappLauncher: ${packageName} is disabled by deployment policy`)
    }
    const router = this.requireRouter()

    // Already spawned: best-effort resolve for the UI entry, never throw —
    // a headless caller that doesn't need UI gets {null, null} fast even if
    // the dev server has since dropped.
    if (router.registeredPackages().includes(packageName)) {
      const existing = await this.resolveBundle(packageName, hints).catch(() => null)
      return {uiUri: existing?.uiUri ?? null, uiBaseDir: existing?.uiBaseDir ?? null}
    }

    // Coalesce concurrent launches of the same package onto one promise.
    const pending = this.inFlight.get(packageName)
    if (pending) return pending

    const launch = this.spawn(packageName, hints)
    this.inFlight.set(packageName, launch)
    try {
      return await launch
    } finally {
      this.inFlight.delete(packageName)
    }
  }

  /** Resolve the bundle and spawn the context. Serialized via {@link inFlight}. */
  private async spawn(packageName: string, hints?: LaunchHints): Promise<LaunchResult> {
    const router = this.requireRouter()
    const resolved = await this.resolveBundle(packageName, hints)
    if (!resolved) {
      throw new Error(`MiniappLauncher: cannot resolve bundle for ${packageName}`)
    }
    const version = resolved.installedManifest?.version
    if (
      !isInstalledMiniappAllowed(
        packageName,
        version,
        version ? appRegistry.getReleaseIdentity(packageName, version) : null,
      )
    ) {
      throw new Error(`MiniappLauncher: ${packageName} bundle is not authorized by deployment policy`)
    }

    // Re-check after the async resolve: a different path may have spawned it
    // while we were fetching/reading the bundle.
    if (!router.registeredPackages().includes(packageName)) {
      const ok = await router.spawnAndRegister(packageName, resolved.bgSource, {
        permissions: resolved.declaredPermissions,
        installedManifest: resolved.installedManifest,
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
    }

    return {uiUri: resolved.uiUri, uiBaseDir: resolved.uiBaseDir}
  }

  /**
   * Re-spawn local miniapps that were running when the app was last killed.
   *
   * Cloud apps run on a remote server: the cloud persists which ones are
   * running and resurrects them when the phone reconnects, so a host-app
   * restart brings them back on its own. Local (phone-hosted) miniapps run in
   * the phone's own JS engine — a host-process kill tears down their JSContext
   * and there is no server to resurrect them, so without this they silently
   * stay stopped on the next launch even though the user left them running.
   *
   * Each local miniapp persists its running flag to disk on start/stop
   * (`saveLocalAppRunningState`, via the applet's `onStart`/`onStop`). We read
   * those flags back and re-spawn the background context headlessly (no
   * foreground, no navigation) — the spawn registers the package so the home
   * tray/switcher project it as running, exactly as a normal start would. The
   * WebView, if any, re-attaches lazily when the user opens the app.
   *
   * Idempotent and best-effort: skips already-spawned contexts, and clears the
   * persisted flag for any app whose bundle can no longer be resolved
   * (uninstalled, or dev server gone) so a dead entry doesn't retry every boot.
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
        await this.ensureRunning(app.packageName)
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
  async ensureConnected(packageName: string, connectTimeoutMs = 10_000, hints?: LaunchHints): Promise<void> {
    await this.ensureRunning(packageName, hints)
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
