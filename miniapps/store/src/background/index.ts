import {registerMiniapp, type MiniappSession} from "@mentra/miniapp/background"
import {isNewerVersion, loadCompleteCatalog, trustedCoreOrigin} from "./catalog"
import {isAutomaticUpdateCandidate, isAutomaticUpdateOwnedRelease} from "./updates"
import type {StoreChannels} from "../shared/channels"
import {MENTRA_STORE_PACKAGE_NAME, type InstalledApp, type StoreApp, type StoreSnapshot} from "../shared/types"

const FALLBACK_CORE_URL = process.env.MENTRA_PUBLIC_CORE_URL

export class StoreController {
  private apps: StoreApp[] = []
  private automaticApps: StoreApp[] = []
  private snapshot: StoreSnapshot = {
    apps: [],
    installed: [],
    loading: true,
    offline: false,
    error: null,
    operation: null,
    refreshedAt: null,
  }
  private refreshing: Promise<StoreSnapshot> | null = null
  private mutationTail: Promise<void> = Promise.resolve()
  private automaticUpdateRunning = false
  private refreshQueued = false
  private queuedAutomaticRefresh = false
  private queuedClearOperation = false
  private queuedQuery = ""
  private lastQuery = ""
  private ui: {
    send: <C extends keyof StoreChannels & string>(channel: C, payload: StoreChannels[C]) => void
    handle: <C extends keyof StoreChannels & string>(channel: C, handler: (payload: any) => Promise<any>) => () => void
    onOpen: (handler: () => void) => () => void
  }

  constructor(private readonly session: MiniappSession) {
    this.ui = session.ui as unknown as StoreController["ui"]
  }

  start() {
    this.session.miniapps.onInstallProgress((progress) => {
      if (this.snapshot.operation?.packageName !== progress.packageName) return
      this.snapshot = {...this.snapshot, operation: {...this.snapshot.operation, phase: progress.phase}}
      this.send()
    })
    this.ui.onOpen(() => {
      this.send()
      void this.refresh(this.lastQuery, true)
    })
    this.session.onVisibilityChange((visibility) => {
      if (visibility === "foreground") void this.refresh(this.lastQuery, true)
    })
    let wasConnected = false
    this.session.cloud.onStatusChanged((status) => {
      const connected = status.status === "connected"
      if (connected && !wasConnected) void this.refresh(this.lastQuery, true)
      wasConnected = connected
    })
    this.ui.handle("store:refresh", ({query}: {query?: string}) => this.refresh(query))
    this.ui.handle("store:install", ({packageName, query}: {packageName: string; query?: string}) =>
      this.enqueueMutation(() => this.install(packageName, query)),
    )
    this.ui.handle("store:uninstall", ({packageName, query}: {packageName: string; query?: string}) =>
      this.enqueueMutation(() => this.uninstall(packageName, query)),
    )
    this.ui.handle("store:open", ({packageName, query}: {packageName: string; query?: string}) =>
      this.enqueueMutation(() => this.open(packageName, query)),
    )
    void this.refresh("", true)
    setInterval(() => void this.refresh(this.lastQuery, true), 15 * 60_000)
  }

  private send() {
    this.ui.send("store:snapshot", this.snapshot)
  }

  private async coreUrl() {
    try {
      return trustedCoreOrigin(await this.session.auth.getCoreUrl()) ?? FALLBACK_CORE_URL
    } catch {
      return FALLBACK_CORE_URL
    }
  }

  private refresh(query = "", refreshAutomaticCatalog = false, clearOperation = false): Promise<StoreSnapshot> {
    this.lastQuery = query
    this.queuedQuery = query
    this.refreshQueued = true
    this.queuedAutomaticRefresh ||= refreshAutomaticCatalog
    this.queuedClearOperation ||= clearOperation
    if (this.refreshing) return this.refreshing
    this.refreshing = this.drainRefreshes()
    return this.refreshing
  }

  private async drainRefreshes(): Promise<StoreSnapshot> {
    try {
      while (this.refreshQueued) {
        const query = this.queuedQuery
        const refreshAutomaticCatalog = this.queuedAutomaticRefresh
        const clearOperation = this.queuedClearOperation
        this.refreshQueued = false
        this.queuedAutomaticRefresh = false
        this.queuedClearOperation = false
        await this.load(query, clearOperation, refreshAutomaticCatalog)
      }
      return this.snapshot
    } finally {
      // Clear the in-flight marker in the same synchronous continuation that
      // observes an empty queue. A refresh cannot be stranded between the
      // final queue check and a later Promise.finally callback.
      this.refreshing = null
    }
  }

  private loadCatalog(base: string, query?: string): Promise<StoreApp[]> {
    return loadCompleteCatalog(async (page) => {
      const url = new URL("/api/store/apps", base)
      url.searchParams.set("limit", "50")
      url.searchParams.set("page", String(page))
      if (query?.trim()) url.searchParams.set("q", query.trim())
      const response = await this.session.auth.fetch(url.toString(), {headers: {accept: "application/json"}})
      if (!response.ok) throw new Error(`Store catalog unavailable (${response.status})`)
      return response.json()
    })
  }

  private async load(query?: string, clearOperation = false, refreshAutomaticCatalog = false) {
    this.snapshot = {...this.snapshot, loading: true, error: null}
    this.send()
    try {
      const base = await this.coreUrl()
      if (!base) throw new Error("Store Core URL is not configured")
      const queryIsFiltered = Boolean(query?.trim())
      const [apps, installed, automaticApps] = await Promise.all([
        this.loadCatalog(base, query),
        this.session.miniapps.list({includeIncompatible: true}),
        refreshAutomaticCatalog && queryIsFiltered ? this.loadCatalog(base) : Promise.resolve(null),
      ])
      this.apps = await this.annotateInstallCompatibility(apps)
      if (!queryIsFiltered) {
        this.automaticApps = this.apps
      } else if (automaticApps) {
        const installedByPackage = new Map(installed.map((app) => [app.packageName, app]))
        const ownedUpdates = automaticApps.filter((app) =>
          isAutomaticUpdateOwnedRelease(app, installedByPackage.get(app.packageName), MENTRA_STORE_PACKAGE_NAME),
        )
        this.automaticApps = await this.annotateInstallCompatibility(ownedUpdates)
      }
      this.snapshot = {
        apps: this.apps,
        installed,
        loading: false,
        offline: false,
        error: null,
        operation: clearOperation ? null : this.snapshot.operation,
        refreshedAt: Date.now(),
      }
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        loading: false,
        offline: true,
        error: error instanceof Error ? error.message : "Store unavailable",
        operation: clearOperation ? null : this.snapshot.operation,
      }
    }
    this.send()
    if (!this.snapshot.offline) this.scheduleAutomaticUpdates()
    return this.snapshot
  }

  private async annotateInstallCompatibility(apps: StoreApp[]): Promise<StoreApp[]> {
    return Promise.all(
      apps.map(async (app) => {
        try {
          const installCompatibility = await this.session.miniapps.checkInstallCompatibility({
            minHostVersion: app.release.minHostVersion,
            sdkVersion: app.release.sdkVersion,
            hardwareRequirements: app.release.hardwareRequirements,
          })
          return {...app, release: {...app.release, installCompatibility}}
        } catch (error) {
          return {
            ...app,
            release: {
              ...app.release,
              installCompatibility: {
                compatible: false,
                reason: error instanceof Error ? error.message : "Unable to verify update compatibility",
              },
            },
          }
        }
      }),
    )
  }

  private automaticUpdateCandidates(): StoreApp[] {
    const installedByPackage = new Map(this.snapshot.installed.map((app) => [app.packageName, app]))
    return this.automaticApps.filter((app) => {
      const installed = installedByPackage.get(app.packageName)
      return isAutomaticUpdateCandidate(app, installed, MENTRA_STORE_PACKAGE_NAME)
    })
  }

  private scheduleAutomaticUpdates(): void {
    if (this.automaticUpdateRunning) return
    const candidates = this.automaticUpdateCandidates()
    if (candidates.length === 0) return
    this.automaticUpdateRunning = true
    void this.enqueueMutation(async () => {
      try {
        for (const app of candidates) {
          const installed = this.snapshot.installed.find((candidate) => candidate.packageName === app.packageName)
          if (!installed || !isNewerVersion(app.release.version, installed.version)) continue
          await this.install(app.packageName, undefined, app)
        }
      } finally {
        this.automaticUpdateRunning = false
      }
      return this.snapshot
    }).catch((error) => {
      this.snapshot = {
        ...this.snapshot,
        operation: null,
        error: error instanceof Error ? error.message : "Automatic update failed",
      }
      this.send()
    })
  }

  private requireApp(packageName: string) {
    const app = this.apps.find((candidate) => candidate.packageName === packageName)
    if (!app) throw new Error("Miniapp is no longer available")
    return app
  }

  private enqueueMutation(run: () => Promise<StoreSnapshot>): Promise<StoreSnapshot> {
    const result = this.mutationTail.then(run, run)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async install(packageName: string, query?: string, selectedApp?: StoreApp) {
    if (query !== undefined) this.lastQuery = query
    const app = selectedApp ?? this.requireApp(packageName)
    this.snapshot = {...this.snapshot, operation: {packageName, kind: "install", phase: "downloading"}, error: null}
    this.send()
    try {
      await this.session.miniapps.install({
        packageName,
        version: app.release.version,
        bundleUrl: app.release.bundleUrl,
        bundleSha256: app.release.bundleSha256,
        ...(app.release.minHostVersion ? {minHostVersion: app.release.minHostVersion} : {}),
        ...(app.release.sdkVersion ? {sdkVersion: app.release.sdkVersion} : {}),
        hardwareRequirements: app.release.hardwareRequirements,
        releaseId: app.release.id,
        channel: "stable",
      })
      return this.refresh(this.lastQuery, false, true)
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        operation: null,
        error: error instanceof Error ? error.message : "Install failed",
      }
      this.send()
      return this.snapshot
    }
  }

  private async uninstall(packageName: string, query?: string) {
    if (query !== undefined) this.lastQuery = query
    this.snapshot = {...this.snapshot, operation: {packageName, kind: "uninstall"}, error: null}
    this.send()
    try {
      await this.session.miniapps.uninstall(packageName)
      return this.refresh(this.lastQuery, false, true)
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        operation: null,
        error: error instanceof Error ? error.message : "Uninstall failed",
      }
      this.send()
      return this.snapshot
    }
  }

  private async open(packageName: string, query?: string) {
    if (query !== undefined) this.lastQuery = query
    this.snapshot = {...this.snapshot, operation: {packageName, kind: "open"}, error: null}
    this.send()
    try {
      await this.session.miniapps.open(packageName)
      return this.refresh(this.lastQuery, false, true)
    } catch (error) {
      this.snapshot = {...this.snapshot, operation: null, error: error instanceof Error ? error.message : "Open failed"}
      this.send()
      return this.snapshot
    }
  }
}

registerMiniapp((session) => new StoreController(session).start())
