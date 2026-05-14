/**
 * @fileoverview MentraJSRouter — RN-side host that bridges the per-miniapp
 * JS contexts (iOS-JSC and Android-QuickJS via Zipline) into the existing
 * {@link LocalMiniappRuntime} handler set.
 *
 * Phase 2 strategy: rather than re-implement the 33 dispatch arms inline,
 * the router consumes Crust's `mentrajs_message` Expo event and forwards
 * its `__bridge.send(raw)` payloads to
 * {@link LocalMiniappRuntime.handleRawMessage}. The SDK envelope shape
 * (`{type: "DISPLAY", ...}` etc.) is unchanged from the WebView path, so
 * every existing handler runs verbatim. What changes is the *transport*:
 *
 *   - **Inbound** (background JS → host): `__dispatch("__bridge", "send",
 *     [rawJsonString])` → `mentrajs_message` event → router →
 *     `LocalMiniappRuntime.handleRawMessage(packageName, raw)`.
 *   - **Outbound** (host → background JS): every package registered with
 *     the router gets a `sendMessage(raw)` fn that calls
 *     `Crust.mentraJsDispatchToJs(packageName, {kind: "bridge", raw})`.
 *     The polyfill's `__deliver` recognises `kind === "bridge"` and calls
 *     `__mentraDeliverBridgeRaw(raw)`, which routes into the SDK's
 *     {@link DispatchTransport.onMessage} handler.
 *
 * Host-side handler bodies (display fan-out, mic state, transcription,
 * navigation, etc.) live untouched in `LocalMiniappRuntime.ts`. Phase 3
 * inverts the WebView lifecycle and at that point the old per-WebView
 * path can be retired; until then both routes coexist (a miniapp running
 * inside a WebView still works through the postMessage path; one running
 * inside a JSContext flows through here).
 *
 * Cloud-message routing (`phone_photo_ready`, `phone_stream_status`,
 * `phone_managed_stream_status`) goes straight through
 * `LocalMiniappRuntime.handleCloudMessage` — nothing for the router to
 * do; the responses arrive inside an envelope whose `sendMessage` was
 * already registered via the same path here.
 *
 * The router also bridges native error / log / unhandled-rejection
 * events (`iface: "__log"`, `iface: "__error"`) into the standard
 * `console.*` + Sentry breadcrumb pipeline so miniapp telemetry is
 * visible without bringing up a separate sink.
 */

import type {EventSubscription} from "expo-modules-core"

import type localMiniappRuntime from "./LocalMiniappRuntime"

/** The runtime's runtime instance type — the singleton exported from
 * LocalMiniappRuntime.ts (the file's `export default` is the instance,
 * not the class).
 */
type LocalMiniappRuntime = typeof localMiniappRuntime

/**
 * Minimal subset of the Crust native module the router uses. Keeping the
 * binding loose lets us mock the module in unit tests without bringing
 * the whole Expo module surface along.
 */
export interface MentraJSCrustBinding {
  mentraJsDispatchToJs(packageName: string, envelope: Record<string, unknown>): Promise<void> | void
  mentraJsSetManifest(packageName: string, permissions: string[]): Promise<void> | void
  mentraJsLoadPolyfillBundle?: () => string
  mentraJsSpawn?: (packageName: string, polyfill: string, miniappJs: string) => Promise<boolean> | boolean
  mentraJsKill?: (packageName: string) => Promise<void> | void
  mentraJsGrantPermission?: (packageName: string, permission: string, granted: boolean) => Promise<void> | void
  mentraJsAlivePackages?: () => string[]
  addListener: (event: string, handler: (payload: Record<string, unknown>) => void) => EventSubscription
}

export interface OutboundMessagePayload {
  packageName: string
  iface: string
  method: string
  argsJson?: string
  args?: unknown[]
  reqId?: string
  // Implementation-internal: any extra fields the dispatcher attached on
  // .forwardToRn (e.g. payload metadata) are passed through verbatim.
  [extra: string]: unknown
}

export type RouterLogger = {
  log: (message: string, payload?: unknown) => void
  warn: (message: string, payload?: unknown) => void
  error: (message: string, payload?: unknown) => void
}

const defaultLogger: RouterLogger = {
  // eslint-disable-next-line no-console
  log: (m, p) => console.log(`[MentraJSRouter] ${m}`, p ?? ""),
  // eslint-disable-next-line no-console
  warn: (m, p) => console.warn(`[MentraJSRouter] ${m}`, p ?? ""),
  // eslint-disable-next-line no-console
  error: (m, p) => console.error(`[MentraJSRouter] ${m}`, p ?? ""),
}

export class MentraJSRouter {
  private subscription: EventSubscription | null = null
  private readonly registered: Set<string> = new Set()

  constructor(
    private readonly runtime: LocalMiniappRuntime,
    private readonly crust: MentraJSCrustBinding,
    private readonly logger: RouterLogger = defaultLogger,
  ) {}

  /**
   * Subscribe to Crust's `mentrajs_message` event. Idempotent — calling
   * start() twice attaches a single listener.
   */
  start(): void {
    if (this.subscription) return
    this.subscription = this.crust.addListener("mentrajs_message", (raw) => {
      try {
        this.handleOutbound(raw as unknown as OutboundMessagePayload)
      } catch (e) {
        this.logger.error(`outbound handler threw`, {error: String(e), raw})
      }
    })
  }

  /**
   * Detach the Crust subscription. The router can be restarted later
   * with start(); registrations survive (the runtime's app map is the
   * source of truth).
   */
  stop(): void {
    this.subscription?.remove()
    this.subscription = null
  }

  /**
   * Register a JSContext with the runtime so its handlers can fire
   * `sendMessage(raw)` against the right context. The router builds a
   * `sendMessage` that calls `Crust.mentraJsDispatchToJs(packageName,
   * {kind: "bridge", raw})`; the polyfill's `__deliver` then hands the
   * envelope to `DispatchTransport.onMessage` inside the miniapp.
   *
   * Mirrors `MiniappHost.registerRuntime` on the WebView side. Callers
   * (e.g. {@link spawnAndRegister} below, or the host's miniapp launch
   * pipeline) should call this once per spawn.
   */
  registerApp(packageName: string): void {
    this.runtime.registerApp(packageName, (raw: string) => {
      this.dispatchBridgeRaw(packageName, raw)
    })
    this.registered.add(packageName)
  }

  /**
   * Convenience: spawn a JSContext via Crust, register the app, and
   * set its declared permissions. Returns true on successful spawn.
   *
   * The host's miniapp launch path (PR #2779 wired through
   * `mobile/src/services/miniapps/launchLocalMiniapp.ts`) should call
   * this once per JSContext mount instead of the WebView mount path
   * once Phase 3 ships.
   */
  async spawnAndRegister(
    packageName: string,
    miniappJs: string,
    options?: {permissions?: string[]},
  ): Promise<boolean> {
    if (!this.crust.mentraJsSpawn) {
      this.logger.warn("mentraJsSpawn not available — host binding missing native function")
      return false
    }
    const polyfill = this.crust.mentraJsLoadPolyfillBundle?.() ?? ""
    if (!polyfill) {
      this.logger.warn(`no polyfill bundle loaded for ${packageName}; spawn will likely fail`)
    }
    const ok = await this.crust.mentraJsSpawn(packageName, polyfill, miniappJs)
    if (!ok) {
      this.logger.error(`spawn failed for ${packageName}`)
      return false
    }
    if (options?.permissions && options.permissions.length > 0) {
      await this.crust.mentraJsSetManifest(packageName, options.permissions)
    }
    this.registerApp(packageName)
    return true
  }

  /**
   * Tear down a JSContext and unregister from the runtime. Synchronous
   * teardown — the spec drops the 50ms WILL_DISCONNECT grace window
   * because there's no transport handshake to flush in the JSC world.
   */
  async unregister(packageName: string): Promise<void> {
    if (!this.registered.has(packageName)) return
    this.runtime.unregisterApp(packageName)
    this.registered.delete(packageName)
    if (this.crust.mentraJsKill) {
      try {
        await this.crust.mentraJsKill(packageName)
      } catch (e) {
        this.logger.warn(`mentraJsKill threw for ${packageName}: ${String(e)}`)
      }
    }
  }

  /** List packages the router has registered. */
  registeredPackages(): string[] {
    return Array.from(this.registered)
  }

  // ----------------------------------------------------------------
  // Outbound message handling
  // ----------------------------------------------------------------

  private handleOutbound(msg: OutboundMessagePayload): void {
    const {packageName, iface, method} = msg
    if (!packageName || !iface || !method) {
      this.logger.warn(`bad mentrajs_message — missing fields`, msg)
      return
    }

    // 1) Bridge frames: the SDK's DispatchTransport.send(raw) lands here.
    //    Forward raw envelope into LocalMiniappRuntime.handleRawMessage
    //    so every existing handler arm runs verbatim.
    if (iface === "__bridge" && method === "send") {
      const raw = this.coerceArgsToBridgeRaw(msg)
      if (raw == null) {
        this.logger.warn(`__bridge.send had no raw payload`, msg)
        return
      }
      this.runtime.handleRawMessage(packageName, raw)
      return
    }

    // 2) Log frames — console.* rewired through host. We tag with the
    //    packageName so Sentry breadcrumbs can be filtered downstream.
    if (iface === "__log") {
      const args = this.tryParseArgs(msg.argsJson)
      const tag = `[${packageName}]`
      const fn = method === "warn" ? this.logger.warn : method === "error" ? this.logger.error : this.logger.log
      fn(`${tag} console.${method}`, args)
      return
    }

    // 3) Error / unhandled rejection frames — surface as warnings.
    if (iface === "__error") {
      const payload = this.tryParseArgs(msg.argsJson)
      this.logger.error(`[${packageName}] ${method}`, payload)
      return
    }

    // 4) Anything else is a `forwardToRn` from the dispatcher — that's a
    //    handler the native dispatcher didn't know about. In Phase 2 we
    //    don't have inline handlers for any of these; the runtime's
    //    existing path treats them as legacy WebView envelopes by
    //    falling through. Log so unknown ifaces surface in dev.
    this.logger.log(`unhandled iface=${iface} method=${method} from ${packageName}`)
  }

  /**
   * The wire format for `__bridge.send` is `argsJson = JSON.stringify([raw])`
   * — a single-element array containing the original raw envelope. The
   * dispatcher passes the parsed array through as either:
   *   - `msg.args` when the dispatcher unpacked (Android path that turns
   *     `argsJson` into a List on the way to RN), or
   *   - `msg.argsJson` (iOS path that ships the string verbatim).
   * Cover both shapes here.
   */
  private coerceArgsToBridgeRaw(msg: OutboundMessagePayload): string | null {
    if (Array.isArray(msg.args)) {
      const v = msg.args[0]
      return typeof v === "string" ? v : null
    }
    if (typeof msg.argsJson === "string") {
      try {
        const parsed = JSON.parse(msg.argsJson) as unknown
        if (Array.isArray(parsed) && typeof parsed[0] === "string") {
          return parsed[0]
        }
      } catch {
        // fall through
      }
    }
    return null
  }

  private tryParseArgs(argsJson: string | undefined): unknown {
    if (!argsJson) return null
    try {
      return JSON.parse(argsJson)
    } catch {
      return argsJson
    }
  }

  /**
   * Push a `kind="bridge"` envelope into the named JSContext's
   * `globalThis.__deliver`. Used both by the per-app `sendMessage`
   * registered via {@link registerApp} and by ad-hoc callers (e.g.
   * cloud-relayed `phone_photo_ready` responses route through
   * `LocalMiniappRuntime.handleCloudMessage`, which then calls the
   * `app.sendMessage(serialized)` registered above).
   */
  private dispatchBridgeRaw(packageName: string, raw: string): void {
    void this.crust.mentraJsDispatchToJs(packageName, {kind: "bridge", raw})
  }
}
