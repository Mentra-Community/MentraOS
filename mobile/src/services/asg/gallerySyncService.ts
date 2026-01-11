/**
 * Gallery Sync Service
 * Orchestrates gallery sync independently of UI lifecycle
 */

import NetInfo from "@react-native-community/netinfo"
import CoreModule from "core"
import {AppState, AppStateStatus, Platform} from "react-native"
import WifiManager from "react-native-wifi-reborn"

import {useGallerySyncStore, HotspotInfo} from "@/stores/gallerySync"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {PhotoInfo} from "@/types/asg"
import {showAlert} from "@/utils/AlertUtils"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
// import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils" // Disabled - WiFi alerts removed
import {MediaLibraryPermissions} from "@/utils/permissions/MediaLibraryPermissions"

import {asgCameraApi} from "./asgCameraApi"
import {gallerySettingsService} from "./gallerySettingsService"
import {gallerySyncNotifications} from "./gallerySyncNotifications"
import {localStorageService} from "./localStorageService"
import {checkFeaturePermissions, requestFeaturePermissions, PermissionFeatures} from "@/utils/PermissionsUtils"

// Timing constants
const TIMING = {
  HOTSPOT_CONNECT_DELAY_MS: 1000,
  HOTSPOT_REQUEST_TIMEOUT_MS: 30000, // Timeout waiting for hotspot to enable
  WIFI_CONNECTION_TIMEOUT_MS: 30000,
  RETRY_DELAY_MS: 2000,
  MAX_QUEUE_AGE_MS: 2 * 60 * 1000, // 2 min - glasses hotspot auto-disables after 40s inactivity
  // iOS WiFi connection timing - the system shows a dialog that user must accept
  IOS_WIFI_RETRY_DELAY_MS: 3000, // Wait for user to interact with iOS dialog
  IOS_WIFI_MAX_RETRIES: 5, // Retry multiple times to give user time to accept
  // WiFi initialization cooldown - prevents repeated "enable WiFi" alerts while WiFi is initializing
  WIFI_COOLDOWN_MS: 3000, // Wait 3 seconds after user visits WiFi settings before showing alert again
} as const

class GallerySyncService {
  private static instance: GallerySyncService
  private hotspotListenerRegistered = false
  private hotspotConnectionTimeout: ReturnType<typeof setTimeout> | null = null
  private hotspotRequestTimeout: ReturnType<typeof setTimeout> | null = null
  private abortController: AbortController | null = null
  private isInitialized = false
  private glassesStoreUnsubscribe: (() => void) | null = null
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null
  private waitingForWifiRetry = false
  private wifiSettingsOpenedAt: number | null = null // Timestamp when user was sent to WiFi settings

  private constructor() {}

  static getInstance(): GallerySyncService {
    if (!GallerySyncService.instance) {
      GallerySyncService.instance = new GallerySyncService()
    }
    return GallerySyncService.instance
  }

  /**
   * Initialize the service - register event listeners
   */
  initialize(): void {
    if (this.isInitialized) return

    // Listen for hotspot status changes
    GlobalEventEmitter.addListener("hotspot_status_change", this.handleHotspotStatusChange)
    GlobalEventEmitter.addListener("hotspot_error", this.handleHotspotError)
    GlobalEventEmitter.addListener("gallery_status", this.handleGalleryStatus)

    // Subscribe to glasses store to detect disconnection during sync
    this.glassesStoreUnsubscribe = useGlassesStore.subscribe(
      (state) => state.connected,
      (connected, prevConnected) => {
        // Only trigger on disconnect (was connected, now not connected)
        if (prevConnected && !connected) {
          this.handleGlassesDisconnected()
        }
      },
    )

    // Listen for app state changes to auto-retry sync after user enables WiFi
    this.appStateSubscription = AppState.addEventListener("change", this.handleAppStateChange)

    this.hotspotListenerRegistered = true
    this.isInitialized = true

    console.log("[GallerySyncService] Initialized")

    // Check for resumable sync on startup
    this.checkForResumableSync()
  }

  /**
   * Cleanup - remove event listeners
   */
  cleanup(): void {
    if (this.hotspotListenerRegistered) {
      GlobalEventEmitter.removeListener("hotspot_status_change", this.handleHotspotStatusChange)
      GlobalEventEmitter.removeListener("hotspot_error", this.handleHotspotError)
      GlobalEventEmitter.removeListener("gallery_status", this.handleGalleryStatus)
      this.hotspotListenerRegistered = false
    }

    if (this.glassesStoreUnsubscribe) {
      this.glassesStoreUnsubscribe()
      this.glassesStoreUnsubscribe = null
    }

    if (this.appStateSubscription) {
      this.appStateSubscription.remove()
      this.appStateSubscription = null
    }

    if (this.hotspotConnectionTimeout) {
      clearTimeout(this.hotspotConnectionTimeout)
      this.hotspotConnectionTimeout = null
    }

    if (this.hotspotRequestTimeout) {
      clearTimeout(this.hotspotRequestTimeout)
      this.hotspotRequestTimeout = null
    }

    this.isInitialized = false
    console.log("[GallerySyncService] Cleaned up")
  }

  /**
   * Handle glasses disconnection during sync
   */
  private handleGlassesDisconnected = (): void => {
    const store = useGallerySyncStore.getState()

    // Only handle if we're actively syncing
    if (!this.isSyncing()) {
      return
    }

    console.log("[GallerySyncService] Glasses disconnected during sync - cancelling")
    store.setSyncError("Glasses disconnected")

    // Abort ongoing downloads
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    // Clear timeouts
    if (this.hotspotConnectionTimeout) {
      clearTimeout(this.hotspotConnectionTimeout)
      this.hotspotConnectionTimeout = null
    }
    if (this.hotspotRequestTimeout) {
      clearTimeout(this.hotspotRequestTimeout)
      this.hotspotRequestTimeout = null
    }

    gallerySyncNotifications.showSyncError("Glasses disconnected")
  }

  /**
   * Handle app state changes to auto-retry sync when user returns from settings
   */
  private handleAppStateChange = async (nextAppState: AppStateStatus): Promise<void> => {
    // Only handle when app comes to foreground
    if (nextAppState !== "active") {
      return
    }

    // Only auto-retry if we were waiting for WiFi
    if (!this.waitingForWifiRetry) {
      return
    }

    console.log("[GallerySyncService] App returned to foreground - checking if WiFi is enabled")

    const store = useGallerySyncStore.getState()
    const glassesStore = useGlassesStore.getState()

    // Check if glasses are still connected
    if (!glassesStore.connected) {
      console.log("[GallerySyncService] Glasses disconnected - not retrying sync")
      this.waitingForWifiRetry = false
      return
    }

    // Check if WiFi is now enabled (Android only)
    // Use retry logic because WiFi status takes time to propagate after user enables it
    if (Platform.OS === "android") {
      const MAX_RETRIES = 5
      const RETRY_DELAY_MS = 1000 // Wait 500ms between checks

      console.log("[GallerySyncService] Waiting for WiFi to initialize (may take a moment after enabling)...")

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))

          const netState = await NetInfo.fetch()
          console.log(
            `[GallerySyncService] WiFi check attempt ${attempt}/${MAX_RETRIES}: enabled=${netState.isWifiEnabled}`,
          )

          if (netState.isWifiEnabled === true) {
            console.log("[GallerySyncService] ✅ WiFi is now enabled - auto-retrying sync")
            this.waitingForWifiRetry = false
            this.wifiSettingsOpenedAt = null // Clear cooldown timestamp
            // Clear previous error state
            store.setSyncState("idle")
            // Auto-retry sync
            await this.startSync()
            return
          }

          // If this was the last attempt, log and give up
          if (attempt === MAX_RETRIES) {
            console.log(
              "[GallerySyncService] ❌ WiFi still disabled after all retries - user may need to tap sync manually",
            )
            this.waitingForWifiRetry = false
            this.wifiSettingsOpenedAt = null // Clear cooldown timestamp
          }
        } catch (error) {
          console.warn(`[GallerySyncService] Failed to check WiFi status on attempt ${attempt}:`, error)
          // Continue to next retry
        }
      }
    }
  }

  /**
   * Handle gallery status from glasses
   */
  private handleGalleryStatus = (data: any): void => {
    console.log("[GallerySyncService] Received gallery_status:", data)

    const store = useGallerySyncStore.getState()
    store.setGlassesGalleryStatus(data.photos || 0, data.videos || 0, data.total || 0, data.has_content || false)
  }

  /**
   * Handle hotspot status change event
   */
  private handleHotspotStatusChange = async (eventData: any): Promise<void> => {
    console.log("[GallerySyncService] Hotspot status changed:", eventData)

    const store = useGallerySyncStore.getState()

    // Only process if we're in a connecting state
    if (store.syncState !== "requesting_hotspot" && store.syncState !== "connecting_wifi") {
      console.log("[GallerySyncService] Ignoring hotspot event - not in connecting state")
      return
    }

    if (!eventData.enabled || !eventData.ssid || !eventData.password) {
      console.log("[GallerySyncService] Hotspot not ready yet")
      return
    }

    // Clear the hotspot request timeout since we got a response
    if (this.hotspotRequestTimeout) {
      clearTimeout(this.hotspotRequestTimeout)
      this.hotspotRequestTimeout = null
    }

    const hotspotInfo: HotspotInfo = {
      ssid: eventData.ssid,
      password: eventData.password,
      ip: eventData.local_ip,
    }

    store.setHotspotInfo(hotspotInfo)

    // Wait for hotspot to become discoverable
    console.log("[GallerySyncService] Hotspot enabled, waiting before connecting...")

    if (this.hotspotConnectionTimeout) {
      clearTimeout(this.hotspotConnectionTimeout)
    }

    this.hotspotConnectionTimeout = setTimeout(() => {
      this.connectToHotspotWifi(hotspotInfo)
      this.hotspotConnectionTimeout = null
    }, TIMING.HOTSPOT_CONNECT_DELAY_MS)
  }

  /**
   * Handle hotspot error event
   */
  private handleHotspotError = (eventData: any): void => {
    console.error("[GallerySyncService] Hotspot error:", eventData)

    const store = useGallerySyncStore.getState()

    if (this.hotspotConnectionTimeout) {
      clearTimeout(this.hotspotConnectionTimeout)
      this.hotspotConnectionTimeout = null
    }

    store.setSyncError(eventData.error_message || "Failed to start hotspot")
    gallerySyncNotifications.showSyncError("Failed to start hotspot")
  }

  /**
   * Start the sync process
   */
  async startSync(): Promise<void> {
    const store = useGallerySyncStore.getState()
    const glassesStore = useGlassesStore.getState()

    // Check if already syncing
    if (store.syncState === "syncing" || store.syncState === "connecting_wifi") {
      console.log("[GallerySyncService] Already syncing, ignoring start request")
      return
    }

    // Check if glasses are connected
    if (!glassesStore.connected) {
      store.setSyncError("Glasses not connected")
      return
    }

    console.log("[GallerySyncService] Starting sync...")

    // Request all permissions upfront so user isn't interrupted during WiFi/download
    // 1. Notification permission (for background sync progress)
    await gallerySyncNotifications.requestPermissions()

    // 2. Location permission (required to read WiFi SSID for hotspot verification)
    const hasLocationPermission = await checkFeaturePermissions(PermissionFeatures.LOCATION)
    if (!hasLocationPermission) {
      console.log("[GallerySyncService] Requesting location permission upfront...")
      const granted = await requestFeaturePermissions(PermissionFeatures.LOCATION)
      if (!granted) {
        console.log("[GallerySyncService] Location permission denied - WiFi SSID verification may fail")
        // Don't block sync - we'll try anyway and fall back to IP-based verification if needed
      }
    }

    // 3. Camera roll permission (if auto-save is enabled)
    const shouldAutoSave = await gallerySettingsService.getAutoSaveToCameraRoll()
    if (shouldAutoSave) {
      const hasPermission = await MediaLibraryPermissions.checkPermission()
      if (!hasPermission) {
        console.log("[GallerySyncService] Requesting camera roll permission upfront...")
        const granted = await MediaLibraryPermissions.requestPermission()
        if (!granted) {
          console.log("[GallerySyncService] Camera roll permission denied - photos will still sync to app")
          // Don't block sync - photos will still be downloaded to app storage
          // They just won't be saved to the camera roll
        }
      }
    }

    // Reset abort controller
    this.abortController = new AbortController()

    // COOLDOWN CHECK: If user just went to WiFi settings, show a "please wait" message
    // This prevents showing "enable WiFi" alert repeatedly while WiFi is initializing
    if (Platform.OS === "android" && this.wifiSettingsOpenedAt) {
      const timeSinceSettingsOpened = Date.now() - this.wifiSettingsOpenedAt
      const cooldownRemaining = TIMING.WIFI_COOLDOWN_MS - timeSinceSettingsOpened

      if (cooldownRemaining > 0) {
        console.log(
          `[GallerySyncService] WiFi cooldown active (${Math.round(cooldownRemaining / 1000)}s remaining) - showing wait message`,
        )

        showAlert("Please Wait", "WiFi is initializing. Please wait a moment before trying to sync again.", [
          {text: "OK"},
        ])

        return
      } else {
        // Cooldown expired, clear the timestamp
        console.log("[GallerySyncService] WiFi cooldown expired - resuming normal behavior")
        this.wifiSettingsOpenedAt = null
      }
    }

    // DISABLED: Pre-flight WiFi check on Android BEFORE any connection attempts
    // This prevents sync failures even when we think we're already connected
    // (cached connection state can be stale if WiFi was disabled)
    // if (Platform.OS === "android") {
    //   try {
    //     const netState = await NetInfo.fetch()
    //     console.log(`[GallerySyncService] WiFi enabled status:`, netState.isWifiEnabled)
    //
    //     if (netState.isWifiEnabled === false) {
    //       console.error("[GallerySyncService] WiFi is disabled - cannot sync")
    //
    //       // Mark that we're waiting for WiFi so we can auto-retry when user returns
    //       this.waitingForWifiRetry = true
    //
    //       // Show styled alert with option to open settings
    //       showAlert(
    //         "WiFi is Disabled",
    //         "Please enable WiFi to sync photos from your glasses. Would you like to open WiFi settings?",
    //         [
    //           {
    //             text: "Cancel",
    //             style: "cancel",
    //             onPress: () => {
    //               this.waitingForWifiRetry = false
    //               this.wifiSettingsOpenedAt = null
    //               store.setSyncError("WiFi disabled - enable WiFi and try again")
    //             },
    //           },
    //           {
    //             text: "Open Settings",
    //             onPress: async () => {
    //               // Set timestamp so we can enforce cooldown on next sync attempt
    //               this.wifiSettingsOpenedAt = Date.now()
    //               await SettingsNavigationUtils.openWifiSettings()
    //               store.setSyncError("Enable WiFi and try sync again")
    //             },
    //           },
    //         ],
    //         {cancelable: false},
    //       )
    //
    //       // Return early - do NOT proceed with sync
    //       return
    //     } else {
    //       // WiFi is enabled - clear any cooldown timestamp
    //       this.wifiSettingsOpenedAt = null
    //     }
    //   } catch (error) {
    //     console.warn("[GallerySyncService] Failed to check WiFi status:", error)
    //     // Continue with sync attempt - don't block if check fails
    //   }
    // }

    // Check if already connected to hotspot
    // IMPORTANT: We must verify the phone's WiFi is actually connected to the hotspot SSID,
    // not just that the glasses reported hotspot is enabled (which persists across app restarts)
    let isAlreadyConnected = false
    if (glassesStore.hotspotEnabled && glassesStore.hotspotGatewayIp && glassesStore.hotspotSsid) {
      try {
        const currentSSID = await WifiManager.getCurrentWifiSSID()
        console.log(
          `[GallerySyncService] Checking hotspot connection - current SSID: "${currentSSID}", hotspot SSID: "${glassesStore.hotspotSsid}"`,
        )
        isAlreadyConnected = currentSSID === glassesStore.hotspotSsid
        if (!isAlreadyConnected && currentSSID) {
          console.log(
            `[GallerySyncService] Phone is on different network (${currentSSID}), will request hotspot connection`,
          )
        }
      } catch (error) {
        console.log("[GallerySyncService] Could not verify current WiFi SSID:", error)
        // If we can't verify, don't assume we're connected - request hotspot
        isAlreadyConnected = false
      }
    }

    if (isAlreadyConnected) {
      console.log("[GallerySyncService] Already connected to hotspot, starting download directly")
      const hotspotInfo: HotspotInfo = {
        ssid: glassesStore.hotspotSsid,
        password: glassesStore.hotspotPassword,
        ip: glassesStore.hotspotGatewayIp,
      }
      store.setHotspotInfo(hotspotInfo)
      store.setSyncState("connecting_wifi")
      await this.startFileDownload(hotspotInfo)
      return
    }

    // Request hotspot
    store.setRequestingHotspot()
    store.setSyncServiceOpenedHotspot(true)

    // Set timeout for hotspot request - if we don't get a response, fail gracefully
    this.hotspotRequestTimeout = setTimeout(() => {
      const currentStore = useGallerySyncStore.getState()
      if (currentStore.syncState === "requesting_hotspot") {
        console.error("[GallerySyncService] Hotspot request timed out")
        currentStore.setSyncError("Hotspot request timed out")
        currentStore.setSyncServiceOpenedHotspot(false)
        gallerySyncNotifications.showSyncError("Could not start hotspot - please try again")
      }
      this.hotspotRequestTimeout = null
    }, TIMING.HOTSPOT_REQUEST_TIMEOUT_MS)

    try {
      await CoreModule.setHotspotState(true)
      console.log("[GallerySyncService] Hotspot requested")
    } catch (error) {
      // Clear the timeout since we got an immediate error
      if (this.hotspotRequestTimeout) {
        clearTimeout(this.hotspotRequestTimeout)
        this.hotspotRequestTimeout = null
      }
      console.error("[GallerySyncService] Failed to request hotspot:", error)
      store.setSyncError("Failed to start hotspot")
      store.setSyncServiceOpenedHotspot(false)
    }
  }

  /**
   * Connect to hotspot WiFi with retry logic (unified for both platforms)
   * Both iOS and Android benefit from retries:
   * - iOS: Library throws "internal error" before user responds to system dialog
   * - Android: Hotspot needs time to initialize, especially when glasses WiFi was cold
   */
  private async connectToHotspotWifi(hotspotInfo: HotspotInfo): Promise<void> {
    const store = useGallerySyncStore.getState()
    let lastError: any = null

    console.log(`[GallerySyncService] Connecting to WiFi: ${hotspotInfo.ssid}`)
    store.setSyncState("connecting_wifi")

    for (let attempt = 1; attempt <= TIMING.IOS_WIFI_MAX_RETRIES; attempt++) {
      // Check if cancelled
      if (this.abortController?.signal.aborted) {
        store.setSyncError("Sync cancelled")
        return
      }

      try {
        console.log(
          `[GallerySyncService] 📡 WiFi connection attempt ${attempt}/${TIMING.IOS_WIFI_MAX_RETRIES} (${Platform.OS})`,
        )
        console.log(`[GallerySyncService] 📡 Target SSID: "${hotspotInfo.ssid}"`)
        console.log(`[GallerySyncService] 📡 Target IP: ${hotspotInfo.ip}`)

        // Check current WiFi state before attempting connection
        try {
          const preConnectSSID = await WifiManager.getCurrentWifiSSID()
          console.log(`[GallerySyncService] 📡 Pre-connection WiFi SSID: "${preConnectSSID}"`)
        } catch (preError: any) {
          console.log(`[GallerySyncService] ⚠️ Could not get pre-connection SSID: ${preError?.message}`)
        }

        // Use connectToProtectedSSID with joinOnce=false for persistent connection
        console.log(`[GallerySyncService] 🔌 Calling WifiManager.connectToProtectedSSID...`)
        const connectStartTime = Date.now()

        await WifiManager.connectToProtectedSSID(hotspotInfo.ssid, hotspotInfo.password, false, false)

        const connectDuration = Date.now() - connectStartTime
        console.log(`[GallerySyncService] ✅ WifiManager.connectToProtectedSSID returned after ${connectDuration}ms`)
        console.log(`[GallerySyncService] 📝 Note: On iOS, this does NOT guarantee actual connection!`)

        // iOS-specific: Verify actual WiFi connection by polling SSID
        // The library promise resolves when iOS ACCEPTS the request, not when connection completes
        if (Platform.OS === "ios") {
          console.log(`[GallerySyncService] 🍎 iOS: Starting connection verification...`)
          console.log(`[GallerySyncService] 🍎 Will poll getCurrentWifiSSID() for up to 15 seconds`)

          const maxVerifyAttempts = 30 // 30 × 500ms = 15 seconds
          let connected = false
          let lastSeenSSID = "unknown"

          for (let i = 0; i < maxVerifyAttempts; i++) {
            try {
              const currentSSID = await WifiManager.getCurrentWifiSSID()
              lastSeenSSID = currentSSID || "null"

              console.log(
                `[GallerySyncService] 🍎 Verify poll ${i + 1}/${maxVerifyAttempts}: Current="${currentSSID}", Target="${hotspotInfo.ssid}"`,
              )

              if (currentSSID === hotspotInfo.ssid) {
                console.log(
                  `[GallerySyncService] 🍎 ✅ VERIFICATION SUCCESS! Connected to target network after ${(i + 1) * 500}ms`,
                )
                connected = true
                break
              } else if (i === 0 && currentSSID === lastSeenSSID) {
                console.log(
                  `[GallerySyncService] 🍎 ⚠️ Still on original network - iOS dialog may not have appeared yet`,
                )
              }
            } catch (ssidError: any) {
              console.log(`[GallerySyncService] 🍎 ⚠️ Poll ${i + 1}: Could not check SSID: ${ssidError?.message}`)
              lastSeenSSID = "error"
            }

            // Don't wait after last attempt
            if (i < maxVerifyAttempts - 1) {
              await new Promise((resolve) => setTimeout(resolve, 500))
            }
          }

          if (!connected) {
            console.error(`[GallerySyncService] 🍎 ❌ VERIFICATION FAILED after 15 seconds`)
            console.error(`[GallerySyncService] 🍎 Last seen SSID: "${lastSeenSSID}"`)
            console.error(`[GallerySyncService] 🍎 Expected SSID: "${hotspotInfo.ssid}"`)
            console.error(`[GallerySyncService] 🍎 Possible causes:`)
            console.error(`[GallerySyncService] 🍎   1. User did not tap "Join" on iOS WiFi dialog`)
            console.error(`[GallerySyncService] 🍎   2. iOS dialog did not appear (permission issue?)`)
            console.error(`[GallerySyncService] 🍎   3. iOS refused to switch networks`)
            throw new Error(`iOS WiFi verification failed - still on "${lastSeenSSID}", expected "${hotspotInfo.ssid}"`)
          }
        }

        console.log(`[GallerySyncService] ✅ Connected to hotspot WiFi (${Platform.OS})`)

        // Final verification: Check SSID one more time before starting download
        try {
          const finalSSID = await WifiManager.getCurrentWifiSSID()
          console.log(`[GallerySyncService] 📶 Final SSID check before download: "${finalSSID}"`)
          if (finalSSID !== hotspotInfo.ssid) {
            console.error(
              `[GallerySyncService] ❌ SSID mismatch detected! Expected "${hotspotInfo.ssid}", got "${finalSSID}"`,
            )
            throw new Error(`WiFi SSID mismatch - connected to "${finalSSID}" instead of "${hotspotInfo.ssid}"`)
          }
        } catch (finalError: any) {
          console.warn(`[GallerySyncService] ⚠️ Could not perform final SSID check: ${finalError?.message}`)
          // Continue anyway - we've done our best to verify
        }

        // iOS-specific: Wait for actual network connectivity to glasses
        // Even though SSID is correct, iOS needs time for routing tables to update
        // We actively probe the glasses HTTP server until it's reachable
        if (Platform.OS === "ios") {
          console.log(`[GallerySyncService] 🍎 Waiting for iOS network routes to glasses IP...`)
          console.log(`[GallerySyncService] 🍎 Will probe http://${hotspotInfo.ip}:8089/api/health`)

          const maxProbeAttempts = 20 // 20 attempts × 500ms = 10 seconds max
          let networkReady = false

          for (let probeNum = 1; probeNum <= maxProbeAttempts; probeNum++) {
            try {
              console.log(`[GallerySyncService] 🍎 Connectivity probe ${probeNum}/${maxProbeAttempts}...`)

              // Try to reach the glasses health endpoint with a short timeout
              const probeController = new AbortController()
              const probeTimeout = setTimeout(() => probeController.abort(), 1000) // 1 second timeout per probe

              const probeStartTime = Date.now()
              const probeResponse = await fetch(`http://${hotspotInfo.ip}:8089/api/health`, {
                method: "GET",
                signal: probeController.signal,
              })
              clearTimeout(probeTimeout)

              const probeDuration = Date.now() - probeStartTime
              console.log(
                `[GallerySyncService] 🍎 Probe ${probeNum} response: HTTP ${probeResponse.status} (${probeDuration}ms)`,
              )

              if (probeResponse.status === 200 || probeResponse.status === 404) {
                // 200 = health endpoint exists, 404 = glasses responded (no health endpoint)
                // Either way, network is working!
                console.log(`[GallerySyncService] 🍎 ✅ Network connectivity verified after ${probeNum} probes!`)
                networkReady = true
                break
              }
            } catch (probeError: any) {
              const errorMsg = probeError?.message || "unknown"
              console.log(
                `[GallerySyncService] 🍎 Probe ${probeNum} failed: ${errorMsg.substring(0, 50)}${errorMsg.length > 50 ? "..." : ""}`,
              )
              // Continue to next probe
            }

            // Wait 500ms before next probe (unless this was the last attempt)
            if (probeNum < maxProbeAttempts) {
              await new Promise((resolve) => setTimeout(resolve, 500))
            }
          }

          if (!networkReady) {
            console.error(
              `[GallerySyncService] 🍎 ❌ Network connectivity probe failed after ${maxProbeAttempts} attempts`,
            )
            console.error(`[GallerySyncService] 🍎 iOS routing tables may not be ready for ${hotspotInfo.ip}`)
            throw new Error(
              `iOS network not ready - could not reach ${hotspotInfo.ip}:8089 after ${maxProbeAttempts} attempts`,
            )
          }
        }

        // Start the actual download
        console.log(`[GallerySyncService] 🚀 Starting file download from ${hotspotInfo.ip}:8089`)
        await this.startFileDownload(hotspotInfo)
        return // Success - exit the retry loop
      } catch (error: any) {
        lastError = error
        console.log(
          `[GallerySyncService] WiFi attempt ${attempt} failed (${Platform.OS}):`,
          error?.message || error?.code || "unknown error",
        )

        // If user explicitly denied, don't retry
        if (error?.code === "userDenied" || error?.message?.includes("cancel")) {
          console.log("[GallerySyncService] User cancelled WiFi connection")
          store.setSyncError("WiFi connection cancelled")
          if (store.syncServiceOpenedHotspot) {
            await this.closeHotspot()
          }
          return
        }

        // DISABLED: Check if WiFi was disabled during connection attempt (Android 10+ specific error)
        // if (Platform.OS === "android" && error?.message?.includes("enable wifi manually")) {
        //   console.error("[GallerySyncService] WiFi was disabled during connection")
        //
        //   // Mark that we're waiting for WiFi so we can auto-retry when user returns
        //   this.waitingForWifiRetry = true
        //
        //   showAlert("WiFi Required", "WiFi must be enabled to sync photos. Please enable WiFi and try again.", [
        //     {
        //       text: "Cancel",
        //       style: "cancel",
        //       onPress: () => {
        //         this.waitingForWifiRetry = false
        //         this.wifiSettingsOpenedAt = null
        //         store.setSyncError("WiFi disabled - enable WiFi and try again")
        //         if (store.syncServiceOpenedHotspot) {
        //           this.closeHotspot()
        //         }
        //       },
        //     },
        //     {
        //       text: "Open Settings",
        //       onPress: async () => {
        //         // Set timestamp so we can enforce cooldown on next sync attempt
        //         this.wifiSettingsOpenedAt = Date.now()
        //         await SettingsNavigationUtils.openWifiSettings()
        //         store.setSyncError("Enable WiFi and try sync again")
        //         if (store.syncServiceOpenedHotspot) {
        //           await this.closeHotspot()
        //         }
        //       },
        //     },
        //   ])
        //   return
        // }

        // Let connection fail naturally and show generic error
        if (Platform.OS === "android" && error?.message?.includes("enable wifi manually")) {
          console.error("[GallerySyncService] WiFi was disabled during connection")
          store.setSyncError("Could not connect - check WiFi is enabled")
          if (store.syncServiceOpenedHotspot) {
            await this.closeHotspot()
          }
          return
        }

        // For "internal error" or "unableToConnect", wait and retry
        // iOS: Gives user time to interact with system dialog
        // Android: Gives hotspot time to fully initialize and start broadcasting
        if (attempt < TIMING.IOS_WIFI_MAX_RETRIES) {
          const reason =
            Platform.OS === "ios" ? "user may be seeing system dialog" : "hotspot may still be initializing"
          console.log(`[GallerySyncService] Waiting ${TIMING.IOS_WIFI_RETRY_DELAY_MS}ms before retry (${reason})...`)
          await new Promise((resolve) => setTimeout(resolve, TIMING.IOS_WIFI_RETRY_DELAY_MS))
        }
      }
    }

    // All retries exhausted
    console.error(`[GallerySyncService] WiFi connection failed after all retries (${Platform.OS}):`, lastError)
    store.setSyncError(
      lastError?.message?.includes("internal error")
        ? "Could not connect to glasses WiFi. Please ensure you accept the WiFi prompt when it appears."
        : lastError?.message || "Failed to connect to glasses WiFi",
    )

    if (store.syncServiceOpenedHotspot) {
      await this.closeHotspot()
    }
  }

  /**
   * Start downloading files
   */
  private async startFileDownload(hotspotInfo: HotspotInfo): Promise<void> {
    const store = useGallerySyncStore.getState()

    console.log(`[GallerySyncService] Starting file download from ${hotspotInfo.ip}`)

    try {
      // Set up the API client
      asgCameraApi.setServer(hotspotInfo.ip, 8089)

      // Get sync state and files to download
      // IMPORTANT: This creates a SNAPSHOT of files at this moment based on last_sync_time.
      // Any photos taken AFTER this call (during the sync) will NOT be included in this sync.
      // They will be detected in the next sync when we query gallery status again.
      const syncState = await localStorageService.getSyncState()
      const syncResponse = await asgCameraApi.syncWithServer(syncState.client_id, syncState.last_sync_time, true)

      const syncData = syncResponse.data || syncResponse

      if (!syncData.changed_files || syncData.changed_files.length === 0) {
        console.log("[GallerySyncService] No files to sync")
        store.setSyncComplete()
        await this.onSyncComplete(0, 0)
        return
      }

      const filesToSync = syncData.changed_files
      // console.log(`[GallerySyncService] 🔄 Found ${filesToSync.length} files to sync from server`)
      // console.log(`[GallerySyncService] 📊 Server returned these files:`)
      // filesToSync.slice(0, 10).forEach((file: any, idx: number) => {
      //   console.log(
      //     `[GallerySyncService]   ${idx + 1}. ${file.name} (${file.is_video ? "video" : "photo"}, ${file.size} bytes, modified: ${file.modified})`,
      //   )
      // })
      // if (filesToSync.length > 10) {
      //   console.log(`[GallerySyncService]   ... and ${filesToSync.length - 10} more files`)
      // }

      // Update store with files
      store.setSyncing(filesToSync)

      // Save queue for resume capability
      await localStorageService.saveSyncQueue({
        files: filesToSync,
        currentIndex: 0,
        startedAt: Date.now(),
        hotspotInfo,
      })

      // Show notification
      await gallerySyncNotifications.showSyncStarted(filesToSync.length)

      // Execute the download
      await this.executeDownload(filesToSync, syncData.server_time)
    } catch (error: any) {
      console.error("[GallerySyncService] Failed to start download:", error)
      store.setSyncError(error?.message || "Failed to start download")
      await gallerySyncNotifications.showSyncError("Failed to start download")

      if (store.syncServiceOpenedHotspot) {
        await this.closeHotspot()
      }
    }
  }

  /**
   * Execute the actual file download
   */
  private async executeDownload(files: PhotoInfo[], serverTime: number): Promise<void> {
    const store = useGallerySyncStore.getState()
    const settingsStore = useSettingsStore.getState()
    const defaultWearable = settingsStore.getSetting(SETTINGS.default_wearable.key)

    let downloadedCount = 0
    let failedCount = 0

    // Check if auto-save to camera roll is enabled (we'll save each file immediately after download)
    const shouldAutoSave = await gallerySettingsService.getAutoSaveToCameraRoll()
    let cameraRollSavedCount = 0
    let cameraRollFailedCount = 0

    try {
      const downloadResult = await asgCameraApi.batchSyncFiles(
        files,
        true,
        (current, total, fileName, fileProgress, downloadedFile) => {
          // CRITICAL: This callback MUST NOT be async!
          // RNFS progress callbacks cannot handle async errors properly and will crash with null error codes.
          // All async operations inside must be wrapped in try-catch and not propagate errors.

          // Check if cancelled
          if (this.abortController?.signal.aborted) {
            throw new Error("Sync cancelled")
          }

          // Update store
          const currentStore = useGallerySyncStore.getState()

          if (fileProgress === 0 || fileProgress === undefined) {
            // Starting a new file - but only mark previous complete if this is a NEW file
            // (not just another 0% progress report for the same file)
            // This prevents double-counting when both batchSyncFiles and RNFS report 0%
            const isNewFile = currentStore.currentFile !== fileName

            if (isNewFile) {
              // Mark previous file as complete when moving to next
              if (current > 1 && currentStore.currentFile) {
                currentStore.onFileComplete(currentStore.currentFile)
                // Persist queue index so we can resume from here if app is killed
                localStorageService.updateSyncQueueIndex(current - 1).catch((err) => {
                  console.error("[GallerySyncService] Failed to persist queue index:", err)
                })
              }
              // Now set the new current file
              currentStore.setCurrentFile(fileName, 0)
            }
          } else {
            currentStore.onFileProgress(fileName, fileProgress || 0)
          }

          // When file completes (100%), update it in the queue with downloaded paths
          if (fileProgress === 100 && downloadedFile) {
            // Update file with local paths and URLs for immediate preview display
            const localFileUrl = downloadedFile.filePath
              ? downloadedFile.filePath.startsWith("file://")
                ? downloadedFile.filePath
                : `file://${downloadedFile.filePath}`
              : downloadedFile.url

            const localThumbnailUrl = downloadedFile.thumbnailPath
              ? downloadedFile.thumbnailPath.startsWith("file://")
                ? downloadedFile.thumbnailPath
                : `file://${downloadedFile.thumbnailPath}`
              : undefined

            const updatedFile = {
              ...downloadedFile,
              url: localFileUrl, // Update URL to local file for immediate preview
              download: localFileUrl, // Update download URL for videos
              filePath: downloadedFile.filePath,
              thumbnailPath: localThumbnailUrl,
            }
            currentStore.updateFileInQueue(fileName, updatedFile)

            // 🎯 IMMEDIATELY save to camera roll if auto-save is enabled
            if (shouldAutoSave && downloadedFile.filePath) {
              // Parse the capture timestamp from the photo metadata
              let captureTime: number | undefined
              if (downloadedFile.modified) {
                captureTime =
                  typeof downloadedFile.modified === "string"
                    ? parseInt(downloadedFile.modified, 10)
                    : downloadedFile.modified
                if (isNaN(captureTime)) {
                  console.warn(
                    `[GallerySyncService] Invalid modified timestamp for ${downloadedFile.name}:`,
                    downloadedFile.modified,
                  )
                  captureTime = undefined
                }
              }

              // Save to camera roll immediately (non-blocking)
              MediaLibraryPermissions.saveToLibrary(downloadedFile.filePath, captureTime)
                .then((success) => {
                  if (success) {
                    cameraRollSavedCount++
                    console.log(
                      `[GallerySyncService] ✅ Saved to camera roll immediately: ${downloadedFile.name} (${cameraRollSavedCount} total)`,
                    )
                  } else {
                    cameraRollFailedCount++
                    console.warn(`[GallerySyncService] ❌ Failed to save to camera roll: ${downloadedFile.name}`)
                  }
                })
                .catch((error) => {
                  cameraRollFailedCount++
                  console.error(`[GallerySyncService] ❌ Error saving to camera roll: ${downloadedFile.name}`, error)
                })
            }
          }

          // Update notification
          gallerySyncNotifications.updateProgress(current, total, fileName, fileProgress || 0)
        },
      )

      downloadedCount = downloadResult.downloaded.length
      failedCount = downloadResult.failed.length

      // Mark the last file as complete (if any files were downloaded)
      if (downloadResult.downloaded.length > 0) {
        const lastFileName = downloadResult.downloaded[downloadResult.downloaded.length - 1]?.name
        if (lastFileName) {
          const currentStore = useGallerySyncStore.getState()
          currentStore.onFileComplete(lastFileName)
        }
      }

      // Save downloaded files metadata
      // console.log(`[GallerySyncService] 💾 Saving metadata for ${downloadResult.downloaded.length} downloaded files...`)
      for (const photoInfo of downloadResult.downloaded) {
        // console.log(
        //   `[GallerySyncService] 📝 Processing: ${photoInfo.name} (${photoInfo.is_video ? "video" : "photo"}, ${photoInfo.size} bytes)`,
        // )
        const downloadedFile = localStorageService.convertToDownloadedFile(
          photoInfo,
          photoInfo.filePath || "",
          photoInfo.thumbnailPath,
          defaultWearable,
        )
        await localStorageService.saveDownloadedFile(downloadedFile)
      }
      // console.log(`[GallerySyncService] ✅ Finished saving metadata for all files`)

      // Update queue index to final position
      await localStorageService.updateSyncQueueIndex(files.length)

      // Mark failed files in store
      for (const failedFileName of downloadResult.failed) {
        const currentStore = useGallerySyncStore.getState()
        currentStore.onFileFailed(failedFileName)
      }

      // Camera roll saves already happened immediately after each download (if enabled)
      if (shouldAutoSave) {
        console.log(
          `[GallerySyncService] 📸 Camera roll immediate save summary: ${cameraRollSavedCount} saved, ${cameraRollFailedCount} failed`,
        )
      }

      // Update sync state
      const currentSyncState = await localStorageService.getSyncState()
      await localStorageService.updateSyncState({
        last_sync_time: serverTime,
        total_downloaded: currentSyncState.total_downloaded + downloadedCount,
        total_size: currentSyncState.total_size + downloadResult.total_size,
      })

      // Complete
      store.setSyncComplete()
      await this.onSyncComplete(downloadedCount, failedCount)
    } catch (error: any) {
      if (error?.message === "Sync cancelled") {
        console.log("[GallerySyncService] Sync was cancelled")
        store.setSyncCancelled()
        await gallerySyncNotifications.showSyncCancelled()
      } else {
        console.error("[GallerySyncService] Download failed:", error)
        store.setSyncError(error?.message || "Download failed")
        await gallerySyncNotifications.showSyncError(error?.message || "Download failed")
      }

      if (store.syncServiceOpenedHotspot) {
        await this.closeHotspot()
      }
    }
  }

  /**
   * Auto-save downloaded files to camera roll
   *
   * ⚠️ DEPRECATED: This method is no longer used. Photos are now saved to camera roll
   * immediately after each download completes (see executeDownload method).
   *
   * NOTE: Files now download in chronological order (oldest first), so the immediate-save
   * approach will also save them in chronological order to the system gallery.
   */
  private async autoSaveToCameraRoll(downloadedFiles: PhotoInfo[]): Promise<void> {
    const shouldAutoSave = await gallerySettingsService.getAutoSaveToCameraRoll()
    if (!shouldAutoSave || downloadedFiles.length === 0) return

    console.log(
      `[GallerySyncService] Auto-saving ${downloadedFiles.length} files to camera roll in chronological order...`,
    )

    const hasPermission = await MediaLibraryPermissions.checkPermission()
    if (!hasPermission) {
      const granted = await MediaLibraryPermissions.requestPermission()
      if (!granted) {
        console.warn("[GallerySyncService] Camera roll permission denied")
        return
      }
    }

    // CRITICAL: Sort all downloaded files by capture time BEFORE saving to gallery
    // This ensures gallery displays them in chronological order, not download order
    // (photos download first by size, videos second, but we want chronological capture order)
    const sortedFiles = [...downloadedFiles].sort((a, b) => {
      // Parse capture timestamps - handle both string and number formats
      // Use Number.MAX_SAFE_INTEGER for invalid/missing timestamps to push them to the end
      const parseTime = (modified: string | number | undefined): number => {
        if (modified === undefined || modified === null) return Number.MAX_SAFE_INTEGER
        if (typeof modified === "number") return isNaN(modified) ? Number.MAX_SAFE_INTEGER : modified
        const parsed = parseInt(modified, 10)
        return isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed
      }

      const timeA = parseTime(a.modified)
      const timeB = parseTime(b.modified)

      // Sort oldest first (ascending) so they're added to gallery in chronological order
      return timeA - timeB
    })

    console.log(`[GallerySyncService] Sorted ${sortedFiles.length} files by capture time:`)
    sortedFiles.slice(0, 5).forEach((file, idx) => {
      const captureTime = typeof file.modified === "string" ? parseInt(file.modified, 10) : file.modified || 0
      const captureDate = new Date(captureTime)
      const fileType = file.is_video ? "video" : "photo"
      console.log(`  ${idx + 1}. ${file.name} - ${captureDate.toISOString()} (${fileType})`)
    })
    if (sortedFiles.length > 5) {
      console.log(`  ... and ${sortedFiles.length - 5} more files`)
    }

    let savedCount = 0
    let failedCount = 0

    // Save files in chronological order (oldest first)
    for (const photoInfo of sortedFiles) {
      const filePath = photoInfo.filePath || localStorageService.getPhotoFilePath(photoInfo.name)

      // Parse the capture timestamp from the photo metadata
      // The 'modified' field contains the original capture time from the glasses
      let captureTime: number | undefined
      if (photoInfo.modified) {
        captureTime = typeof photoInfo.modified === "string" ? parseInt(photoInfo.modified, 10) : photoInfo.modified
        if (isNaN(captureTime)) {
          console.warn(`[GallerySyncService] Invalid modified timestamp for ${photoInfo.name}:`, photoInfo.modified)
          captureTime = undefined
        }
      }

      // Save to camera roll with capture time for logging
      const success = await MediaLibraryPermissions.saveToLibrary(filePath, captureTime)
      if (success) {
        savedCount++
      } else {
        failedCount++
      }
    }

    console.log(
      `[GallerySyncService] Saved ${savedCount}/${sortedFiles.length} files to camera roll in chronological order`,
    )
    if (failedCount > 0) {
      console.warn(`[GallerySyncService] Failed to save ${failedCount} files to camera roll`)
    }
  }

  /**
   * Handle sync completion
   */
  private async onSyncComplete(downloadedCount: number, failedCount: number): Promise<void> {
    console.log(`[GallerySyncService] Sync complete: ${downloadedCount} downloaded, ${failedCount} failed`)

    // 🔍 DIAGNOSTIC: Show all pictures currently in storage after sync
    // try {
    //   const allStoredFiles = await localStorageService.getDownloadedFiles()
    //   const fileNames = Object.keys(allStoredFiles)
    //   console.log(`[GallerySyncService] 📸 POST-SYNC INVENTORY: ${fileNames.length} total files in storage`)
    //   console.log(`[GallerySyncService] 📋 Complete file list:`)
    //   fileNames
    //     .sort((a, b) => {
    //       const fileA = allStoredFiles[a]
    //       const fileB = allStoredFiles[b]
    //       return fileB.downloaded_at - fileA.downloaded_at // Most recent first
    //     })
    //     .slice(0, 20)
    //     .forEach((fileName, idx) => {
    //       const file = allStoredFiles[fileName]
    //       const captureDate = new Date(file.modified).toISOString()
    //       const downloadDate = new Date(file.downloaded_at).toISOString()
    //       console.log(
    //         `[GallerySyncService]   ${idx + 1}. ${fileName} - captured: ${captureDate}, downloaded: ${downloadDate}`,
    //       )
    //     })
    //   if (fileNames.length > 20) {
    //     console.log(`[GallerySyncService]   ... and ${fileNames.length - 20} more files`)
    //   }
    // } catch (error) {
    //   console.error(`[GallerySyncService] Failed to get post-sync inventory:`, error)
    // }

    // Clear the queue
    await localStorageService.clearSyncQueue()

    // Show completion notification
    await gallerySyncNotifications.showSyncComplete(downloadedCount, failedCount)

    // Close hotspot if we opened it
    const store = useGallerySyncStore.getState()
    if (store.syncServiceOpenedHotspot) {
      await this.closeHotspot()
    }

    // Auto-reset to idle after 3 seconds to clear "Sync complete!" message
    setTimeout(() => {
      const currentStore = useGallerySyncStore.getState()
      if (currentStore.syncState === "complete") {
        console.log("[GallerySyncService] Auto-resetting sync state to idle")
        currentStore.setSyncState("idle")
      }
    }, 4000)

    // Query glasses for updated gallery status after sync completes
    // This will detect any photos taken DURING the sync that weren't included
    console.log(
      "[GallerySyncService] 🔍 Querying glasses for post-sync gallery status (detecting new photos taken during sync)",
    )
    await this.queryGlassesGalleryStatus()
  }

  /**
   * Cancel the current sync
   */
  async cancelSync(): Promise<void> {
    console.log("[GallerySyncService] Cancelling sync...")

    // Abort any ongoing downloads
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }

    // Clear timeout
    if (this.hotspotConnectionTimeout) {
      clearTimeout(this.hotspotConnectionTimeout)
      this.hotspotConnectionTimeout = null
    }

    const store = useGallerySyncStore.getState()

    // Close hotspot if we opened it
    if (store.syncServiceOpenedHotspot) {
      await this.closeHotspot()
    }

    // Update store
    store.setSyncCancelled()

    // Clear queue
    await localStorageService.clearSyncQueue()

    // Dismiss notification
    await gallerySyncNotifications.showSyncCancelled()
  }

  /**
   * Close the hotspot
   */
  private async closeHotspot(): Promise<void> {
    const store = useGallerySyncStore.getState()

    try {
      console.log("[GallerySyncService] Closing hotspot...")
      await CoreModule.setHotspotState(false)
      store.setSyncServiceOpenedHotspot(false)
      store.setHotspotInfo(null)
      console.log("[GallerySyncService] Hotspot closed")
    } catch (error) {
      console.error("[GallerySyncService] Failed to close hotspot:", error)
    }
  }

  /**
   * Check for resumable sync on app start
   */
  async checkForResumableSync(): Promise<boolean> {
    const hasResumable = await localStorageService.hasResumableSyncQueue()

    if (hasResumable) {
      console.log("[GallerySyncService] Found resumable sync queue")
      // Don't auto-resume - let user decide
      // Could emit an event here for UI to show "Resume sync?" prompt
    }

    return hasResumable
  }

  /**
   * Resume a previously interrupted sync
   */
  async resumeSync(): Promise<void> {
    const queue = await localStorageService.getSyncQueue()

    if (!queue || queue.currentIndex >= queue.files.length) {
      console.log("[GallerySyncService] No queue to resume")
      await localStorageService.clearSyncQueue()
      return
    }

    // Check if queue is too old - hotspot auto-disables after 40s of inactivity,
    // so stale queues can't be resumed (hotspot credentials are no longer valid)
    const queueAge = Date.now() - queue.startedAt
    if (queueAge > TIMING.MAX_QUEUE_AGE_MS) {
      console.log(`[GallerySyncService] Queue too old (${Math.round(queueAge / 1000)}s) - clearing stale queue`)
      await localStorageService.clearSyncQueue()
      // Don't auto-start - let user tap sync button if they want to continue
      return
    }

    console.log(`[GallerySyncService] Resuming sync from file ${queue.currentIndex + 1}/${queue.files.length}`)

    const store = useGallerySyncStore.getState()
    const remainingFiles = queue.files.slice(queue.currentIndex)

    // Reset abort controller so cancellation works for resumed syncs
    this.abortController = new AbortController()

    // Set up state
    store.setHotspotInfo(queue.hotspotInfo)
    store.setSyncing(remainingFiles)

    // Try to connect and resume
    await this.connectToHotspotWifi(queue.hotspotInfo)
  }

  /**
   * Query glasses for gallery status
   */
  async queryGlassesGalleryStatus(): Promise<void> {
    try {
      await CoreModule.queryGalleryStatus()
    } catch (error) {
      console.error("[GallerySyncService] Failed to query gallery status:", error)
    }
  }

  /**
   * Check if sync is currently in progress
   */
  isSyncing(): boolean {
    const store = useGallerySyncStore.getState()
    return (
      store.syncState === "syncing" || store.syncState === "connecting_wifi" || store.syncState === "requesting_hotspot"
    )
  }
}

export const gallerySyncService = GallerySyncService.getInstance()
