export interface ForegroundLocationPermissionResponse {
  status: string
}

export interface ForegroundLocationPermissionClient {
  getForegroundPermissionsAsync(): Promise<ForegroundLocationPermissionResponse>
  requestForegroundPermissionsAsync(): Promise<ForegroundLocationPermissionResponse>
}

/**
 * Resolve foreground location permission without invoking an Activity-bound
 * Android permission request while the app is backgrounded.
 */
export async function resolveForegroundLocationPermission(
  client: ForegroundLocationPermissionClient,
  appState: string,
): Promise<ForegroundLocationPermissionResponse> {
  const current = await client.getForegroundPermissionsAsync()
  if (current.status === "granted" || appState !== "active") {
    return current
  }

  return client.requestForegroundPermissionsAsync()
}
