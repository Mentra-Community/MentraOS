import {registerMiniapp, type ActionContext, type MiniappSession} from "@mentra/miniapp/background"
import {isNewerVersion, loadCompleteCatalog, parseCatalog, trustedBackendOrigin} from "./catalog"
import {isAutomaticUpdateCandidate, isAutomaticUpdateOwnedRelease} from "./updates"
import type {StoreChannels} from "../shared/channels"
import {MENTRA_STORE_PACKAGE_NAME, type InstalledApp, type StoreApp, type StoreSnapshot} from "../shared/types"

const CONFIGURED_STORE_URL = process.env.MENTRA_PUBLIC_STORE_URL
const STORE_MUTATION_ACTION_CALLERS = new Set(["com.mentra.ai"])

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
  private automaticUpdatePromise: Promise<void> | null = null
  private refreshQueued = false
  private queuedAutomaticRefresh = false
  private queuedClearOperation = false
  private queuedQuery = ""
  private lastQuery = ""
  private artworkCache = new Map<string, Promise<string | null>>()
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
      void this.reconcileUpdates()
    })
    this.session.actions.handle("reconcile_updates", () => this.reconcileUpdates())
    this.session.actions.handle("search_miniapps", (params) => this.searchMiniapps(params))
    this.session.actions.handle("get_miniapp_details", (params) => this.getMiniappDetails(params))
    this.session.actions.handle("install_miniapp", (params, context) =>
      this.enqueueMutation(() => {
        this.requireMutationActionCaller(context)
        return this.installMiniappAction(params, false)
      }),
    )
    this.session.actions.handle("update_miniapp", (params, context) =>
      this.enqueueMutation(() => {
        this.requireMutationActionCaller(context)
        return this.installMiniappAction(params, true)
      }),
    )
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
    this.ui.handle(
      "store:set-track",
      ({packageName, track, query}: {packageName: string; track: "stable" | "beta"; query?: string}) =>
        this.enqueueMutation(() => this.setTrack(packageName, track, query)),
    )
  }

  private async reconcileUpdates(): Promise<{checkedAt: number; candidateCount: number}> {
    await this.refresh(this.lastQuery, true)
    const candidateCount = this.automaticUpdateCandidates().length
    await this.scheduleAutomaticUpdates()
    return {checkedAt: Date.now(), candidateCount}
  }

  private send() {
    this.ui.send("store:snapshot", this.snapshot)
  }

  private async storeUrl() {
    try {
      return resolveStoreBackendOrigin(await this.session.auth.getCoreUrl(), CONFIGURED_STORE_URL)
    } catch {
      return trustedBackendOrigin(CONFIGURED_STORE_URL)
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

  private async loadCatalog(base: string, query?: string): Promise<StoreApp[]> {
    const apps = await loadCompleteCatalog(async (page) => {
      const url = new URL("/api/store/apps", base)
      url.searchParams.set("limit", "50")
      url.searchParams.set("page", String(page))
      if (query?.trim()) url.searchParams.set("q", query.trim())
      const response = await this.session.auth.fetch(url.toString(), {headers: {accept: "application/json"}})
      if (!response.ok) throw new Error(`Store catalog unavailable (${response.status})`)
      return response.json()
    })
    return this.hydratePrivateArtwork(apps)
  }

  private async loadCatalogApp(base: string, packageName: string): Promise<StoreApp> {
    const url = new URL(`/api/store/apps/${encodeURIComponent(packageName)}`, base)
    const response = await this.session.auth.fetch(url.toString(), {headers: {accept: "application/json"}})
    if (!response.ok)
      throw new Error(response.status === 404 ? "Miniapp not found" : `Store catalog unavailable (${response.status})`)
    const body = (await response.json()) as {app?: unknown}
    const app = parseCatalog({apps: [body.app]})[0]
    if (!app || app.packageName !== packageName) throw new Error("Store returned an invalid miniapp record")
    const [hydrated] = await this.hydratePrivateArtwork([app])
    return (await this.annotateInstallCompatibility([hydrated!]))[0]!
  }

  private hydratePrivateArtwork(apps: StoreApp[]): Promise<StoreApp[]> {
    return Promise.all(
      apps.map(async (app) => {
        if (app.visibility !== "private") return app
        const [iconUrl, coverUrl, screenshotUrls] = await Promise.all([
          this.loadAuthenticatedArtwork(app.iconUrl),
          this.loadAuthenticatedArtwork(app.coverUrl),
          Promise.all(app.screenshotUrls.map((url) => this.loadAuthenticatedArtwork(url))),
        ])
        return {
          ...app,
          iconUrl,
          coverUrl,
          screenshotUrls: screenshotUrls.filter((url): url is string => Boolean(url)),
        }
      }),
    )
  }

  private loadAuthenticatedArtwork(url: string | null): Promise<string | null> {
    if (!url) return Promise.resolve(null)
    const cached = this.artworkCache.get(url)
    if (cached) return cached
    const request = this.session.auth
      .fetch(url, {headers: {accept: "image/avif,image/webp,image/png,image/jpeg"}})
      .then(async (response) => {
        if (!response.ok) return null
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
        if (!contentType?.startsWith("image/")) return null
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength === 0 || bytes.byteLength > 10 * 1024 * 1024) return null
        return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`
      })
      .catch(() => null)
    this.artworkCache.set(url, request)
    return request
  }

  private async searchMiniapps(params: Record<string, unknown>) {
    const query = typeof params.query === "string" ? params.query.trim().slice(0, 120) : ""
    const requestedLimit = typeof params.limit === "number" && Number.isFinite(params.limit) ? params.limit : 5
    const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 10)
    const base = await this.storeUrl()
    if (!base) throw new Error("Store backend URL is not configured")
    const [apps, installed] = await Promise.all([
      this.loadCatalog(base, query).then((rows) => this.annotateInstallCompatibility(rows)),
      this.session.miniapps.list({includeIncompatible: true}),
    ])
    const installedByPackage = new Map(installed.map((app) => [app.packageName, app]))
    return {
      query,
      results: apps.slice(0, limit).map((app) => this.actionSummary(app, installedByPackage.get(app.packageName))),
    }
  }

  private async getMiniappDetails(params: Record<string, unknown>) {
    const packageName = this.actionPackageName(params)
    const base = await this.storeUrl()
    if (!base) throw new Error("Store backend URL is not configured")
    const [app, installed] = await Promise.all([
      this.loadCatalogApp(base, packageName),
      this.session.miniapps.list({includeIncompatible: true}),
    ])
    return {
      ...this.actionSummary(
        app,
        installed.find((candidate) => candidate.packageName === packageName),
      ),
      description: app.description,
      categories: app.categories,
      permissions: app.release.permissions,
      hardwareRequirements: app.release.hardwareRequirements,
      privacyPolicyUrl: app.privacyPolicyUrl,
      supportUrl: app.supportUrl,
      websiteUrl: app.websiteUrl,
      screenshots: app.screenshotUrls,
      availableTracks: app.availableTracks,
      betaAccess: app.betaAccess,
    }
  }

  private async installMiniappAction(params: Record<string, unknown>, updateOnly: boolean) {
    const packageName = this.actionPackageName(params)
    const base = await this.storeUrl()
    if (!base) throw new Error("Store backend URL is not configured")
    const [app, installedBefore] = await Promise.all([
      this.loadCatalogApp(base, packageName),
      this.session.miniapps.list({includeIncompatible: true}),
    ])
    const current = installedBefore.find((candidate) => candidate.packageName === packageName)
    if (updateOnly && !current) throw new Error(`${app.name} is not installed`)
    if (!app.release.installable) {
      throw new Error(`Join the ${app.betaAccess === "invited" ? "private " : ""}beta before installing ${app.name}`)
    }
    if (current && !isNewerVersion(app.release.version, current.version)) {
      return {status: "up_to_date", packageName, version: current.version}
    }
    if (app.release.installCompatibility?.compatible === false) {
      throw new Error(app.release.installCompatibility.reason ?? `${app.name} is not compatible with this device`)
    }

    await this.install(packageName, undefined, app)
    const installedAfter = await this.session.miniapps.list({includeIncompatible: true})
    const installed = installedAfter.find((candidate) => candidate.packageName === packageName)
    if (!installed || installed.version !== app.release.version) {
      throw new Error(this.snapshot.error ?? `Could not install ${app.name}`)
    }
    return {
      status: current ? "updated" : "installed",
      packageName,
      version: installed.version,
      name: app.name,
      track: app.release.track,
    }
  }

  private requireMutationActionCaller(context: ActionContext): void {
    if (!STORE_MUTATION_ACTION_CALLERS.has(context.callerPackageName)) {
      throw new Error("This SYSTEM miniapp is not authorized to install or update miniapps")
    }
  }

  private actionPackageName(params: Record<string, unknown>): string {
    const packageName = typeof params.packageName === "string" ? params.packageName.trim().toLowerCase() : ""
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageName)) {
      throw new Error("A valid lowercase reverse-DNS packageName is required")
    }
    return packageName
  }

  private actionSummary(app: StoreApp, installed?: InstalledApp) {
    const updateAvailable = Boolean(
      app.release.installable && installed && isNewerVersion(app.release.version, installed.version),
    )
    return {
      packageName: app.packageName,
      name: app.name,
      subtitle: app.subtitle,
      version: app.release.version,
      track: app.release.track,
      installable: app.release.installable,
      reviewTier: app.reviewTier,
      installed: Boolean(installed),
      installedVersion: installed?.version ?? null,
      updateAvailable,
      compatible: app.release.installCompatibility?.compatible !== false,
      compatibilityReason: app.release.installCompatibility?.reason ?? null,
    }
  }

  private async load(query?: string, clearOperation = false, refreshAutomaticCatalog = false) {
    this.snapshot = {...this.snapshot, loading: true, error: null}
    this.send()
    try {
      const base = await this.storeUrl()
      if (!base) throw new Error("Store backend URL is not configured")
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
    if (!this.snapshot.offline) void this.scheduleAutomaticUpdates()
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

  private scheduleAutomaticUpdates(): Promise<void> {
    if (this.automaticUpdatePromise) return this.automaticUpdatePromise
    const candidates = this.automaticUpdateCandidates()
    if (candidates.length === 0) return Promise.resolve()
    const updateRun = this.enqueueMutation(async () => {
      const failures: string[] = []
      for (const app of candidates) {
        const installed = this.snapshot.installed.find((candidate) => candidate.packageName === app.packageName)
        if (!installed || !isNewerVersion(app.release.version, installed.version)) continue
        try {
          await this.install(app.packageName, undefined, app)
        } catch (error) {
          failures.push(`${app.name}: ${error instanceof Error ? error.message : "update failed"}`)
        }
      }
      if (failures.length > 0) {
        this.snapshot = {
          ...this.snapshot,
          operation: null,
          error: `Some automatic updates could not be installed: ${failures.join("; ")}`,
        }
        this.send()
      }
      return this.snapshot
    })
      .then(() => undefined)
      .catch((error) => {
        this.snapshot = {
          ...this.snapshot,
          operation: null,
          error: error instanceof Error ? error.message : "Automatic update failed",
        }
        this.send()
      })
      .finally(() => {
        this.automaticUpdatePromise = null
      })
    this.automaticUpdatePromise = updateRun
    return updateRun
  }

  private requireApp(packageName: string) {
    const app = this.apps.find((candidate) => candidate.packageName === packageName)
    if (!app) throw new Error("Miniapp is no longer available")
    return app
  }

  private enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
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
    if (!app.release.installable || !app.release.bundleUrl || !app.release.bundleSha256) {
      throw new Error(`Join the ${app.betaAccess === "invited" ? "private " : ""}beta before installing ${app.name}`)
    }
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
        channel: app.release.track,
      })
      return this.refresh(this.lastQuery, false, true)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Install failed")
      this.snapshot = {
        ...this.snapshot,
        operation: null,
        error: failure.message,
      }
      this.send()
      throw failure
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
      const failure = error instanceof Error ? error : new Error("Uninstall failed")
      this.snapshot = {
        ...this.snapshot,
        operation: null,
        error: failure.message,
      }
      this.send()
      throw failure
    }
  }

  private async setTrack(packageName: string, track: "stable" | "beta", query?: string) {
    if (query !== undefined) this.lastQuery = query
    const base = await this.storeUrl()
    if (!base) throw new Error("Store backend URL is not configured")
    const url = new URL(`/api/store/apps/${encodeURIComponent(packageName)}/track`, base)
    const response = await this.session.auth.fetch(url.toString(), {
      method: "POST",
      headers: {"accept": "application/json", "content-type": "application/json"},
      body: JSON.stringify({track}),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {error_description?: unknown} | null
      throw new Error(
        typeof body?.error_description === "string"
          ? body.error_description
          : `Could not change release track (${response.status})`,
      )
    }
    return this.refresh(this.lastQuery, true, true)
  }

  private async open(packageName: string, query?: string) {
    if (query !== undefined) this.lastQuery = query
    this.snapshot = {...this.snapshot, operation: {packageName, kind: "open"}, error: null}
    this.send()
    try {
      await this.session.miniapps.open(packageName)
      return this.refresh(this.lastQuery, false, true)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Open failed")
      this.snapshot = {...this.snapshot, operation: null, error: failure.message}
      this.send()
      throw failure
    }
  }
}

export function resolveStoreBackendOrigin(
  coreValue: string | null | undefined,
  configuredValue?: string,
): string | null {
  const configured = trustedBackendOrigin(configuredValue)
  const core = trustedBackendOrigin(coreValue)
  if (!core) return configured
  const url = new URL(core)
  if (url.hostname === "core.mentraglass.com") return "https://store.mentraglass.com"
  if (url.hostname.startsWith("core.") && url.hostname.endsWith(".mentraglass.com")) {
    return `${url.protocol}//${url.hostname.replace(/^core\./, "store.")}${url.port ? `:${url.port}` : ""}`
  }
  if ((url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") && url.port === "3000") {
    url.port = "3003"
    return url.origin
  }
  return configured ?? core
}

registerMiniapp((session) => new StoreController(session).start())
