/**
 * What "Stop trying" on the glasses-reconnecting overlay should do.
 *
 * The overlay is global, so it also covers the Wi-Fi flow a miniapp opened via
 * `requestWifiSetup` (`/wifi/scan?returnToMiniapp=...`). Bailing out of that
 * flow must land the user back in the miniapp that asked — the same contract
 * `wifi/scan.tsx` honours for its own back button — not on Home with the
 * miniapp's UI silently dismissed.
 */
export async function stopTryingToReconnect(deps: {
  returnToMiniapp: string | undefined
  clearHistoryAndGoHome: (params?: {transition?: "fade"}) => void
  setForeground: (packageName: string) => Promise<void>
}): Promise<void> {
  if (deps.returnToMiniapp) {
    deps.clearHistoryAndGoHome({transition: "fade"})
    await deps.setForeground(deps.returnToMiniapp)
    return
  }
  deps.clearHistoryAndGoHome()
}

/** Expo router params arrive as string | string[]; keep only a single package name. */
export function readReturnToMiniapp(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0) return value[0]
  return undefined
}
