export interface WifiAdbRequestDependencies {
  isSystemPackage: (packageName: string) => boolean
  setWifiAdbState: (enabled: boolean) => Promise<void>
}

export type WifiAdbRequestErrorCode = "NOT_PERMITTED" | "INVALID_ARGUMENT" | "INTERNAL"

export type WifiAdbRequestResult =
  | {ok: true}
  | {
      ok: false
      error: {code: WifiAdbRequestErrorCode; message: string}
    }

/** Apply the SYSTEM-only Wi-Fi ADB policy before calling the native SDK. */
export async function handleWifiAdbRequest(
  packageName: string,
  payload: Record<string, unknown>,
  dependencies: WifiAdbRequestDependencies,
): Promise<WifiAdbRequestResult> {
  if (!dependencies.isSystemPackage(packageName)) {
    return {
      ok: false,
      error: {
        code: "NOT_PERMITTED",
        message: "setWifiAdbState is restricted to system apps",
      },
    }
  }

  if (typeof payload.enabled !== "boolean") {
    return {
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        message: "enabled must be a boolean",
      },
    }
  }

  try {
    await dependencies.setWifiAdbState(payload.enabled)
    return {ok: true}
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: error instanceof Error ? error.message : "Wi-Fi ADB error",
      },
    }
  }
}
