export interface ForegroundLocationPermissionResponse {
  status: string
}

export interface ForegroundLocationPermissionClient {
  getForegroundPermissionsAsync(): Promise<ForegroundLocationPermissionResponse>
  requestForegroundPermissionsAsync(): Promise<ForegroundLocationPermissionResponse>
}

/**
 * Resolve foreground location permission without invoking an Activity-bound
 * Android permission request while the app is backgrounded. With
 * `mayRequest: false` the current grant is returned and the OS is never asked.
 */
export async function resolveForegroundLocationPermission(
  client: ForegroundLocationPermissionClient,
  getAppState: () => string,
  options: {mayRequest?: boolean} = {},
): Promise<ForegroundLocationPermissionResponse> {
  const current = await client.getForegroundPermissionsAsync()
  if (current.status === "granted" || getAppState() !== "active" || options.mayRequest === false) {
    return current
  }

  return client.requestForegroundPermissionsAsync()
}

/**
 * A miniapp that declares LOCATION with `required: false` uses location only
 * when the wearer already allows it. The open-time permission check skips
 * optional permissions, so a background location poll must not raise the OS
 * prompt on its behalf either. Undeclared or required LOCATION keeps the
 * existing request-while-active behavior.
 */
export function mayRequestLocationFor(permissions?: Array<{type?: string; required?: boolean}>): boolean {
  const location = permissions?.find((permission) => permission.type?.toUpperCase() === "LOCATION")
  return location?.required !== false
}
