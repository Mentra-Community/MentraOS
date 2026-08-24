import {registerMiniapp, type MiniappSession} from "@mentra/miniapp/background"
import {coreOriginFromToken, parseCatalog} from "./catalog"
import type {StoreChannels} from "../shared/channels"
import type {StoreApp, StoreSnapshot} from "../shared/types"

const FALLBACK_CORE_URL = process.env.MENTRA_PUBLIC_CORE_URL

class StoreController {
  private apps: StoreApp[] = []
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
  private refreshQueued = false
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
      void this.refresh(this.lastQuery)
    })
    this.session.onVisibilityChange((visibility) => {
      if (visibility === "foreground") void this.refresh(this.lastQuery)
    })
    let wasConnected = false
    this.session.cloud.onStatusChanged((status) => {
      const connected = status.status === "connected"
      if (connected && !wasConnected) void this.refresh(this.lastQuery)
      wasConnected = connected
    })
    this.ui.handle("store:refresh", ({query}: {query?: string}) => this.refresh(query))
    this.ui.handle("store:install", ({packageName}: {packageName: string}) => this.install(packageName))
    this.ui.handle("store:uninstall", ({packageName}: {packageName: string}) => this.uninstall(packageName))
    this.ui.handle("store:open", ({packageName}: {packageName: string}) => this.open(packageName))
    void this.refresh()
    setInterval(() => void this.refresh(this.lastQuery), 15 * 60_000)
  }

  private send() {
    this.ui.send("store:snapshot", this.snapshot)
  }

  private async coreUrl() {
    try {
      const token = await this.session.auth.getToken()
      return coreOriginFromToken(token) ?? FALLBACK_CORE_URL
    } catch {
      return FALLBACK_CORE_URL
    }
  }

  private refresh(query = ""): Promise<StoreSnapshot> {
    this.lastQuery = query
    this.queuedQuery = query
    this.refreshQueued = true
    if (this.refreshing) return this.refreshing
    this.refreshing = this.drainRefreshes().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async drainRefreshes(): Promise<StoreSnapshot> {
    while (this.refreshQueued) {
      const query = this.queuedQuery
      this.refreshQueued = false
      await this.load(query)
    }
    return this.snapshot
  }

  private async load(query?: string) {
    this.snapshot = {...this.snapshot, loading: true, error: null}
    this.send()
    try {
      const base = await this.coreUrl()
      const url = new URL("/api/store/apps", base)
      url.searchParams.set("limit", "50")
      if (query?.trim()) url.searchParams.set("q", query.trim())
      const [catalogResponse, installed] = await Promise.all([
        this.session.auth.fetch(url.toString(), {headers: {accept: "application/json"}}),
        this.session.miniapps.list({includeIncompatible: true}),
      ])
      if (!catalogResponse.ok) throw new Error(`Store catalog unavailable (${catalogResponse.status})`)
      this.apps = parseCatalog(await catalogResponse.json())
      this.snapshot = {
        apps: this.apps,
        installed,
        loading: false,
        offline: false,
        error: null,
        operation: null,
        refreshedAt: Date.now(),
      }
    } catch (error) {
      this.snapshot = {
        ...this.snapshot,
        loading: false,
        offline: true,
        error: error instanceof Error ? error.message : "Store unavailable",
        operation: null,
      }
    }
    this.send()
    return this.snapshot
  }

  private requireApp(packageName: string) {
    const app = this.apps.find((candidate) => candidate.packageName === packageName)
    if (!app) throw new Error("Miniapp is no longer available")
    return app
  }

  private async install(packageName: string) {
    const app = this.requireApp(packageName)
    this.snapshot = {...this.snapshot, operation: {packageName, kind: "install", phase: "downloading"}, error: null}
    this.send()
    try {
      await this.session.miniapps.install({
        packageName,
        version: app.release.version,
        bundleUrl: app.release.bundleUrl,
        bundleSha256: app.release.bundleSha256,
        releaseId: app.release.id,
        channel: "stable",
      })
      return this.load()
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

  private async uninstall(packageName: string) {
    this.snapshot = {...this.snapshot, operation: {packageName, kind: "uninstall"}, error: null}
    this.send()
    try {
      await this.session.miniapps.uninstall(packageName)
      return this.load()
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

  private async open(packageName: string) {
    this.snapshot = {...this.snapshot, operation: {packageName, kind: "open"}, error: null}
    this.send()
    try {
      await this.session.miniapps.open(packageName)
      return this.load()
    } catch (error) {
      this.snapshot = {...this.snapshot, operation: null, error: error instanceof Error ? error.message : "Open failed"}
      this.send()
      return this.snapshot
    }
  }
}

registerMiniapp((session) => new StoreController(session).start())
