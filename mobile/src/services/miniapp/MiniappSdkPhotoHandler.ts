/**
 * MiniappSdkPhotoHandler — handles takePhoto() requests from local miniapps.
 * Calls POST /api/client/miniapp-sdk-photo/request on the cloud, then waits for
 * phone_photo_ready over the WS (handled by SocketComms -> LocalMiniappRuntime).
 * The photoUrl on phone_photo_ready is a short-TTL signed R2 URL.
 */

import {useSettingsStore, SETTINGS} from "@/stores/settings"

interface PhotoRequestParams {
  requestId: string
  packageName: string
  size?: string
  compress?: string
  saveToGallery?: boolean
  sound?: boolean
}

export async function requestMiniappSdkPhoto(params: PhotoRequestParams): Promise<{accepted: boolean; requestId: string}> {
  const backendUrl = useSettingsStore.getState().getSetting(SETTINGS.backend_url.key)
  const coreToken = useSettingsStore.getState().getSetting(SETTINGS.core_token.key)

  if (!backendUrl || !coreToken) {
    throw new Error("Missing backend_url or core_token")
  }

  const response = await fetch(`${backendUrl}/api/client/miniapp-sdk-photo/request`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${coreToken}`,
    },
    body: JSON.stringify(params),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({error: response.statusText}))
    throw new Error(error.error || `HTTP ${response.status}`)
  }

  return response.json()
}
