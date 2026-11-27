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
import {installMiniapp, isLocalNetworkMiniappUrl} from "../services/installMiniapp"
import {useAppStatusStore} from "../stores/apps"
import {scopeCloudUrlOverrides} from "../services/cloudEndpointPolicy"

type CloudUrlOverrides = {core?: string; runtime?: string}

/**
 * Reconnect the cloud client onto the current cloud-URL overrides. Explicit
 * partial overrides merge over the boot-resolved config (which carries the
 * host's Metro/env URL resolution); both empty clears the live override.
 */
function applyCloudUrlReconnect(urls: CloudUrlOverrides = currentCloudUrlOverrides()): void {
  const hostResolver = getConfigValues().resolveCloudEndpoints
  if (hostResolver) {
    cloudClientService.reconnect(null)
    return
  }
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
    const config = getConfigValues()
    if (config.resolveCloudEndpoints) {
      const scope = config.cloudDebugScope ?? ""
      const scoped = scopeCloudUrlOverrides(
        {
          scope: useSettingsStore.getState().getSetting(SETTINGS.cloud_url_deployment.key),
          ...currentCloudUrlOverrides(),
        },
        scope,
        urls,
      )
      const values: Record<string, unknown> = {
        [SETTINGS.cloud_url_deployment.key]: scope,
        [SETTINGS.cloud_core_url.key]: scoped.core,
        [SETTINGS.cloud_runtime_url.key]: scoped.runtime,
        [SETTINGS.cached_required_version.key]: "",
      }
      void useSettingsStore
        .getState()
        .setManyLocally(values)
        .then((result) => {
          if (result.is_error()) console.error("engine.dev.setCloudUrls: could not save URLs", result.error)
          else applyCloudUrlReconnect()
        })
      return
    }
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
   * Install the miniapp a developer's computer serves at a local address (the URL `mentra dev` prints), without
   * asking: the same install as scanning that URL (`engine.miniapps.install(url, {source: "local"})`). It installs as
   * a development build of the package its `miniapp.json` names, updates from that address, and appears in
   * `engine.miniapps`; a build installed from that address already, with what it serves now, stays as it is.
   *
   * It follows the rules of every development build: refused (`ok: false`) where the deployment doesn't allow
   * development, and while the package is installed with a publisher signature its build doesn't carry. `name` is
   * returned when given; otherwise the name its `miniapp.json` declares.
   */
  loadDevMiniapp: async (
    url: string,
    name?: string,
  ): Promise<{ok: true; packageName: string; name: string} | {ok: false; error: string}> => {
    const trimmed = url.trim()
    if (!trimmed) return {ok: false, error: "empty url"}
    const address = trimmed.endsWith("/") ? trimmed : `${trimmed}/`
    if (!isLocalNetworkMiniappUrl(address)) return {ok: false, error: `${trimmed} is not a local address`}
    try {
      const result = await installMiniapp(address, {source: "local"})
      await useAppStatusStore.getState().refresh()
      const installed = useAppStatusStore.getState().apps.find((app) => app.packageName === result.packageName)
      return {ok: true, packageName: result.packageName, name: name ?? installed?.name ?? result.packageName}
    } catch (error) {
      return {ok: false, error: error instanceof Error ? error.message : String(error)}
    }
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
