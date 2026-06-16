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
import {useSettingsStore, SETTINGS} from "../stores/settings"
import {cloudClientService} from "../services/CloudClientService"
import restComms from "../services/RestComms"

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
    if (urls.core && urls.runtime) cloudClientService.reconnect({core: urls.core, runtime: urls.runtime})
    else cloudClientService.reconnect()
  },

  /** The saved backend URLs (the dev URL-switcher list). */
  savedUrls: (): string[] => useSettingsStore.getState().getSetting(SETTINGS.saved_backend_urls.key) ?? [],

  /** Tear down + rebuild the live cloud client (the dev "reconnect" button). */
  reconnectCloud: (): void => cloudClientService.reconnect(),
}
