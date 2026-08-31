/**
 * Bootstrap — the engine's single front door (`engine.configure` / `start` / `stop`).
 *
 * The host hands engine auth + config + analytics in one call; engine owns the
 * runtime construction behind `start()`. Internal services read this holder
 * directly instead of exposing host-facing adapter bags.
 */

export type SubjectTokenType = "supabase" | "authing" | (string & {})

export interface IslandAuth {
  /** Returns the host's current (auto-refreshed) subject token for the backend. */
  getSubjectToken: () => Promise<{token: string; type: SubjectTokenType}>
  /**
   * Optional auth-session listener. Hosts that can emit auth changes should
   * wire this so engine can reconnect backend sessions after restored login
   * state lands post-boot.
   */
  onStateChange?: (callback: (event: string, session: {token?: string | null} | null) => void) => unknown
}

export interface IslandConfigValues {
  /** cloud-v2 core service base URL (defaults resolved by the cloud client). */
  coreUrl?: string
  /** Independently deployed Mentra Miniapp Store backend URL. */
  storeUrl?: string
  /** cloud-v2 runtime service base URL. */
  runtimeUrl?: string
  /** OEM identifier (Mentra is OEM #0); reserved for OEM auth/telemetry. */
  oemId?: string
  /** User-facing host version used to reject miniapps requiring a newer host. */
  hostVersion?: string
  /** Semver range of Mentra Miniapp SDK bundle ABIs this host can execute. */
  supportedMiniappSdkRange?: string
  /** Package identities backed by miniapp ZIPs shipped in this host build. */
  bundledSystemMiniappPackages?: readonly string[]
  /** Build-selected Store packages; each must also be a bundled SYSTEM package. */
  bundledStoreMiniappPackages?: readonly string[]
  /** Build-owned SYSTEM package -> bundled Store package allowed to update it. */
  bundledSystemMiniappStoreOwners?: Readonly<Record<string, string>>
  /** Build-pinned Ed25519 publisher fingerprint for every bundled SYSTEM package. */
  bundledSystemMiniappPublisherKeys?: Readonly<Record<string, string>>
  /**
   * LC3 frame size (bytes) the phone's mic encoder emits — announced to the
   * cloud on connect (20 for G1, 40 for G2, …). Defaults to 20 if unset.
   */
  audioFrameSizeBytes?: number
  /**
   * Dev-only live Metro/LAN host used to repair persisted local-miniapp dev URLs
   * after the laptop changes networks. Omitted in production/OEM builds.
   */
  devServerHost?: () => string | undefined
}

export type IslandAnalytics = (event: string, props?: Record<string, unknown>) => void

/**
 * Named host-UI seams: engine dispatches the runtime request, the host owns the
 * screen/navigation/branding. Keep each entry a single narrow purpose — this is
 * a contract of specific UI capabilities, not a generic runtime-hook bag.
 */
export interface IslandUiSeams {
  /**
   * `session.glasses.requestWifiSetup` — open the host's glasses Wi-Fi setup
   * flow. Absent ⇒ miniapps get NOT_IMPLEMENTED for the request.
   */
  requestWifiSetup?: (reason?: string, packageName?: string) => Promise<void> | void
  /**
   * `session.system.scanQr` — open a phone-camera QR scanner overlay. Must NOT
   * clear miniapp foreground: UI_CLOSE on a live call hangs it up. Absent ⇒
   * miniapps get NOT_IMPLEMENTED.
   */
  scanQr?: (options?: ScanQrOptions) => Promise<ScanQrResult>
}

export interface ScanQrOptions {
  title?: string
  hint?: string
}

export type ScanQrResult = {data: string} | {cancelled: true}

export interface IslandConfigureOptions {
  /** REQUIRED — the only must-have seam. The host owns login; engine owns the rest. */
  auth: IslandAuth
  config?: IslandConfigValues
  analytics?: IslandAnalytics
  ui?: IslandUiSeams
}

let options: IslandConfigureOptions | null = null
let started = false

/**
 * Hand engine its auth + config + analytics. Call once, before `start()`.
 *
 * Reconfiguring a RUNNING runtime is not supported: services capture pieces of
 * this config as they build (e.g. the cloud client's endpoints), so swapping the
 * options mid-run would split-brain the runtime (`getAuth()`/`getConfigValues()`
 * report values the running services never consumed). Ignored with a warning
 * while started; after `stop()`, `configure()` + `start()` begin a fresh cycle.
 */
export function configure(opts: IslandConfigureOptions): void {
  if (started) {
    console.warn("engine.configure() called after engine.start(); ignored — stop() the runtime before reconfiguring")
    return
  }
  options = opts
}

/**
 * Merge host-UI seams after configure/start. UI capabilities (scan overlay,
 * wifi setup) are looked up per request, so this is safe on a running runtime.
 * Used so Metro reloads can attach seams that missed the original configure().
 */
export function updateUiSeams(ui: IslandUiSeams): void {
  if (!options) {
    console.warn("engine.updateUiSeams() called before engine.configure(); ignored")
    return
  }
  options = {...options, ui: {...options.ui, ...ui}}
}

/** Mark the runtime started. Idempotent. */
export async function start(): Promise<void> {
  if (started) return
  if (!options) {
    throw new Error("engine.start() called before engine.configure()")
  }
  started = true
}

/** Tear down. Idempotent. */
export async function stop(): Promise<void> {
  started = false
}

export function isStarted(): boolean {
  return started
}

/** Test-only: wipe configure state so suites can start from a cold host. */
export function resetForTests(): void {
  options = null
  started = false
}

/** The host-supplied auth provider, or null if not configured yet. */
export function getAuth(): IslandAuth | null {
  return options?.auth ?? null
}

export function getConfigValues(): IslandConfigValues {
  return options?.config ?? {}
}

export function getAnalytics(): IslandAnalytics | null {
  return options?.analytics ?? null
}

/** The host-supplied UI seams ({} until configure() provides them). */
export function getUiSeams(): IslandUiSeams {
  return options?.ui ?? {}
}
