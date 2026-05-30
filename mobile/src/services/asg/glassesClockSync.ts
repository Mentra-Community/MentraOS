/**
 * Push phone time to glasses only when clock skew is detected (gallery sync, OTA, etc.).
 */

import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {BgTimer} from "@mentra/island"

import {useGlassesStore} from "@/stores/glasses"

import {detectClockSkew} from "./gallerySyncClock"

export const CLOCK_SETTLE_MS = 500

const OTA_CLOCK_FIX_COOLDOWN_MS = 30_000
let lastOtaClockFixAt = 0
// Coalesce concurrent OTA clock-fix attempts. Glasses can emit two clock_skew events
// back-to-back during BLE handshake; without this guard both would await the BLE fix
// + retry pair before either updated `lastOtaClockFixAt`.
let inflightOtaClockFix: Promise<boolean> | null = null

/** @internal test-only */
export function resetOtaClockFixCooldownForTests(): void {
  lastOtaClockFixAt = 0
  inflightOtaClockFix = null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => BgTimer.setTimeout(resolve, ms))
}

/**
 * Set glasses system clock from phone when skew is detected.
 */
export async function fixGlassesClockIfSkewed(glassesServerTime: number, lastSyncTime = 0): Promise<boolean> {
  const {skewed, reason} = detectClockSkew(Date.now(), glassesServerTime, lastSyncTime)
  if (!skewed) {
    return false
  }
  console.log(`[GlassesClockSync] ⏰ Clock skew detected (${reason}) — setting glasses time from phone`)
  await BluetoothSdk.setSystemTime(Date.now())
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

  const hasGlassesTime = typeof glassesTimeMs === "number" && Number.isFinite(glassesTimeMs) && glassesTimeMs > 0

  if (errorCode === "ssl_error") {
    if (!hasGlassesTime) {
      return false
    }
    const {skewed} = detectClockSkew(Date.now(), glassesTimeMs, 0)
    if (!skewed) {
      return false
    }
    console.log("[GlassesClockSync] ⏰ OTA ssl_error with wall-clock drift — treating as clock skew")
  } else if (errorCode !== "clock_skew") {
    return false
  }

  // Coalesce concurrent attempts: if a fix is already in flight, await its result instead
  // of racing it through the cooldown guard.
  if (inflightOtaClockFix) {
    return inflightOtaClockFix
  }

  const glassesTime = hasGlassesTime ? glassesTimeMs : Date.now() - 86_400_000

  inflightOtaClockFix = (async () => {
    try {
      const fixed = await fixGlassesClockIfSkewed(glassesTime, 0)
      if (!fixed) {
        return false
      }

      lastOtaClockFixAt = Date.now()
      console.log("[GlassesClockSync] ⏰ Retrying glasses OTA version check after clock fix")
      await BluetoothSdk.retryOtaVersionCheck()
      return true
    } finally {
      inflightOtaClockFix = null
    }
  })()

  return inflightOtaClockFix
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
    await BluetoothSdk.retryOtaVersionCheck()
  }

  return true
}
