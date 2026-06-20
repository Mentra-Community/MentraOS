/**
 * dev facade — `toolkit.dev`: developer/debug surface over island-owned state.
 * Backend/cloud URL overrides read+write the island settings store; the cloud
 * URL setters reconnect the island-owned cloud client onto the new endpoints;
 * `minimumClientVersion` hits the island RestComms.
 *
 * NOTE: the dev-time endpoint *resolution* (Metro-host auto-detect, env defaults)
 * still lives host-side in `@/services/cloudClient` during the migration; this
 * facade manages the explicit overrides + reconnect.
 */
import BluetoothSdk from "../../../bluetooth-sdk/build/_internal"
import {useSettingsStore, SETTINGS} from "../stores/settings"
import {cloudClientService} from "../services/CloudClientService"
import restComms from "../services/RestComms"
import {getConfigValues} from "../runtime/bootstrap"

/**
 * Reconnect the cloud client onto the current cloud-URL overrides. Explicit
 * partial overrides merge over the boot-resolved config (which carries the
 * host's Metro/env URL resolution); both empty clears the live override.
 */
function applyCloudUrlReconnect(): void {
  const s = useSettingsStore.getState()
  const core = trimSetting(s.getSetting(SETTINGS.cloud_core_url.key))
  const runtime = trimSetting(s.getSetting(SETTINGS.cloud_runtime_url.key))

  if (!core && !runtime) {
    cloudClientService.reconnect(null)
    return
  }

  const config = getConfigValues()
  const resolvedCore = core || config.coreUrl?.trim()
  const resolvedRuntime = runtime || config.runtimeUrl?.trim()
  if (resolvedCore && resolvedRuntime) {
    cloudClientService.reconnect({core: resolvedCore, runtime: resolvedRuntime})
  } else {
    // Keep the previous client if the host did not provide enough boot config to
    // complete a partial override; reconnecting with null would silently discard
    // the explicit side the user just set.
    console.warn("toolkit.dev.setCloudUrls: partial cloud override missing boot-resolved sibling endpoint")
  }
}

function trimSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

export const dev = {
  /** The backend's required/recommended client version. */
  minimumClientVersion: () => restComms.getMinimumClientVersion(),

  /** The configured backend (core REST) URL override, if any. */
  backendUrl: (): string | undefined => useSettingsStore.getState().getSetting(SETTINGS.backend_url.key),
  /** Override the backend (core REST) URL. */
  setBackendUrl: (url: string) => useSettingsStore.getState().setSetting(SETTINGS.backend_url.key, url),

  /** The cloud-v2 core/runtime URL overrides. */
  cloudUrls: (): {core?: string; runtime?: string} => {
    const s = useSettingsStore.getState()
    return {core: s.getSetting(SETTINGS.cloud_core_url.key), runtime: s.getSetting(SETTINGS.cloud_runtime_url.key)}
  },
  /** Override the cloud-v2 URLs and reconnect the live client onto them. */
  setCloudUrls: (urls: {core?: string; runtime?: string}) => {
    const s = useSettingsStore.getState()
    if (urls.core !== undefined) s.setSetting(SETTINGS.cloud_core_url.key, urls.core)
    if (urls.runtime !== undefined) s.setSetting(SETTINGS.cloud_runtime_url.key, urls.runtime)
    applyCloudUrlReconnect()
  },

  /** The saved backend URLs (the dev URL-switcher list). */
  savedUrls: (): string[] => useSettingsStore.getState().getSetting(SETTINGS.saved_backend_urls.key) ?? [],

  /** Tear down + rebuild the live cloud client (the dev "reconnect" button). */
  reconnectCloud: (): void => applyCloudUrlReconnect(),

  /** Current native (BLE-process) memory usage in MB — a dev/diagnostics gauge. */
  getMemoryMB: (): number => BluetoothSdk.getMemoryMB(),
}
