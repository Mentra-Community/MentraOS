import {useEffect, useRef} from "react"

import {useNavigationStore} from "@/stores/navigation"
import {Capabilities, getModelCapabilities} from "@/../../cloud/packages/types/src"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {SETTINGS, useSetting} from "@mentra/engine"
import showAlert from "@/utils/AlertUtils"
import {translate} from "@/i18n/translate"
import {usePathname} from "expo-router"
import {BgTimer, engine, type VersionInfo} from "@mentra/engine"

export {
  fetchVersionInfo,
  checkVersionUpdateAvailable,
  getLatestVersionInfo,
  findMatchingMtkPatch,
  checkBesUpdate,
  checkForOtaUpdate,
} from "@mentra/engine/internal"

function areGlassesConnectedNow(): boolean {
  return engine.ota.snapshot().connected
}

export function OtaUpdateChecker() {
  const {push} = useNavigationStore.getState()
  const pathname = usePathname()

  const otaSnapshot = useEngineSnapshot(engine.ota.snapshot, engine.ota.onSnapshot)

  // OTA check state from engine
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const glassesConnected = otaSnapshot.connected
  const buildNumber = otaSnapshot.buildNumber
  const glassesWifiConnected = otaSnapshot.wifiConnected
  const mtkFirmwareVersion = otaSnapshot.mtkFirmwareVersion
  const besFirmwareVersion = otaSnapshot.besFirmwareVersion

  // Keep a ref of the current pathname so async callbacks can check it
  const pathnameRef = useRef(pathname)
  useEffect(() => {
    pathnameRef.current = pathname
  }, [pathname])

  // Track OTA check state:
  // - hasCheckedOta: whether we've done the initial check
  // - hasPromptedOta: whether this check already surfaced an install prompt
  // - hasPromptedOtaWifiSetup: whether this check already surfaced the WiFi setup prompt
  // - pendingUpdate: cached update info to show when the user returns home
  const hasCheckedOta = useRef(false)
  const hasPromptedOta = useRef(false)
  const hasPromptedOtaWifiSetup = useRef(false)
  const pendingUpdate = useRef<{
    latestVersionInfo: VersionInfo
    updates: string[]
  } | null>(null)
  const otaCheckTimeoutRef = useRef<number | null>(null)

  // Reset OTA check flag when glasses disconnect (allows fresh check on reconnect)
  useEffect(() => {
    if (!glassesConnected) {
      // Always clear pendingUpdate on disconnect - it may be stale after OTA completes
      if (pendingUpdate.current) {
        console.log("OTA: Glasses disconnected - clearing pendingUpdate")
        pendingUpdate.current = null
      }
      if (hasCheckedOta.current) {
        console.log("OTA: Glasses disconnected - resetting check flag for next connection")
        hasCheckedOta.current = false
      }
      hasPromptedOta.current = false
      hasPromptedOtaWifiSetup.current = false
      // Clear any pending OTA check timeout
      if (otaCheckTimeoutRef.current) {
        BgTimer.clearTimeout(otaCheckTimeoutRef.current)
        otaCheckTimeoutRef.current = null
      }
      // Clear MTK session flag on disconnect (glasses rebooted, new version now active)
      const mtkWasUpdated = engine.ota.snapshot().mtkUpdatedThisSession
      if (mtkWasUpdated) {
        console.log("OTA: Clearing MTK session flag - glasses disconnected (likely rebooted)")
        engine.ota.markMtkUpdatedThisSession(false)
      }
    }
  }, [glassesConnected])

  // Track build/firmware versions to clear stale pendingUpdate when an update is applied
  const lastKnownVersionsRef = useRef<{build: string | null; mtk: string | null; bes: string | null}>({
    build: null,
    mtk: null,
    bes: null,
  })
  useEffect(() => {
    const last = lastKnownVersionsRef.current
    let versionChanged = false

    // Check if any version changed from what we knew
    if (buildNumber && last.build && last.build !== buildNumber) {
      console.log(`OTA: Build number changed from ${last.build} to ${buildNumber}`)
      versionChanged = true
    }
    if (mtkFirmwareVersion && last.mtk && last.mtk !== mtkFirmwareVersion) {
      console.log(`OTA: MTK firmware changed from ${last.mtk} to ${mtkFirmwareVersion}`)
      versionChanged = true
    }
    if (besFirmwareVersion && last.bes && last.bes !== besFirmwareVersion) {
      console.log(`OTA: BES firmware changed from ${last.bes} to ${besFirmwareVersion}`)
      versionChanged = true
    }

    if (versionChanged) {
      console.log("OTA: Version changed - clearing stale pendingUpdate and resetting check flag")
      pendingUpdate.current = null
      hasCheckedOta.current = false
      hasPromptedOta.current = false
      hasPromptedOtaWifiSetup.current = false
    }

    // Update tracked versions
    if (buildNumber) last.build = buildNumber
    if (mtkFirmwareVersion) last.mtk = mtkFirmwareVersion
    if (besFirmwareVersion) last.bes = besFirmwareVersion
  }, [buildNumber, mtkFirmwareVersion, besFirmwareVersion])

  // Show pending update alert when user navigates back to /home.
  const wasAwayFromHomeRef = useRef(false)
  useEffect(() => {
    if (pathname !== "/home") {
      wasAwayFromHomeRef.current = true
      return
    }
    const pending = pendingUpdate.current
    if (!pending) return
    const returnedHome = wasAwayFromHomeRef.current
    wasAwayFromHomeRef.current = false

    // Fire when returning to home, or when WiFi becomes connected while a
    // pending update is already waiting on home.
    if (!returnedHome && !glassesWifiConnected) return

    if (!glassesConnected) return
    if (hasPromptedOta.current) return

    // Last-moment imperative check: reactive glassesConnected can be stale if
    // disconnect and navigation happen in the same render cycle.
    if (!areGlassesConnectedNow()) return
    if (!engine.ota.snapshot().wifiConnected) {
      console.log("OTA: Pending update is waiting for glasses WiFi before showing install prompt")
      return
    }

    console.log("OTA: User returned to home with pending update - showing alert")
    const deviceName = defaultWearable || "Glasses"
    const updateCount = pending.updates.length
    const updateMessage = superMode
      ? `Updates available: ${pending.updates.join(", ").toUpperCase()}`
      : updateCount === 1
      ? "1 update available"
      : `${updateCount} updates available`
    pendingUpdate.current = null
    hasPromptedOta.current = true
    hasPromptedOtaWifiSetup.current = false

    showAlert(translate("ota:updateAvailable", {deviceName}), updateMessage, [
      {text: translate("ota:updateLater"), style: "cancel"},
      {text: translate("ota:install"), onPress: () => push("/ota/check-for-updates")},
    ])
  }, [pathname, glassesConnected, glassesWifiConnected, defaultWearable, superMode, push])

  // Main OTA check effect
  useEffect(() => {
    // Log every effect run with full state for debugging
    // console.log(
    //   `OTA: effect triggered - pathname: ${pathname}, hasChecked: ${hasCheckedOta.current}, connected: ${glassesConnected}, build: ${buildNumber}`,
    // )

    // only check if we're on the home screen:
    if (pathname !== "/home") {
      return
    }

    // OTA check (only for glasses supported by the ASG OTA flow)
    if (hasCheckedOta.current) {
      // console.log("OTA: check skipped - already checked this session")
      return
    }
    if (!glassesConnected || !buildNumber) {
      // console.log(`OTA: check skipped - missing data (connected: ${glassesConnected}, build: ${buildNumber})`)
      return
    }

    const features: Capabilities = getModelCapabilities(defaultWearable)
    if (!features?.hasOta) {
      // console.log("OTA: check skipped - device doesn't support ASG OTA")
      return
    }

    // Clear any existing timeout
    if (otaCheckTimeoutRef.current) {
      BgTimer.clearTimeout(otaCheckTimeoutRef.current)
    }

    // Delay OTA check by 500ms to allow all version_info chunks to arrive
    // (version_info_1, version_info_2, version_info_3 arrive sequentially with ~100ms gaps)
    console.log("OTA: check scheduled - waiting 500ms for firmware version info...")
    otaCheckTimeoutRef.current = BgTimer.setTimeout(async () => {
      // Re-check conditions after delay (glasses might have disconnected)
      if (!areGlassesConnectedNow()) {
        console.log("OTA: check cancelled - glasses disconnected during delay")
        return
      }
      if (hasCheckedOta.current) {
        console.log("OTA: check cancelled - already checked")
        return
      }

      console.log("OTA: check starting")
      hasCheckedOta.current = true // Mark as checked to prevent duplicate checks

      engine.ota
        .checkForUpdates({
          waitForBuildNumberMs: 0,
          waitForBesVersionMs: 5000,
          waitForMtkVersionMs: 0,
          refreshVersionInfo: false,
        })
        .then(({updateAvailable, latestVersionInfo, updates, skippedReason}) => {
          if (skippedReason) {
            console.log(`OTA: check skipped - ${skippedReason}`)
            return
          }
          console.log(
            `OTA: check completed - updateAvailable: ${updateAvailable}, updates: ${updates?.join(", ") || "none"}`,
          )

          if (updates.length === 0 || !latestVersionInfo) {
            console.log("OTA: check result: No updates available")
            return
          }

          // Verify glasses are still connected before showing alert
          const currentlyConnected = areGlassesConnectedNow()
          if (!currentlyConnected) {
            console.log("OTA: update found but glasses disconnected - skipping alert")
            return
          }
          if (hasPromptedOta.current) {
            console.log("OTA: update found but prompt already shown - skipping duplicate alert")
            return
          }

          // Only show update alert on the homepage - user may have navigated away during async check
          if (pathnameRef.current !== "/home") {
            console.log(`OTA: update found but not on homepage (${pathnameRef.current}) - caching for later`)
            pendingUpdate.current = {latestVersionInfo, updates}
            return
          }

          const deviceName = defaultWearable || "Glasses"
          // Super mode shows technical details (APK, MTK, BES), normal mode shows simple count
          const updateCount = updates.length
          const updateList = updates.join(", ").toUpperCase() // "APK, MTK, BES"
          const updateMessage = superMode
            ? `Updates available: ${updateList}`
            : updateCount === 1
            ? "1 update available"
            : `${updateCount} updates available`

          pendingUpdate.current = {latestVersionInfo, updates}

          if (engine.ota.snapshot().wifiConnected) {
            console.log("OTA: Update available and glasses are on WiFi - prompting install")
            pendingUpdate.current = null
            hasPromptedOta.current = true
            hasPromptedOtaWifiSetup.current = false
            showAlert(translate("ota:updateAvailable", {deviceName}), updateMessage, [
              {text: translate("ota:updateLater"), style: "cancel"},
              {text: translate("ota:install"), onPress: () => push("/ota/check-for-updates")},
            ])
            return
          }

          // No WiFi path: prompt user to connect/setup WiFi.
          if (hasPromptedOtaWifiSetup.current) {
            console.log("OTA: WiFi setup prompt already shown for pending update - skipping duplicate")
            return
          }
          console.log("OTA: Update available and glasses are not on WiFi - prompting WiFi setup")
          const wifiMessage = superMode
            ? `Updates available: ${updateList}\n\nConnect your ${deviceName} to WiFi to install.`
            : `${updateMessage}\n\nConnect your ${deviceName} to WiFi to install.`
          hasPromptedOtaWifiSetup.current = true
          showAlert(translate("ota:updateAvailable", {deviceName}), wifiMessage, [
            {
              text: translate("ota:updateLater"),
              style: "cancel",
              onPress: () => {
                pendingUpdate.current = null // Clear pending on dismiss
                hasPromptedOtaWifiSetup.current = false
              },
            },
            {text: translate("ota:setupWifi"), onPress: () => push("/wifi/scan")},
          ])
        })
        .catch((error) => {
          console.log(`OTA: check failed with error: ${error?.message || error}`)
        })
    }, 500) // Delay to allow version_info_3 to arrive

    // Cleanup timeout on effect re-run or unmount
    return () => {
      if (otaCheckTimeoutRef.current) {
        BgTimer.clearTimeout(otaCheckTimeoutRef.current)
        otaCheckTimeoutRef.current = null
      }
    }
  }, [
    glassesConnected,
    buildNumber,
    mtkFirmwareVersion,
    besFirmwareVersion,
    glassesWifiConnected,
    defaultWearable,
    pathname,
    push,
    superMode,
  ])

  return null
}
