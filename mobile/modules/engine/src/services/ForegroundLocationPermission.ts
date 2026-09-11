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
  getAppState: () => string,
): Promise<ForegroundLocationPermissionResponse> {
  const current = await client.getForegroundPermissionsAsync()
  if (current.status === "granted" || getAppState() !== "active") {
    return current
  }

  return client.requestForegroundPermissionsAsync()
}
