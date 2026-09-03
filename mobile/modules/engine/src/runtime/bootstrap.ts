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
  getSubjectToken?: () => Promise<{token: string; type: SubjectTokenType}>
  /** Supplies a token issued directly for Runtime in a Core-free deployment. */
  getRuntimeToken?: (opts?: {forceRefresh?: boolean}) => Promise<string>
  /** Stable, deployment-scoped local identity for bundled miniapp storage. */
  getUserId?: () => Promise<string> | string
  /**
   * Optional auth-session listener. Hosts that can emit auth changes should
   * wire this so engine can reconnect backend sessions after restored login
   * state lands post-boot.
   */
  onStateChange?: (callback: (event: string, session: {token?: string | null} | null) => void) => unknown
}

export interface IslandConfigValues {
  /** cloud-v2 core service base URL (defaults resolved by the cloud client). */
  coreUrl?: string | null
  /** cloud-v2 runtime service base URL. */
  runtimeUrl?: string | null
  /** Open Runtime's live WebSocket/audio session. Defaults to true. */
  runtimeRealtimeSession?: boolean
  /** Complete allowlist for bundled/local miniapps; null or omitted allows all. */
  localMiniappAllowlist?: string[] | null
  /** Optional per-package configuration supplied by the host deployment. */
  miniappConfiguration?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /** Deployment-scoped key for the persisted Core refresh token. */
  cloudAuthStorageKey?: string
  /** Deployment-pinned Mentra Live OTA manifest; explicit null disables remote OTA. */
  otaManifestUrl?: string | null
  /** Deployment capability policy. Omitted entries preserve consumer behavior. */
  features?: Partial<Record<IslandFeatureName, boolean>>
  /** OEM identifier (Mentra is OEM #0); reserved for OEM auth/telemetry. */
  oemId?: string
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

export type IslandFeatureName = "managedStreams" | "nativeMeetings" | "cloudSpeech" | "onDeviceSpeech" | "navigation"

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

export function isLocalMiniappAllowed(packageName: string): boolean {
  const allowlist = options?.config?.localMiniappAllowlist
  return allowlist == null || allowlist.includes(packageName)
}

/** Read a defensive package-scoped configuration snapshot. */
export function getMiniappConfiguration(packageName: string): Record<string, string> {
  const configuration = options?.config?.miniappConfiguration?.[packageName]
  return configuration ? {...configuration} : {}
}

export function isFeatureEnabled(feature: IslandFeatureName): boolean {
  return options?.config?.features?.[feature] !== false
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
