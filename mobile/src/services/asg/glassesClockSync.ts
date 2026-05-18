/**
 * Push phone time to glasses only when clock skew is detected (gallery sync, OTA, etc.).
 */

import CoreModule from "@mentra/bluetooth-sdk"
import {BgTimer} from "@mentra/island"

import {useGlassesStore} from "@/stores/glasses"

import {detectClockSkew} from "./gallerySyncClock"

export const CLOCK_SETTLE_MS = 500

const OTA_CLOCK_FIX_COOLDOWN_MS = 30_000
let lastOtaClockFixAt = 0

/** @internal test-only */
export function resetOtaClockFixCooldownForTests(): void {
  lastOtaClockFixAt = 0
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => BgTimer.setTimeout(resolve, ms))
}

/**
 * Set glasses system clock from phone when skew is detected.
 */
export async function fixGlassesClockIfSkewed(
  glassesServerTime: number,
  lastSyncTime = 0,
): Promise<boolean> {
  const {skewed, reason} = detectClockSkew(Date.now(), glassesServerTime, lastSyncTime)
  if (!skewed) {
    return false
  }
  console.log(`[GlassesClockSync] ⏰ Clock skew detected (${reason}) — setting glasses time from phone`)
  await CoreModule.setSystemTime(Date.now())
  await delay(CLOCK_SETTLE_MS)
  return true
}

/**
 * After glasses report OTA failure due to clock skew, fix time and re-run background version check.
 */
export async function handleOtaClockSkewFromGlasses(
  errorCode: string | undefined,
  glassesTimeMs?: number,
): Promise<boolean> {
  if (Date.now() - lastOtaClockFixAt < OTA_CLOCK_FIX_COOLDOWN_MS) {
    return false
  }

  const glassesTime =
    typeof glassesTimeMs === "number" && glassesTimeMs > 0 ? glassesTimeMs : Date.now() - 86_400_000

  if (errorCode === "ssl_error") {
    const {skewed} = detectClockSkew(Date.now(), glassesTime, 0)
    if (!skewed) {
      return false
    }
    console.log("[GlassesClockSync] ⏰ OTA ssl_error with wall-clock drift — treating as clock skew")
  } else if (errorCode !== "clock_skew") {
    return false
  }

  const fixed = await fixGlassesClockIfSkewed(glassesTime, 0)
  if (!fixed) {
    return false
  }

  lastOtaClockFixAt = Date.now()
  console.log("[GlassesClockSync] ⏰ Retrying glasses OTA version check after clock fix")
  await CoreModule.retryOtaVersionCheck()
  return true
}

/**
 * Proactive fix when version_info includes glasses system_time_ms (e.g. before background OTA prefetch).
 */
export async function maybeFixGlassesClockFromVersionInfo(systemTimeMs: number | undefined): Promise<boolean> {
  if (typeof systemTimeMs !== "number" || systemTimeMs <= 0) {
    return false
  }

  const fixed = await fixGlassesClockIfSkewed(systemTimeMs, 0)
  if (!fixed) {
    return false
  }

  if (useGlassesStore.getState().wifi.state === "connected") {
    console.log("[GlassesClockSync] ⏰ Glasses on WiFi — retrying OTA version check after clock fix")
    await CoreModule.retryOtaVersionCheck()
  }

  return true
}
