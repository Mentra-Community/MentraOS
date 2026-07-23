/**
 * dev facade — `engine.dev`: developer/debug surface over engine-owned state.
 * Backend/cloud URL overrides read+write the engine settings store; the cloud
 * URL setters reconnect the engine-owned cloud client onto the new endpoints;
 *
 * NOTE: the dev-time endpoint *resolution* (Metro-host auto-detect, env defaults)
 * still lives host-side in `@/services/cloudClient` during the migration; this
 * facade manages the explicit overrides + reconnect.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {isGlassesReady} from "../services/GlassesReadiness"
import {useCloudClientStatusStore} from "../stores/cloudClientStatus"
import {useConnectionStore} from "../stores/connection"
import {useCoreStore} from "../stores/core"
import {useGlassesStore} from "../stores/glasses"
import {useSettingsStore, SETTINGS} from "../stores/settings"
import {cloudClientService} from "../services/CloudClientService"
import {getConfigValues} from "../runtime/bootstrap"
import {decideDevLaunchRoute} from "../utils/devMiniappLaunch"
import {registerDevApp, DEV_APP_PACKAGE_NAME, type DevAppRecord} from "../services/AppRegistry"
import {useAppStatusStore} from "../stores/apps"

type CloudUrlOverrides = {core?: string; runtime?: string}

/**
 * Reconnect the cloud client onto the current cloud-URL overrides. Explicit
 * partial overrides merge over the boot-resolved config (which carries the
 * host's Metro/env URL resolution); both empty clears the live override.
 */
function applyCloudUrlReconnect(urls: CloudUrlOverrides = currentCloudUrlOverrides()): void {
  const resolved = resolveCloudUrlReconnectTarget(urls)
  if (resolved === undefined) {
    cloudClientService.reconnect(null)
  } else if (resolved) {
    cloudClientService.reconnect(resolved)
  } else {
    console.warn("engine.dev.setCloudUrls: partial cloud override missing boot-resolved sibling endpoint")
  }
}

function currentCloudUrlOverrides(): CloudUrlOverrides {
  const s = useSettingsStore.getState()
  return {
    core: trimSetting(s.getSetting(SETTINGS.cloud_core_url.key)),
    runtime: trimSetting(s.getSetting(SETTINGS.cloud_runtime_url.key)),
  }
}

function resolveCloudUrlReconnectTarget(urls: CloudUrlOverrides): {core: string; runtime: string} | null | undefined {
  const core = trimSetting(urls.core)
  const runtime = trimSetting(urls.runtime)
  if (!core && !runtime) return undefined

  const config = getConfigValues()
  const resolvedCore = core || config.coreUrl?.trim()
  const resolvedRuntime = runtime || config.runtimeUrl?.trim()
  return resolvedCore && resolvedRuntime ? {core: resolvedCore, runtime: resolvedRuntime} : null
}

function trimSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function projectRuntimeStatus() {
  const core = useCoreStore.getState()
  const glasses = useGlassesStore.getState()
  const connection = useConnectionStore.getState()
  const cloudClient = useCloudClientStatusStore.getState()
  return {
    searching: core.searching,
    // Copy: the snapshot must not hand callers a mutable reference into the store.
    micRanking: [...core.micRanking],
    currentMic: core.currentMic,
    systemMicUnavailable: core.systemMicUnavailable,
    glassesConnected: glasses.connection.state === "connected",
    glassesFullyBooted: isGlassesReady(glasses.connection),
    bluetoothClassicConnected: glasses.bluetoothClassicConnected,
    coreStatus: connection.status,
    cloudClientStatus: cloudClient.status,
    cloudClientAudioTransport: cloudClient.audioTransport,
  }
}

export type DevRuntimeStatusSnapshot = ReturnType<typeof projectRuntimeStatus>

export const dev = {
  /** The cloud-v2 core/runtime URL overrides. */
  cloudUrls: (): {core?: string; runtime?: string} => {
    const s = useSettingsStore.getState()
    return {core: s.getSetting(SETTINGS.cloud_core_url.key), runtime: s.getSetting(SETTINGS.cloud_runtime_url.key)}
  },
  /** Override the cloud-v2 URLs and reconnect the live client onto them. */
  setCloudUrls: (urls: {core?: string; runtime?: string}) => {
    const next = {...currentCloudUrlOverrides(), ...urls}
    const resolved = resolveCloudUrlReconnectTarget(next)
    if (resolved === null) {
      console.warn("engine.dev.setCloudUrls: ignoring partial cloud override without a resolvable sibling endpoint")
      return
    }

    const s = useSettingsStore.getState()
    if (urls.core !== undefined) s.setSetting(SETTINGS.cloud_core_url.key, urls.core)
    if (urls.runtime !== undefined) s.setSetting(SETTINGS.cloud_runtime_url.key, urls.runtime)
    if (resolved === undefined) {
      cloudClientService.reconnect(null)
    } else {
      cloudClientService.reconnect(resolved)
    }
  },

  /** Tear down + rebuild the live cloud client (the dev "reconnect" button). */
  reconnectCloud: (): void => applyCloudUrlReconnect(),

  /** Current native (BLE-process) memory usage in MB — a dev/diagnostics gauge. */
  getMemoryMB: (): number => BluetoothSdk.getMemoryMB(),
  /**
   * Phone-side bluetooth runtime snapshot (the core store read-model: scan/mic/
   * search state) — the diagnostics/data-export surface. Shallow copy.
   */
  bluetoothStatus: (): Record<string, unknown> => {
    const {setCoreInfo: _setCoreInfo, reset: _reset, ...state} = useCoreStore.getState()
    return {...state}
  },

  /**
   * Side-load a miniapp being served from a dev machine (the `mentra dev` / CLI
   * flow) by its URL: probes `<url>/miniapp.json`, and on a reachable manifest
   * registers it under its manifest package so it appears in `engine.miniapps`
   * and can coexist with other dev miniapps. This is the OEM-host equivalent
   * of the first-party
   * developer-URL screen — the registration itself is engine-internal, so a
   * host reaches it here rather than the internal registry. Rendering still
   * flows through the normal display path once the miniapp is started.
   */
  loadDevMiniapp: async (
    url: string,
    name?: string,
  ): Promise<{ok: true; packageName: string; name: string} | {ok: false; error: string}> => {
    const devUrl = url.trim().replace(/\/+$/, "")
    if (!devUrl) return {ok: false, error: "empty url"}
    const result = await decideDevLaunchRoute("", devUrl)
    if (result.decision !== "live") {
      return {ok: false, error: "dev server unreachable, or no miniapp.json served there"}
    }
    const manifest = result.manifest
    // The `mentra-miniapp dev` server puts the hot-reload/log sidecar on the
    // user port PLUS ONE — same convention as the first-party developer-URL
    // screen's deriveDevPort.
    let devPort: number | undefined
    try {
      const parsed = Number(new URL(devUrl).port)
      devPort = Number.isFinite(parsed) && parsed > 0 ? parsed + 1 : undefined
    } catch {
      devPort = undefined
    }
    const appName = name ?? manifest.name ?? "Dev Miniapp"
    const packageName = (manifest.packageName as string | undefined) ?? DEV_APP_PACKAGE_NAME
    const existing = useAppStatusStore.getState().apps.find((app) => app.packageName === packageName)
    if (existing?.running) await useAppStatusStore.getState().stop(packageName)
    await registerDevApp({
      packageName,
      name: appName,
      iconUrl: manifest.icon ? new URL(manifest.icon, `${devUrl}/`).toString() : `${devUrl}/icon.png`,
      devUrl,
      devPort,
      type: manifest.type as DevAppRecord["type"],
      permissions: manifest.permissions as DevAppRecord["permissions"],
      hardwareRequirements: manifest.hardwareRequirements as DevAppRecord["hardwareRequirements"],
      actions: manifest.actions as DevAppRecord["actions"],
    })
    await useAppStatusStore.getState().refresh()
    return {ok: true, packageName, name: appName}
  },

  /** Current engine runtime status for engine-owned debug surfaces. */
  runtimeStatus: (): DevRuntimeStatusSnapshot => projectRuntimeStatus(),

  /** Subscribe to the projected engine runtime status; returns an unsubscribe. */
  onRuntimeStatus: (cb: (status: DevRuntimeStatusSnapshot) => void): (() => void) => {
    let last = JSON.stringify(projectRuntimeStatus())
    const notify = () => {
      const snap = projectRuntimeStatus()
      const key = JSON.stringify(snap)
      if (key === last) return
      last = key
      cb(snap)
    }
    const unsubscribers = [
      useCoreStore.subscribe(notify),
      useGlassesStore.subscribe(notify),
      useConnectionStore.subscribe(notify),
      useCloudClientStatusStore.subscribe(notify),
    ]
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  },
}
