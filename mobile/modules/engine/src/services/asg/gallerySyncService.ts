/**
 * Gallery Sync Service
 * Orchestrates gallery sync independently of UI lifecycle
 */

import * as RNFS from "@dr.pogodin/react-native-fs"
import NetInfo from "@react-native-community/netinfo"
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import CrustModule from "@mentra/crust"
import {AppState, AppStateStatus, Platform} from "react-native"
import BleManager from "react-native-ble-manager"
import WifiManager from "react-native-wifi-reborn"

import {
  useGallerySyncStore,
  HotspotInfo,
  selectIssyncing,
  type GallerySyncState,
  type SyncState,
} from "../../stores/gallerySync"
import {selectGlassesConnected, useGlassesStore} from "../../stores/glasses"
import {isGlassesConnected} from "../GlassesReadiness"
import {SETTINGS, useSettingsStore} from "../../stores/settings"
import {PhotoInfo, CaptureGroup} from "../../types/asg"
import GlobalEventEmitter from "../../utils/GlobalEventEmitter"
import {BgTimer} from "../../utils/timers"
import {holdGlassesWifi, type GlassesWifiHold} from "@mentra/bluetooth-sdk/glasses-wifi"
import {fixGlassesClockIfSkewed} from "../glassesClockSync"
import {detectClockSkew, isSyncManifestEmpty} from "../gallerySyncClock"
import {MediaLibraryPermissions} from "../../utils/permissions/MediaLibraryPermissions"
import {permissions, PermissionFeatures} from "../../facades/permissions"

import {asgCameraApi} from "./asgCameraApi"
import {gallerySettingsService} from "./gallerySettingsService"
import {gallerySyncNotifications} from "./gallerySyncNotifications"
import {localNetworkErrorDetails, localNetworkTransport} from "./localNetworkTransport"
import {localStorageService} from "./localStorageService"
import {mediaProcessingQueue} from "./mediaProcessingQueue"
import {validateCaptureMetadataForDownload} from "./galleryMediaValidation"
import {emitGalleryNotice} from "./galleryNotices"
import {galleryTransferLedger} from "./galleryTransferLedger"
import {cameraRollExportCoordinator} from "./cameraRollExportCoordinator"

// Timing constants
const TIMING = {
  WIFI_CONNECTION_TIMEOUT_MS: 30000,
  RETRY_DELAY_MS: 2000,
  MAX_QUEUE_AGE_MS: 2 * 60 * 1000, // 2 min - glasses hotspot auto-disables after 40s inactivity
  // WiFi initialization cooldown - prevents repeated "enable WiFi" alerts while WiFi is initializing
  WIFI_COOLDOWN_MS: 3000, // Wait 3 seconds after user visits WiFi settings before showing alert again
  // Cap the native location-services (GPS) check so a hung CrustModule call can't freeze
  // the sync pre-flight (mirrors the host's former PermissionsUtils guard).
  LOCATION_SERVICES_CHECK_TIMEOUT_MS: 5000,
  // A download with no progress for this long is dead. Longer than one segment's five
  // GALLERY_TRANSFER_IDLE_TIMEOUT_MS retries, so a slow transfer that is still retrying is
  // not cut short.
  TRANSFER_STALL_MS: 180_000,
  TRANSFER_STALL_CHECK_INTERVAL_MS: 15_000,
  // Automatic resumes after an interrupted transfer before the person has to tap Sync again.
  MAX_AUTO_RESUMES: 3,
} as const

/** Shown when a transfer dies mid-sync; files already downloaded are kept. */
export const SYNC_INTERRUPTED_MESSAGE = "Sync interrupted. Tap Sync to continue."

/** Phases in which files are moving over the hotspot. */
function isTransferPhase(state: SyncState): boolean {
  return state === "preparing" || state === "syncing"
}

function assertSyncNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error("Gallery sync aborted")
  error.name = "AbortError"
  throw error
}

type SyncManifestData = {
  api_version?: number
  client_id: string
  captures?: CaptureGroup[]
  changed_files: PhotoInfo[]
  deleted_files?: string[]
  server_time: number
  total_changed?: number
  total_size?: number
}

class GallerySyncService {
  /** The glasses Wi-Fi link, held from the start of a sync to its end. */
  private wifi: GlassesWifiHold | null = null
  private static instance: GallerySyncService
  private hotspotListenerRegistered = false
  private abortController: AbortController | null = null
  private isInitialized = false
  private glassesStoreUnsubscribe: (() => void) | null = null
  private appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null
  private waitingForWifiRetry = false
  // Guards full-sync recovery so we don't re-download the entire gallery every sync
  // when glasses retain leftover files (e.g. a previous delete-from-glasses failed).
  // Keyed by `${client_id}:${last_sync_time}` — same pair = already tried, skip.
  private lastFullSyncRetryKey: string | null = null
  private wifiSettingsOpenedAt: number | null = null // Timestamp when user was sent to WiFi settings
  private syncStartPromise: Promise<void> | null = null
  private cleanupPromise: Promise<void> | null = null
  private cancellationPromise: Promise<void> | null = null
  private hotspotClosePromise: Promise<Error | null> | null = null
  private startAborted = false
  // Recovery from a transfer that dies mid-download (the glasses hotspot turned off, or iOS
  // suspended the app long enough for it to time out) instead of showing "Syncing" forever.
  private lastTransferProgressAt = 0
  private transferStallTimer: number | null = null
  private syncStoreUnsubscribe: (() => void) | null = null
  private autoResumes = 0
  private resumeOnForeground = false
  // Downloads are done and the sync is waiting for local processing (stabilization, export).
  // No network transfer is running, so neither the stall deadline nor the glasses' idle
  // hotspot shutdown means the sync died.
  private drainingProcessing = false
  // Bumped by teardown so a resume scheduled before it cannot start a sync after it.
  private lifecycleGeneration = 0

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

    GlobalEventEmitter.addListener("gallery_status", this.handleGalleryStatus)

    // Subscribe to glasses store to detect disconnection during sync
    this.glassesStoreUnsubscribe = useGlassesStore.subscribe(selectGlassesConnected, (connected, prevConnected) => {
      // Only trigger on disconnect (was connected, now not connected)
      if (prevConnected && !connected) {
        this.handleGlassesDisconnected()
      }
    })

    // Listen for app state changes to auto-retry sync after user enables WiFi
    this.appStateSubscription = AppState.addEventListener("change", this.handleAppStateChange)

    // Track transfer progress so a dead download is noticed and resumed.
    this.syncStoreUnsubscribe = useGallerySyncStore.subscribe(this.handleSyncStoreChange)

    this.hotspotListenerRegistered = true
    this.isInitialized = true

    void cameraRollExportCoordinator.initialize()

    // console.log("[GallerySyncService] Initialized")

    // Check for resumable sync on startup
    this.checkForResumableSync()
  }

  /**
   * Cleanup - remove event listeners
   */
  cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise
    const cleanup = this.performCleanup().finally(() => {
      if (this.cleanupPromise === cleanup) this.cleanupPromise = null
    })
    this.cleanupPromise = cleanup
    return cleanup
  }

  private invalidateAttempt(): void {
    this.syncStartPromise = null
    this.startAborted = true
    this.abortController?.abort()
    this.abortController = null
    useGallerySyncStore.getState().setSyncStarting(false)
  }

  private async performCleanup(): Promise<void> {
    if (this.cancellationPromise) {
      // Cancellation retains its own failure; teardown still attempts final cleanup.
      await this.cancellationPromise.catch(() => undefined)
    }
    // Engine teardown owns the same Gallery session, including a failed transfer.
    this.invalidateAttempt()
    mediaProcessingQueue.abort()
    // Teardown is terminal for an active attempt. Preserve queue/error evidence,
    // while letting a later engine session admit a fresh sync.
    if (this.isSyncing()) useGallerySyncStore.getState().setSyncState("cancelled")
    if (this.hotspotListenerRegistered) {
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
    if (this.syncStoreUnsubscribe) {
      this.syncStoreUnsubscribe()
      this.syncStoreUnsubscribe = null
    }
    this.stopTransferStallWatch()
    this.resumeOnForeground = false
    this.autoResumes = 0
    this.lifecycleGeneration++
    this.drainingProcessing = false
    cameraRollExportCoordinator.cleanup()



    useGallerySyncStore.getState().setSyncStarting(false)
    useGallerySyncStore.getState().clearGlassesGalleryStatus()
    this.waitingForWifiRetry = false
    this.wifiSettingsOpenedAt = null
    this.isInitialized = false
    const failure = await this.closeHotspot()
    if (failure) throw failure
    console.log("[GallerySyncService] Cleaned up")
  }

  /**
   * Handle glasses disconnection during sync
   */
  private handleGlassesDisconnected = (): void => {
    const store = useGallerySyncStore.getState()
    // Counts belong to this connection even when no gallery screen or sync is
    // active. Keep them unknown until the next connection reports its summary.
    store.clearGlassesGalleryStatus()

    // Pre-flight has no sync state yet — abort quietly; runStartSync checks this flag after awaits
    if (this.syncStartPromise && !this.isSyncing()) {
      console.log("[GallerySyncService] Glasses disconnected during pre-flight — aborting start")
      this.invalidateAttempt()
      return
    }

    // Only handle if we're actively syncing
    if (!this.isSyncing()) {
      return
    }

    console.log("[GallerySyncService] Glasses disconnected during sync - cancelling")
    store.setSyncError("Glasses disconnected")

    // Abort ongoing downloads
    this.invalidateAttempt()

    gallerySyncNotifications.showSyncError("Glasses disconnected")
    const cleanup = this.closeHotspot().then((failure) => {
      if (failure) throw failure
    })
    void cleanup.catch((error) => {
      console.error("[GallerySyncService] Failed to release routing after glasses disconnected:", error)
    })
  }

  /**
   * Handle app state changes to auto-retry sync when user returns from settings
   */
  private handleAppStateChange = async (nextAppState: AppStateStatus): Promise<void> => {
    // Only handle when app comes to foreground
    if (nextAppState !== "active") {
      return
    }

    // Camera-roll backfill is phone-local and must resume independently of glasses/WiFi.
    void cameraRollExportCoordinator.resume("app foreground")

    // A transfer may have died while iOS kept the app suspended.
    this.checkTransferOnForeground()

    // Only auto-retry if we were waiting for WiFi
    if (!this.waitingForWifiRetry) {
      return
    }

    const signal = this.abortController?.signal
    if (signal?.aborted) return
    console.log("[GallerySyncService] App returned to foreground - checking if WiFi is enabled")

    const store = useGallerySyncStore.getState()
    const glassesStore = useGlassesStore.getState()
    const glassesConnected = isGlassesConnected(glassesStore.connection)

    // Check if glasses are still connected
    if (!glassesConnected) {
      console.log("[GallerySyncService] Glasses disconnected - not retrying sync")
      this.waitingForWifiRetry = false
      this.wifiSettingsOpenedAt = null
      return
    }

    // The user has returned from the WiFi settings prompt, so the previous
    // "Sync failed" state is no longer actionable. Make the button available
    // immediately while the native WiFi state catches up; a successful check
    // below will start the sync automatically.
    if (store.syncState === "error" && store.lastError?.startsWith("WiFi disabled")) {
      store.setSyncState("idle")
    }

    // Check if WiFi is now enabled (Android only)
    // Use retry logic because WiFi status takes time to propagate after user enables it
    if (Platform.OS === "android") {
      const MAX_RETRIES = 5
      const RETRY_DELAY_MS = 1000

      console.log("[GallerySyncService] Waiting for WiFi to initialize (may take a moment after enabling)...")

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          await new Promise<void>((resolve) => BgTimer.setTimeout(() => resolve(), RETRY_DELAY_MS))
          if (signal?.aborted) return

          // NetInfo can remain stale after Android's WiFi settings close. Use
          // the same native source as the normal sync preflight.
          const wifiEnabled = await WifiManager.isEnabled()
          if (signal?.aborted) return
          console.log(`[GallerySyncService] WiFi check attempt ${attempt}/${MAX_RETRIES}: enabled=${wifiEnabled}`)

          if (wifiEnabled) {
            console.log("[GallerySyncService] ✅ WiFi is now enabled - auto-retrying sync")
            this.waitingForWifiRetry = false
            this.wifiSettingsOpenedAt = null // Clear cooldown timestamp
            // Auto-retry sync
            await this.startSync()
            return
          }
        } catch (error) {
          if (signal?.aborted) return
          console.warn(`[GallerySyncService] Failed to check WiFi status on attempt ${attempt}:`, error)
          // Continue to next retry
        }
      }

      if (signal?.aborted) return
      console.log("[GallerySyncService] WiFi not detected after retries - leaving sync available for manual retry")
      this.waitingForWifiRetry = false
      this.wifiSettingsOpenedAt = null
    }
  }

  /**
   * Handle gallery status from glasses
   */
  private handleGalleryStatus = (data: any): void => {
    if (!isGlassesConnected(useGlassesStore.getState().connection)) return
    console.log("[GallerySyncService] Received gallery_status:", data)

    const store = useGallerySyncStore.getState()
    store.setGlassesGalleryStatus(data.photos || 0, data.videos || 0, data.total || 0, data.has_content || false)
  }

  /**
   * Start the sync process
   */
  async startSync(): Promise<void> {
    // A sync the person starts gets a fresh budget of automatic resumes.
    this.autoResumes = 0
    this.resumeOnForeground = false
    return this.beginSync()
  }

  private async beginSync(): Promise<void> {
    while (this.cleanupPromise || this.cancellationPromise || this.hotspotClosePromise) {
      if (this.cleanupPromise) await this.cleanupPromise
      if (this.cancellationPromise) await this.cancellationPromise
      if (this.hotspotClosePromise) {
        const failure = await this.hotspotClosePromise
        if (failure) throw failure
      }
    }
    if (this.syncStartPromise) {
      console.log("[GallerySyncService] ⚠️ Sync start already in progress, joining existing attempt")
      return this.syncStartPromise
    }

    if (this.isSyncing()) return
    const previous = this.abortController
    previous?.abort()
    const signal = (this.abortController = new AbortController()).signal
    useGallerySyncStore.getState().setSyncStarting(true)
    const starting = this.admitStartSync(previous !== null, signal).finally(() => {
      if (this.syncStartPromise !== starting) return
      this.syncStartPromise = null
      useGallerySyncStore.getState().setSyncStarting(false)
    })
    this.syncStartPromise = starting
    return starting
  }

  private async admitStartSync(replacingAttempt: boolean, signal: AbortSignal): Promise<void> {
    if (replacingAttempt) {
      mediaProcessingQueue.abort()
      const failure = await this.closeHotspot()
      if (failure) throw failure
    }
    if (signal.aborted) return
    await this.runStartSync(signal)
  }

  /**
   * Native location-services (GPS on/off) check, raced against a timeout so a hung
   * CrustModule call can't freeze the sync pre-flight. Mirrors the host's former
   * PermissionsUtils.isLocationServicesEnabled exactly: on timeout assume enabled
   * (proceed); on any other native error assume disabled (block + prompt). Android-only
   * callers; iOS doesn't need location for BLE since iOS 13.
   */
  private async isLocationServicesEnabled(): Promise<boolean> {
    try {
      return await Promise.race([
        CrustModule.isLocationServicesEnabled(),
        new Promise<boolean>((_, reject) =>
          setTimeout(
            () => reject(new Error("Location services check timed out")),
            TIMING.LOCATION_SERVICES_CHECK_TIMEOUT_MS,
          ),
        ),
      ])
    } catch (error) {
      console.error("[GallerySyncService] Error checking location services:", error)
      if (error instanceof Error && error.message.includes("timed out")) {
        console.warn("[GallerySyncService] Location services check timed out — assuming enabled so sync can proceed")
        return true
      }
      return false
    }
  }

  /**
   * Mirrors the host's old PermissionsUtils.isBluetoothEnabled exactly: poll
   * BleManager for up to 500ms while the adapter reports "unknown"; assume
   * enabled on a timeout (a slow adapter must not block the sync) and disabled
   * on a check error.
   */
  private async isBluetoothAdapterEnabled(): Promise<boolean> {
    try {
      await BleManager.start({showAlert: false})
      for (let attempt = 0; attempt < 10; attempt++) {
        const state = await BleManager.checkState()
        if (state !== "unknown") {
          return state === "on"
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      console.warn("[GallerySyncService] Bluetooth state still unknown after 500ms - assuming enabled")
      return true
    } catch (error) {
      console.error("[GallerySyncService] Error checking Bluetooth state:", error)
      return false
    }
  }

  private shouldAbortPreFlight(signal?: AbortSignal): boolean {
    if (signal?.aborted) return true
    if (this.startAborted) {
      this.startAborted = false
      return true
    }
    if (!isGlassesConnected(useGlassesStore.getState().connection)) {
      return true
    }
    return false
  }

  private async runStartSync(signal: AbortSignal): Promise<void> {
    // Clear stale abort flag — it can persist when a prior pre-flight exited through
    // a non-shouldAbortPreFlight path (e.g. connectivity failed, disk full), which
    // would otherwise cause the next sync attempt to abort spuriously.
    this.startAborted = false

    console.log("[GallerySyncService] ========================================")
    console.log("[GallerySyncService] 🚀 SYNC START INITIATED")
    console.log("[GallerySyncService] ========================================")

    const store = useGallerySyncStore.getState()
    const glassesStore = useGlassesStore.getState()
    const glassesConnected = isGlassesConnected(glassesStore.connection)
    // R1: Check if already syncing (including requesting_hotspot to prevent double-tap)
    if (this.isSyncing()) {
      console.log(`[GallerySyncService] ⚠️ Already syncing (state: ${store.syncState}), ignoring start request`)
      return
    }

    // Engine-owned pre-flight: glasses reachable + bluetooth adapter on. The host
    // renders the alerts off the structured notices; Android location permission
    // and services are handled in the permission steps below.
    if (!glassesConnected) {
      console.warn("[GallerySyncService] Sync aborted - Glasses not connected")
      store.setSyncError("Glasses not connected")
      emitGalleryNotice({code: "glasses_disconnected"})
      return
    }

    const bluetoothEnabled = await this.isBluetoothAdapterEnabled()
    if (signal?.aborted) return
    if (!bluetoothEnabled) {
      console.warn("[GallerySyncService] Sync aborted - Bluetooth is disabled")
      store.setSyncError("Bluetooth disabled - enable Bluetooth and try again")
      emitGalleryNotice({code: "bluetooth_off", data: {systemAnswer: "Bluetooth adapter enabled=false"}})
      return
    }

    console.log("[GallerySyncService] ✅ Pre-flight check passed - BT enabled, Glasses connected")
    console.log("[GallerySyncService] 📊 Glasses info:", {
      connected: glassesConnected,
      hotspotEnabled: glassesStore.hotspot.state === "enabled",
    })

    // Request all permissions upfront so user isn't interrupted during WiFi/download
    console.log("[GallerySyncService] 🔐 Step 1/6: Requesting permissions...")

    // 1. Notification permission (for background sync progress)
    console.log("[GallerySyncService]   📱 Requesting notification permission...")
    await gallerySyncNotifications.requestPermissions()
    if (this.shouldAbortPreFlight(signal)) {
      console.log("[GallerySyncService] Pre-flight aborted after notification permission")
      return
    }
    console.log("[GallerySyncService]   ✅ Notification permission handled")

    // 2. Location permission. Sync does not block on it.
    console.log("[GallerySyncService]   📍 Checking location permission...")
    if (!(await permissions.check(PermissionFeatures.LOCATION))) {
      if (signal.aborted) return
      const granted = await permissions.request(PermissionFeatures.LOCATION)
      console.log(`[GallerySyncService]   📍 Location permission granted=${granted}`)
    }
    if (signal.aborted) return
    if (this.shouldAbortPreFlight(signal)) {
      console.log("[GallerySyncService] Pre-flight aborted after location permission")
      return
    }

    if (Platform.OS === "android") {
      console.log("[GallerySyncService]   📡 Checking local WiFi permission...")
      const hasLocalWifiPermission = await permissions.check(PermissionFeatures.LOCAL_WIFI)
      if (signal.aborted) return
      if (!hasLocalWifiPermission) {
        const granted = await permissions.request(PermissionFeatures.LOCAL_WIFI)
        if (signal.aborted) return
        if (!granted) {
          store.setSyncError("Local WiFi permission is required for gallery sync")
          await gallerySyncNotifications.showSyncError("Allow WiFi access to connect to your glasses")
          return
        }
      }
      if (this.shouldAbortPreFlight(signal)) {
        console.log("[GallerySyncService] Pre-flight aborted after local WiFi permission")
        return
      }
    }

    // 3. Camera roll permission (if auto-save is enabled)
    const shouldAutoSave = await gallerySettingsService.getAutoSaveToCameraRoll()
    if (signal?.aborted) return
    console.log(`[GallerySyncService]   📸 Auto-save to camera roll: ${shouldAutoSave}`)
    if (shouldAutoSave) {
      console.log("[GallerySyncService]   📸 Checking camera roll permission...")
      const hasPermission = await MediaLibraryPermissions.checkPermission()
      if (signal.aborted) return
      if (!hasPermission) {
        console.log("[GallerySyncService]   ⚠️ Camera roll permission not granted - requesting...")
        const granted = await MediaLibraryPermissions.requestPermission()
        if (signal.aborted) return
        if (!granted) {
          console.warn("[GallerySyncService]   ❌ Camera roll permission denied - auto-save sync cannot continue")
          store.setSyncError("Camera-roll permission required while automatic saving is enabled")
          emitGalleryNotice({
            code: "camera_roll_permission_required",
            data: {systemAnswer: `media library requestPermission granted=${granted}`},
          })
          return
        } else {
          console.log("[GallerySyncService]   ✅ Camera roll permission granted")
        }
      } else {
        console.log("[GallerySyncService]   ✅ Camera roll permission already granted")
      }
    }
    if (this.shouldAbortPreFlight(signal)) {
      console.log("[GallerySyncService] Pre-flight aborted after camera roll permission")
      return
    }

    // S1: Disk space check — abort early if insufficient space
    try {
      const fsInfo = await RNFS.getFSInfo()
      if (signal.aborted) return
      const freeSpaceMB = fsInfo.freeSpace / (1024 * 1024)
      console.log(`[GallerySyncService]   💾 Free disk space: ${freeSpaceMB.toFixed(0)} MB`)
      if (fsInfo.freeSpace < 500 * 1024 * 1024) {
        console.error("[GallerySyncService]   ❌ Insufficient disk space (<500MB)")
        emitGalleryNotice({code: "insufficient_storage", data: {freeSpaceMB: Math.round(freeSpaceMB)}})
        store.setSyncError("Insufficient storage space")
        return
      }
    } catch (fsError) {
      console.warn("[GallerySyncService]   ⚠️ Could not check disk space:", fsError)
      // Continue — don't block sync if check fails
    }
    if (this.shouldAbortPreFlight(signal)) {
      console.log("[GallerySyncService] Pre-flight aborted after disk space check")
      return
    }

    // COOLDOWN CHECK: If user just went to WiFi settings, show a "please wait" message
    // This prevents showing "enable WiFi" alert repeatedly while WiFi is initializing
    if (Platform.OS === "android" && this.wifiSettingsOpenedAt) {
      const timeSinceSettingsOpened = Date.now() - this.wifiSettingsOpenedAt
      const cooldownRemaining = TIMING.WIFI_COOLDOWN_MS - timeSinceSettingsOpened

      if (cooldownRemaining > 0) {
        console.log(
          `[GallerySyncService] WiFi cooldown active (${Math.round(
            cooldownRemaining / 1000,
          )}s remaining) - showing wait message`,
        )

        emitGalleryNotice({code: "wifi_initializing"})
        return
      } else {
        // Cooldown expired, clear the timestamp
        console.log("[GallerySyncService] WiFi cooldown expired - resuming normal behavior")
        this.wifiSettingsOpenedAt = null
      }
    }

    // Pre-flight WiFi check on Android BEFORE any connection attempts
    // This prevents sync failures even when we think we're already connected
    // NOTE: We use WifiManager.isEnabled() instead of NetInfo.isWifiEnabled because
    // NetInfo can return stale/cached data that reports WiFi as enabled when it's actually OFF
    console.log("[GallerySyncService] 📡 Step 2/6: WiFi pre-flight check...")
    if (Platform.OS === "android") {
      try {
        // Use WifiManager.isEnabled() for accurate WiFi state (NetInfo can be stale)
        const wifiEnabled = await WifiManager.isEnabled()
        if (signal.aborted) return
        console.log("[GallerySyncService]   📡 WiFi enabled (WifiManager):", wifiEnabled)

        // Also log NetInfo for debugging comparison
        const netState = await NetInfo.fetch()
        if (signal.aborted) return
        console.log("[GallerySyncService]   📡 WiFi enabled (NetInfo):", netState.isWifiEnabled)
        console.log("[GallerySyncService]   📡 Connected:", netState.isConnected)
        console.log("[GallerySyncService]   📡 Internet reachable:", netState.isInternetReachable)

        if (!wifiEnabled) {
          console.error("[GallerySyncService]   ❌ WiFi is disabled - cannot sync")

          // Don't arm the auto-retry / "WiFi initializing" cooldown yet — whether to arm
          // them depends on the user's choice in the host's prompt, which only the host
          // learns. The host renders an "enable WiFi → open settings" alert from this
          // notice and calls ack() ONLY when the user opts to open settings; on Cancel it
          // does nothing, so a declined prompt leaves no pending retry or phantom cooldown.
          // The engine still owns what arming MEANS (this closure) — the host only reports
          // that the user took the affirmative action.
          emitGalleryNotice({
            code: "wifi_off",
            ack: () => {
              if (signal.aborted) return
              this.waitingForWifiRetry = true
              this.wifiSettingsOpenedAt = Date.now()
            },
          })
          store.setSyncError("WiFi disabled - enable WiFi and try again")

          // Return early - do NOT proceed with sync
          return
        } else {
          // WiFi is enabled - clear any cooldown timestamp
          console.log("[GallerySyncService]   ✅ WiFi is enabled - proceeding")
          this.wifiSettingsOpenedAt = null
        }
      } catch (error) {
        console.warn("[GallerySyncService]   ⚠️ Failed to check WiFi status:", error)
        // Continue with sync attempt - don't block if check fails
      }
      if (this.shouldAbortPreFlight(signal)) {
        console.log("[GallerySyncService] Pre-flight aborted after WiFi check")
        return
      }
    } else {
      console.log("[GallerySyncService]   ℹ️ iOS - WiFi check not required")
    }

    // Check if Location Services is enabled (Android only - required for WiFi operations)
    // This must be checked BEFORE attempting any WiFi connection to avoid cryptic errors
    if (Platform.OS === "android") {
      console.log("[GallerySyncService]   📍 Checking Location Services status...")
      try {
        const locationServicesEnabled = await this.isLocationServicesEnabled()
        if (signal.aborted) return
        console.log("[GallerySyncService]   📍 Location Services enabled:", locationServicesEnabled)

        if (!locationServicesEnabled) {
          console.error("[GallerySyncService]   ❌ Location Services is OFF - cannot sync")
          console.error("[GallerySyncService]   ❌ Android requires Location Services for WiFi operations")

          // Emit a notice; the host shows the "enable Location Services" alert + dialog.
          emitGalleryNotice({code: "location_services_off", data: {systemAnswer: "Location Services enabled=false"}})
          store.setSyncError("Location Services disabled - enable in Settings and try again")

          // Return early - do NOT proceed with sync
          return
        } else {
          console.log("[GallerySyncService]   ✅ Location Services is enabled - proceeding")
        }
      } catch (error) {
        console.warn("[GallerySyncService]   ⚠️ Failed to check Location Services status:", error)
        // Continue with sync attempt - don't block if check fails
      }
      if (this.shouldAbortPreFlight(signal)) {
        console.log("[GallerySyncService] Pre-flight aborted after location services check")
        return
      }
    }

    console.log("[GallerySyncService] 📡 Step 3/6: Holding the glasses Wi-Fi link...")
    if (!isGlassesConnected(useGlassesStore.getState().connection)) {
      console.log("[GallerySyncService] Pre-flight aborted — glasses no longer connected")
      return
    }
    // Every fallible pre-flight gate has passed. It is now safe to replace the previous
    // in-memory queue; startFileDownload immediately recovers its durable ledger work.
    mediaProcessingQueue.reset()
    store.setRequestingHotspot()
    try {
      this.wifi = await holdGlassesWifi({
        consumer: "gallery-sync",
        signal,
        beforeJoin: async (ssid) => {
          store.setSyncState("connecting_wifi")
          if (!(await this.showWifiJoinExplanation(ssid, signal))) throw new Error("Gallery sync aborted")
        },
        onPermissionRequired: (systemAnswer) => {
          if (!signal.aborted) emitGalleryNotice({code: "local_network_permission_required", data: {systemAnswer}})
        },
      })
    } catch (error) {
      if (signal.aborted) return
      console.error("[GallerySyncService] ❌ Could not connect to the glasses:", JSON.stringify(localNetworkErrorDetails(error)))
      store.setSyncError(error instanceof Error ? error.message : "Failed to connect to glasses WiFi")
      return
    }
    // A link that goes down mid-transfer kills the download; resume from what has arrived.
    this.wifi.onChange((event) => {
      if (event.type !== "restored") this.interruptTransfer(`the glasses Wi-Fi link went down: ${event.reason}`)
    })
    const {ssid, password, gateway} = this.wifi.binding
    const hotspotInfo: HotspotInfo = {ssid, password, ip: gateway}
    store.setHotspotInfo(hotspotInfo)
    store.setSyncState("connecting_wifi")
    try {
      if (Platform.OS === "ios") await this.waitForGlassesServer(gateway, signal)
      if (signal.aborted) return
      await this.startFileDownload(hotspotInfo, signal)
    } catch (error) {
      if (signal.aborted) return
      store.setSyncError(error instanceof Error ? error.message : "Failed to connect to glasses WiFi")
      const failure = await this.closeHotspot()
      if (failure) throw failure
    }
  }

  /**
   * Show explanation dialog before WiFi connection (first time only)
   * Returns true if user wants to proceed, false if cancelled
   */
  private async showWifiJoinExplanation(ssid: string, signal?: AbortSignal): Promise<boolean> {
    const settingsStore = useSettingsStore.getState()
    const hasSeenExplanation = settingsStore.getSetting(SETTINGS.gallery_sync_explained.key)

    if (hasSeenExplanation) {
      console.log("[GallerySyncService] User has seen WiFi explanation before - skipping")
      return true
    }

    console.log("[GallerySyncService] First sync - showing WiFi join explanation")

    return new Promise<boolean>((resolve) => {
      const proceed = () => {
        if (signal?.aborted) {
          resolve(false)
          return
        }
        // Mark as explained so we don't show again.
        settingsStore.setSetting(SETTINGS.gallery_sync_explained.key, true, false)
        resolve(true)
      }
      // Emit the one-time wifi-join explanation as a notice the host renders + acknowledges.
      // The host owns the alert + its dismiss timing (Android's native WiFi connect freezes
      // the UI thread, so it should let the dialog fully dismiss before calling ack).
      const delivered = emitGalleryNotice({
        code: "connect_to_glasses",
        data: {ssid, platform: Platform.OS},
        ack: proceed,
      })
      // No host listening (e.g. an OEM that hasn't wired onNotice) — don't hang the sync.
      if (delivered === 0) proceed()
    })
  }

  /**
   * iOS joins with the SSID right, then needs a moment for its routing table to reach the
   * glasses: probe their HTTP server until it answers, for up to ten seconds.
   */
  private async waitForGlassesServer(ip: string, signal: AbortSignal): Promise<void> {
    for (let probe = 1; probe <= 20; probe++) {
      if (signal.aborted) return
      // Cleared in finally: an un-cleared BgTimer is a live native timer.
      const probeController = new AbortController()
      const probeTimeout = BgTimer.setTimeout(() => probeController.abort(), 1000)
      try {
        const response = await localNetworkTransport.fetch(`http://${ip}:8089/api/health`, {
          method: "GET",
          signal: probeController.signal,
        })
        // 200 = health endpoint exists, 404 = glasses responded without one; either way it works.
        if (response.status === 200 || response.status === 404) return
      } catch {
        // Not reachable yet.
      } finally {
        BgTimer.clearTimeout(probeTimeout)
      }
      await new Promise<void>((resolve) => BgTimer.setTimeout(() => resolve(), 500))
    }
    throw new Error(`iOS network not ready - could not reach ${ip}:8089 after 20 attempts`)
  }

  private async fetchSyncManifest(
    clientId: string,
    lastSyncTime: number,
    signal?: AbortSignal,
  ): Promise<SyncManifestData> {
    assertSyncNotAborted(signal)
    const v3 = typeof asgCameraApi.getV3Manifest === "function" ? await asgCameraApi.getV3Manifest() : null
    assertSyncNotAborted(signal)
    if (v3) {
      const downloadedFiles = await localStorageService.getDownloadedFiles()
      assertSyncNotAborted(signal)
      await localStorageService.reconcileRemoteCaptures(
        v3.captures.map((capture) => capture.capture_id),
        downloadedFiles,
      )
      return {
        api_version: 3,
        client_id: clientId,
        // The ledger is a crash-recovery journal, not proof that app-private media survived an
        // Android restore or reinstall. Suppress a remote capture only when both records agree.
        captures: v3.captures.filter(
          (capture) =>
            !downloadedFiles[capture.capture_id] || !galleryTransferLedger.isLocallyCommitted(capture.capture_id),
        ),
        changed_files: [],
        deleted_files: [],
        server_time: v3.server_time,
        total_changed: v3.captures.length,
        total_size: v3.captures.reduce((total, capture) => total + capture.total_size, 0),
      }
    }
    // Old firmware remains on the exact v2 endpoint/schema. Avoid expensive inline thumbnails;
    // video thumbnails are fetched as small side downloads with their primary media.
    const syncResponse = await asgCameraApi.syncWithServer(clientId, lastSyncTime, false)
    assertSyncNotAborted(signal)
    const data = (syncResponse.data || syncResponse) as SyncManifestData
    if (data.captures) {
      data.captures = data.captures.filter((capture) => !galleryTransferLedger.isLocallyCommitted(capture.capture_id))
    }
    data.changed_files = (data.changed_files || []).filter(
      (file) => !galleryTransferLedger.isFileLocallyCommitted(file.name),
    )
    return data
  }

  /**
   * Resolve sync manifest: detect skew, optionally fix clock, retry full sync when needed.
   */
  private async resolveSyncManifest(
    clientId: string,
    lastSyncTime: number,
    signal?: AbortSignal,
  ): Promise<{syncData: SyncManifestData; usedFullSync: boolean} | null> {
    const store = useGallerySyncStore.getState()
    let syncData = await this.fetchSyncManifest(clientId, lastSyncTime, signal)
    let clockFixed = false

    const skewOnFirst = detectClockSkew(Date.now(), syncData.server_time, lastSyncTime)
    if (skewOnFirst.skewed) {
      clockFixed = await fixGlassesClockIfSkewed(syncData.server_time, lastSyncTime)
      assertSyncNotAborted(signal)
      if (clockFixed) {
        console.log("[GallerySyncService]   🔄 Retrying /api/sync with last_sync_time=0 after clock fix")
        syncData = await this.fetchSyncManifest(clientId, 0, signal)
      }
    }

    if (!isSyncManifestEmpty(syncData)) {
      return {syncData, usedFullSync: clockFixed || lastSyncTime === 0}
    }

    // Guard against re-firing the full-sync retry every sync when glasses retain leftover files
    // from a failed delete-from-glasses: at most one retry per (client_id, last_sync_time) pair
    // per process lifetime. Without this, we'd re-download the entire gallery on every sync.
    const retryKey = `${clientId}:${lastSyncTime}`
    const alreadyRetriedForThisWatermark = this.lastFullSyncRetryKey === retryKey
    if (!clockFixed && store.glassesHasContent && lastSyncTime !== 0 && !alreadyRetriedForThisWatermark) {
      this.lastFullSyncRetryKey = retryKey
      console.log("[GallerySyncService]   🔄 Empty sync but glasses report content — retrying with last_sync_time=0")
      syncData = await this.fetchSyncManifest(clientId, 0, signal)
      if (!isSyncManifestEmpty(syncData)) {
        return {syncData, usedFullSync: true}
      }
    } else if (!clockFixed && store.glassesHasContent && lastSyncTime !== 0 && alreadyRetriedForThisWatermark) {
      console.warn(
        "[GallerySyncService]   ⚠️ Glasses still report content but /api/sync empty — already retried this watermark, skipping to avoid re-download loop",
      )
    }

    if (store.glassesHasContent) {
      console.warn("[GallerySyncService]   ⚠️ Empty sync while glasses still report gallery content")
      return null
    }

    return {syncData, usedFullSync: false}
  }

  /**
   * Start downloading files
   */
  private async startFileDownload(hotspotInfo: HotspotInfo, signal = this.abortController?.signal): Promise<void> {
    if (signal?.aborted) return
    const store = useGallerySyncStore.getState()

    console.log("[GallerySyncService] ========================================")
    console.log("[GallerySyncService] 📥 Step 5/6: Starting file download phase")
    console.log("[GallerySyncService] ========================================")
    console.log(`[GallerySyncService]   🌐 Server: ${hotspotInfo.ip}:8089`)

    try {
      // Set up the API client
      asgCameraApi.setServer(hotspotInfo.ip, 8089)
      console.log("[GallerySyncService]   ✅ API client configured")

      // Wi-Fi is ready. Inventory/recovery can take time for large galleries and must
      // render as preparation. Preserve the display queue until a new manifest is ready;
      // setSyncing([]) would discard retained thumbnails and recovery progress on failure.
      store.setSyncState("preparing")

      const recovery = await mediaProcessingQueue.retryPending()
      if (signal?.aborted) return
      if (recovery.retried > 0 || recovery.failed > 0) {
        console.log(
          `[GallerySyncService]   ♻️ Recovery: ${recovery.retried} completed, ${recovery.failed} still pending`,
        )
      }

      // Get sync state and files to download
      // IMPORTANT: This creates a SNAPSHOT of files at this moment based on last_sync_time.
      // Any photos taken AFTER this call (during the sync) will NOT be included in this sync.
      // They will be detected in the next sync when we query gallery status again.
      console.log("[GallerySyncService]   📊 Fetching sync state from local storage...")
      const syncState = await localStorageService.getSyncState()
      if (signal?.aborted) return
      console.log("[GallerySyncService]   📊 Sync state:", {
        client_id: syncState.client_id,
        last_sync_time: syncState.last_sync_time,
        last_sync_date: syncState.last_sync_time > 0 ? new Date(syncState.last_sync_time).toISOString() : "Never",
        total_downloaded: syncState.total_downloaded,
        total_size: `${(syncState.total_size / 1024 / 1024).toFixed(2)} MB`,
      })

      console.log("[GallerySyncService]   📡 Calling /api/sync endpoint...")
      const syncStartTime = Date.now()
      const resolved = await this.resolveSyncManifest(syncState.client_id, syncState.last_sync_time, signal)
      if (signal?.aborted) return
      const _syncDuration = Date.now() - syncStartTime
      console.log(`[GallerySyncService]   ✅ /api/sync completed in ${_syncDuration}ms`)

      if (!resolved) {
        const syncErrorMessage = "Could not sync gallery — try again"
        store.setSyncError(syncErrorMessage)
        await gallerySyncNotifications.showSyncError(syncErrorMessage)
        return
      }

      const {syncData} = resolved

      console.log("[GallerySyncService]   📋 Sync response received:")
      console.log(`[GallerySyncService]      - Server time: ${syncData.server_time}`)
      console.log(`[GallerySyncService]      - Changed files: ${syncData.changed_files?.length || 0}`)
      console.log(`[GallerySyncService]      - Captures: ${syncData.captures?.length || 0}`)

      if (isSyncManifestEmpty(syncData)) {
        console.log("[GallerySyncService]   ✅ No new files to sync - already up to date!")
        if (galleryTransferLedger.hasPendingRecovery()) {
          store.setSyncError("Gallery export or acknowledgement needs retry")
        } else {
          store.setSyncComplete()
        }
        await this.onSyncComplete(0, 0, signal)
        return
      }

      // Detect API version and route to appropriate download path
      const useCaptures = (syncData.api_version || 0) >= 2 && syncData.captures && syncData.captures.length > 0

      if (useCaptures) {
        // New capture-aware sync path
        const captures: CaptureGroup[] = syncData.captures!
        console.log(
          `[GallerySyncService]   📊 Found ${captures.length} captures to download (api_version=${syncData.api_version})`,
        )

        captures.slice(0, 5).forEach((c: CaptureGroup, idx: number) => {
          console.log(
            `[GallerySyncService]      ${idx + 1}. ${c.capture_id} (${c.type}, ${c.files.length} files, ${(
              c.total_size / 1024
            ).toFixed(1)} KB)`,
          )
        })
        if (captures.length > 5) {
          console.log(`[GallerySyncService]      ... and ${captures.length - 5} more captures`)
        }

        // Build a PhotoInfo[] for the store (one per capture, using primary file info)
        const capturePhotoInfos: PhotoInfo[] = captures.map((c) => {
          const primaryFile = c.files.find((f) => f.role === "primary") || c.files[0]
          return {
            name: c.capture_id,
            url: `/api/photo?file=${encodeURIComponent(primaryFile.name)}`,
            download: `/api/download?file=${encodeURIComponent(primaryFile.name)}`,
            size: c.total_size,
            modified: c.timestamp,
            is_video: c.type === "video",
            thumbnail_data: c.thumbnail_data,
            duration: c.duration,
          }
        })

        store.setSyncing(capturePhotoInfos)

        await localStorageService.saveSyncQueue({
          files: capturePhotoInfos,
          currentIndex: 0,
          startedAt: Date.now(),
          hotspotInfo,
        })

        if (signal?.aborted) return
        await gallerySyncNotifications.showSyncStarted(captures.length)
        if (signal?.aborted) return

        console.log("[GallerySyncService]   🚀 Beginning capture download execution...")
        await this.executeCaptureDownload(captures, syncData.server_time, signal)
      } else {
        // Legacy flat file sync path
        const filesToSync = syncData.changed_files
        // Count only user-visible media files (exclude HDR brackets and IMU sidecars)
        const userVisibleCount = filesToSync.filter(
          (f: any) => !f.name?.match(/_ev-?\d+\.(jpg|jpeg)$/i) && !f.name?.match(/\.imu\.json$/i),
        ).length
        console.log(
          `[GallerySyncService]   📊 Found ${filesToSync.length} files to download (${userVisibleCount} media items, legacy path):`,
        )

        console.log("[GallerySyncService]   📋 First 5 files:")
        filesToSync.slice(0, 5).forEach((_file: any, _idx: number) => {
          console.log(
            `[GallerySyncService]      ${_idx + 1}. ${_file.name} (${_file.is_video ? "video" : "photo"}, ${(
              _file.size / 1024
            ).toFixed(1)} KB)`,
          )
        })
        if (filesToSync.length > 5) {
          console.log(`[GallerySyncService]      ... and ${filesToSync.length - 5} more files`)
        }

        store.setSyncing(filesToSync)

        await localStorageService.saveSyncQueue({
          files: filesToSync,
          currentIndex: 0,
          startedAt: Date.now(),
          hotspotInfo,
        })

        if (signal?.aborted) return
        await gallerySyncNotifications.showSyncStarted(userVisibleCount)
        if (signal?.aborted) return

        console.log("[GallerySyncService]   🚀 Beginning download execution (legacy)...")
        await this.executeDownload(filesToSync, syncData.server_time, signal)
      }
    } catch (error: any) {
      if (signal?.aborted) return
      console.error("[GallerySyncService] Failed to start download:", error)
      store.setSyncError(error?.message || "Failed to start download")
      await gallerySyncNotifications.showSyncError("Failed to start download")
    } finally {
      // Every admitted transfer releases phone routing and its reservation,
      // including shortcuts onto a pre-existing AP. closeHotspot only disables
      // an AP opened by this Gallery session; failed cleanup retains custody.
      if (!signal?.aborted) {
        const failure = await this.closeHotspot()
        if (failure) throw failure
      }
    }
  }

  /**
   * Execute the actual file download.
   * Used for old asg_client firmware that doesn't send api_version=2 / captures.
   * NOTE: The sidecar/bracket filtering within is likely dead code — old firmware
   * only produces flat photos/videos with no sidecars or HDR brackets.
   */
  private async executeDownload(files: PhotoInfo[], serverTime: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    const downloadStartTime = Date.now()
    console.log("[GallerySyncService] ========================================")
    console.log("[GallerySyncService] ⬇️ DOWNLOAD EXECUTION STARTED")
    console.log("[GallerySyncService] ========================================")
    console.log(`[GallerySyncService]   📊 Files to download: ${files.length}`)

    const store = useGallerySyncStore.getState()
    const settingsStore = useSettingsStore.getState()
    const defaultWearable = settingsStore.getSetting(SETTINGS.default_wearable.key)

    let downloadedCount = 0
    let failedCount = 0

    // Check if auto-save to camera roll is enabled (we'll save each file immediately after download)
    const shouldAutoSave = await gallerySettingsService.getAutoSaveToCameraRoll()
    if (signal?.aborted) return
    const shouldProcessImages = useSettingsStore.getState().getSetting(SETTINGS.media_post_processing.key)
    console.log(`[GallerySyncService]   📸 Auto-save to camera roll: ${shouldAutoSave}`)
    console.log(`[GallerySyncService]   🎨 Image processing: ${shouldProcessImages}`)

    try {
      const downloadResult = await asgCameraApi.batchSyncFiles(
        files,
        true,
        (current, total, fileName, fileProgress, downloadedFile) => {
          // CRITICAL: This callback MUST NOT throw!
          // RNFS progress callbacks run inside native bridge — throwing here causes
          // EXC_BAD_ACCESS. Cancellation is handled via AbortSignal → the active transport.

          // Check if cancelled — just return, abort signal will stop the download
          if (signal?.aborted) {
            return
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

            // 🎯 IMMEDIATELY process + save to camera roll if enabled
            if (downloadedFile.filePath) {
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

              // Enqueue for background processing (non-blocking)
              const isVideo = downloadedFile.name?.match(/\.(mp4|mov)$/i)
              const leaf = downloadedFile.name?.includes("/")
                ? downloadedFile.name.substring(downloadedFile.name.lastIndexOf("/") + 1)
                : downloadedFile.name
              const isImuSidecar = leaf?.match(/^imu\.json$/i)
              const isHdrBracket = leaf?.match(/^ev-?\d+\.jpe?g$/i)

              if (!isImuSidecar && !isHdrBracket && downloadedFile.filePath) {
                const imuSidecarPath = downloadedFile.filePath.replace(/\.[^.]+$/, ".imu.json")
                mediaProcessingQueue.enqueue({
                  id: downloadedFile.name,
                  type: isVideo ? "video" : "photo",
                  primaryPath: downloadedFile.filePath,
                  sidecarPath: isVideo ? imuSidecarPath : undefined,
                  timestamp: captureTime,
                  totalSize: downloadedFile.size,
                  duration: downloadedFile.duration,
                  glassesModel: defaultWearable,
                  shouldProcess: !!shouldProcessImages,
                  shouldAutoSave: !!shouldAutoSave,
                  thumbnailPath: downloadedFile.thumbnailPath,
                  deleteFromGlasses: [downloadedFile.name],
                  protocolVersion: 1,
                })
              }
            }
          }

          // Update notification
          gallerySyncNotifications.updateProgress(current, total, fileName, fileProgress || 0)
        },
        signal,
      )

      if (signal?.aborted) return
      downloadedCount = downloadResult.downloaded.length
      failedCount = downloadResult.failed.length

      const downloadDuration = Date.now() - downloadStartTime
      console.log("[GallerySyncService] ========================================")
      console.log("[GallerySyncService] ✅ DOWNLOAD EXECUTION COMPLETE")
      console.log("[GallerySyncService] ========================================")
      console.log("[GallerySyncService]   📊 Results:")
      console.log(`[GallerySyncService]      - Downloaded: ${downloadedCount}`)
      console.log(`[GallerySyncService]      - Failed: ${failedCount}`)
      console.log(`[GallerySyncService]      - Duration: ${(downloadDuration / 1000).toFixed(1)}s`)
      console.log(`[GallerySyncService]      - Total size: ${(downloadResult.total_size / 1024 / 1024).toFixed(2)} MB`)
      if (downloadDuration > 0 && downloadResult.total_size > 0) {
        const _speedMbps = downloadResult.total_size / 1024 / 1024 / (downloadDuration / 1000)
        console.log(`[GallerySyncService]      - Avg speed: ${_speedMbps.toFixed(2)} MB/s`)
      }

      // Mark the last file as complete (if any files were downloaded)
      if (downloadResult.downloaded.length > 0) {
        const lastFileName = downloadResult.downloaded[downloadResult.downloaded.length - 1]?.name
        if (lastFileName) {
          const currentStore = useGallerySyncStore.getState()
          currentStore.onFileComplete(lastFileName)
        }
      }

      // Update queue index to final position
      await localStorageService.updateSyncQueueIndex(files.length)
      if (signal?.aborted) return

      // Mark failed files in store
      for (const failedFileName of downloadResult.failed) {
        const currentStore = useGallerySyncStore.getState()
        currentStore.onFileFailed(failedFileName)
      }

      // Wait for processing queue to finish before marking complete
      console.log("[GallerySyncService]   ⏳ Waiting for processing queue to drain...")
      await this.drainProcessingQueue()
      if (signal?.aborted) return
      console.log("[GallerySyncService]   ✅ Processing queue drained")

      // Download success is not destination success. Export, validation, metadata, and
      // acknowledgement failures are reported asynchronously by the processing queue; fold them
      // back into the legacy result so its timestamp watermark cannot skip the source forever.
      const processingFailures = new Set(useGallerySyncStore.getState().failedFiles)
      for (const file of files) {
        if (processingFailures.has(file.name) && !downloadResult.failed.includes(file.name)) {
          downloadResult.failed.push(file.name)
        }
      }
      failedCount = downloadResult.failed.length

      // Update sync state — only advance watermark if files were downloaded.
      // If any failed, set it before the oldest failure so they get retried.
      let syncWatermark = serverTime
      if (downloadedCount === 0) {
        const currentSyncState = await localStorageService.getSyncState()
        if (signal?.aborted) return
        syncWatermark = currentSyncState.last_sync_time
        console.log("[GallerySyncService]   ℹ️ No files downloaded — last_sync_time unchanged")
      } else if (downloadResult.failed.length > 0) {
        const failedSet = new Set(downloadResult.failed)
        let oldestFailed = Infinity
        for (const f of files) {
          if (failedSet.has(f.name)) {
            const ts = typeof f.modified === "number" ? f.modified : parseInt(String(f.modified), 10)
            if (!isNaN(ts) && ts < oldestFailed) oldestFailed = ts
          }
        }
        if (oldestFailed < Infinity) {
          syncWatermark = Math.max(0, oldestFailed - 1)
          console.log(
            `[GallerySyncService]   ⚠️ ${downloadResult.failed.length} files failed — sync watermark set to ${syncWatermark} instead of ${serverTime}`,
          )
        }
      } else {
        let maxModified = 0
        const failedSet = new Set(downloadResult.failed)
        for (const f of files) {
          if (failedSet.has(f.name)) continue
          const ts = typeof f.modified === "number" ? f.modified : parseInt(String(f.modified), 10)
          if (!isNaN(ts)) maxModified = Math.max(maxModified, ts)
        }
        if (maxModified > 0) {
          syncWatermark = maxModified
        }
      }
      console.log("[GallerySyncService]   💾 Updating sync state in local storage...")
      const currentSyncState = await localStorageService.getSyncState()
      if (signal?.aborted) return
      // Persist if we downloaded anything OR if a failure needs the watermark rolled back.
      // (Otherwise a clock-skew-triggered full sync where every legacy file fails would
      // leave the stale future watermark on disk and never retry those files.)
      if (downloadedCount > 0 || downloadResult.failed.length > 0) {
        await localStorageService.updateSyncState({
          last_sync_time: syncWatermark,
          total_downloaded: currentSyncState.total_downloaded + downloadedCount,
          total_size: currentSyncState.total_size + downloadResult.total_size,
        })
      }
      console.log("[GallerySyncService]   ✅ Sync state updated:")
      console.log(
        `[GallerySyncService]      - New last_sync_time: ${syncWatermark} (${new Date(syncWatermark).toISOString()})`,
      )
      console.log(
        `[GallerySyncService]      - Total downloads (lifetime): ${
          currentSyncState.total_downloaded + downloadedCount
        }`,
      )
      console.log(
        `[GallerySyncService]      - Total data (lifetime): ${(
          (currentSyncState.total_size + downloadResult.total_size) /
          1024 /
          1024
        ).toFixed(2)} MB`,
      )

      if (signal?.aborted) return
      if (failedCount > 0 || galleryTransferLedger.hasPendingRecovery()) {
        store.setSyncError(`${failedCount || "Some"} gallery items need retry`)
      } else {
        store.setSyncComplete()
      }
      await this.onSyncComplete(downloadedCount, failedCount, signal)
    } catch (error: any) {
      if (signal?.aborted) return
      mediaProcessingQueue.abort()
      if (error?.message === "Sync cancelled") {
        console.log("[GallerySyncService] Sync was cancelled")
        store.setSyncCancelled()
        await gallerySyncNotifications.showSyncCancelled()
      } else {
        console.error("[GallerySyncService] Download failed:", error)
        store.setSyncError(error?.message || "Download failed")
        await gallerySyncNotifications.showSyncError(error?.message || "Download failed")
      }

      if (!signal?.aborted) await this.closeHotspot()
    }
  }

  /**
   * Execute capture-aware download (api_version=2).
   * Downloads captures as groups, runs HDR merge, saves single metadata entry per capture.
   */
  private async executeCaptureDownload(
    captures: CaptureGroup[],
    serverTime: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return
    const downloadStartTime = Date.now()
    console.log("[GallerySyncService] ========================================")
    console.log("[GallerySyncService] ⬇️ CAPTURE DOWNLOAD EXECUTION STARTED")
    console.log("[GallerySyncService] ========================================")
    console.log(`[GallerySyncService]   📊 Captures to download: ${captures.length}`)

    const store = useGallerySyncStore.getState()
    const settingsStore = useSettingsStore.getState()
    const defaultWearable = settingsStore.getSetting(SETTINGS.default_wearable.key)

    let downloadedCount = 0
    let failedCount = 0
    let totalSizeDownloaded = 0
    let oldestFailedTimestamp = Infinity // Track for sync watermark
    let maxSuccessfulTimestamp = 0

    const shouldAutoSave = await gallerySettingsService.getAutoSaveToCameraRoll()
    if (signal?.aborted) return
    const shouldProcessImages = useSettingsStore.getState().getSetting(SETTINGS.media_post_processing.key)

    try {
      for (let i = 0; i < captures.length; i++) {
        const capture = captures[i]

        // Check cancellation
        if (signal?.aborted) {
          throw new Error("Sync cancelled")
        }

        // Update store progress
        const currentStore = useGallerySyncStore.getState()
        if (i > 0) {
          // Mark previous capture as complete
          currentStore.onFileComplete(captures[i - 1].capture_id)
          await localStorageService.updateSyncQueueIndex(i)
        }
        if (signal?.aborted) return
        currentStore.setCurrentFile(capture.capture_id, 0)

        try {
          console.log(
            `[GallerySyncService]   📦 Downloading capture ${i + 1}/${captures.length}: ${capture.capture_id} (${
              capture.files.length
            } files)`,
          )

          validateCaptureMetadataForDownload(capture)

          // Download all files in this capture
          const result = await asgCameraApi.downloadCapture(
            capture,
            (bytesDownloaded, totalBytes) => {
              // Don't throw in progress callbacks — abort signal stops the download
              if (signal?.aborted) return
              const progress = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 0
              const cs = useGallerySyncStore.getState()
              cs.onFileProgress(capture.capture_id, Math.min(progress, 99))
              gallerySyncNotifications.updateProgress(i + 1, captures.length, capture.capture_id, progress)
            },
            signal,
          )

          if (signal?.aborted) return
          // Mark 100% progress
          const cs2 = useGallerySyncStore.getState()
          cs2.onFileProgress(capture.capture_id, 100)

          totalSizeDownloaded += capture.total_size
          downloadedCount++
          if (capture.timestamp > maxSuccessfulTimestamp) {
            maxSuccessfulTimestamp = capture.timestamp
          }

          // Enqueue for processing (runs concurrently with next download)
          // Delete from glasses happens after processing completes to avoid data loss on crash
          mediaProcessingQueue.enqueue({
            id: capture.capture_id,
            type: capture.type,
            primaryPath: result.primaryPath,
            bracketPaths: result.bracketPaths,
            sidecarPath: result.sidecarPath,
            thumbnailData: capture.thumbnail_data,
            thumbnailPath: result.thumbnailPath,
            captureDir: result.captureDir,
            timestamp: capture.timestamp,
            totalSize: capture.total_size,
            duration: capture.duration,
            glassesModel: defaultWearable,
            shouldProcess: !!shouldProcessImages,
            shouldAutoSave: !!shouldAutoSave,
            deleteFromGlasses: [capture.capture_id],
            protocolVersion: capture.files.some((file) => !!file.etag) ? 3 : 2,
          })
        } catch (captureError: any) {
          if (signal?.aborted) return
          if (captureError?.message === "Sync cancelled") throw captureError
          const errMsg = captureError?.message || captureError?.toString?.() || JSON.stringify(captureError)
          console.error(`[GallerySyncService]   ❌ Failed to download capture ${capture.capture_id}: ${errMsg}`)
          failedCount++
          // Track oldest failed timestamp so we don't advance sync past it
          if (capture.timestamp < oldestFailedTimestamp) {
            oldestFailedTimestamp = capture.timestamp
          }
          const cs = useGallerySyncStore.getState()
          cs.onFileFailed(capture.capture_id)
        }
      }

      if (signal?.aborted) return
      // Mark last capture as complete
      if (captures.length > 0) {
        const lastCapture = captures[captures.length - 1]
        const cs = useGallerySyncStore.getState()
        cs.onFileComplete(lastCapture.capture_id)
      }

      await localStorageService.updateSyncQueueIndex(captures.length)
      if (signal?.aborted) return

      const downloadDuration = Date.now() - downloadStartTime
      console.log("[GallerySyncService] ========================================")
      console.log("[GallerySyncService] ✅ CAPTURE DOWNLOAD EXECUTION COMPLETE")
      console.log("[GallerySyncService] ========================================")
      console.log(`[GallerySyncService]   📊 Downloaded: ${downloadedCount}, Failed: ${failedCount}`)
      console.log(`[GallerySyncService]   ⏱️ Duration: ${(downloadDuration / 1000).toFixed(1)}s`)

      // Wait for processing queue to finish before marking complete
      console.log("[GallerySyncService]   ⏳ Waiting for processing queue to drain...")
      await this.drainProcessingQueue()
      if (signal?.aborted) return
      console.log("[GallerySyncService]   ✅ Processing queue drained")

      // Reconcile failures from the processing queue. validateDownloadedMediaFile
      // (post-download validation in mediaProcessingQueue) runs AFTER enqueue
      // returns, so a failure there doesn't reach the per-capture catch above. The
      // gallerySync store collects those failures via onFileFailed — pull them in
      // here so the watermark holds them back for retry on the next sync.
      const captureTimestampById = new Map<string, number>()
      for (const c of captures) {
        if (typeof c.timestamp === "number") {
          captureTimestampById.set(c.capture_id, c.timestamp)
        }
      }
      const failedSnapshot = useGallerySyncStore.getState().failedFiles
      const observedFailures = new Set<string>(failedSnapshot)
      for (const failedId of observedFailures) {
        const ts = captureTimestampById.get(failedId)
        if (ts === undefined) continue // failure from a different scope (e.g. file-level), skip
        if (ts < oldestFailedTimestamp) {
          oldestFailedTimestamp = ts
        }
      }
      // failedCount should reflect the total set of failed captures from THIS batch.
      const failedFromThisBatch = captures.filter((c) => observedFailures.has(c.capture_id)).length
      if (failedFromThisBatch > failedCount) {
        failedCount = failedFromThisBatch
      }

      // Update sync state — only advance watermark when captures were downloaded.
      let syncWatermark = serverTime
      const currentSyncState = await localStorageService.getSyncState()
      if (signal?.aborted) return
      if (failedCount > 0 && oldestFailedTimestamp < Infinity) {
        // Failures take priority — roll the watermark back before the oldest failure so it
        // gets retried, regardless of whether anything else succeeded in this batch.
        syncWatermark = Math.max(0, oldestFailedTimestamp - 1)
        console.log(
          `[GallerySyncService]   ⚠️ ${failedCount} captures failed — sync watermark set to ${syncWatermark} instead of ${serverTime} so they will be retried`,
        )
      } else if (downloadedCount === 0) {
        syncWatermark = currentSyncState.last_sync_time
        console.log("[GallerySyncService]   ℹ️ No captures downloaded — last_sync_time unchanged")
      } else if (maxSuccessfulTimestamp > 0) {
        syncWatermark = maxSuccessfulTimestamp
      }
      // Persist if we downloaded anything OR if a failure needs the watermark rolled back
      // (zero-byte / validation failures otherwise leave a stale watermark on disk).
      if (downloadedCount > 0 || (failedCount > 0 && oldestFailedTimestamp < Infinity)) {
        await localStorageService.updateSyncState({
          last_sync_time: syncWatermark,
          total_downloaded: currentSyncState.total_downloaded + downloadedCount,
          total_size: currentSyncState.total_size + totalSizeDownloaded,
        })
      }

      if (signal?.aborted) return
      if (failedCount > 0 || galleryTransferLedger.hasPendingRecovery()) {
        store.setSyncError(`${failedCount || "Some"} gallery items need retry`)
      } else {
        store.setSyncComplete()
      }
      await this.onSyncComplete(downloadedCount, failedCount, signal)
    } catch (error: any) {
      if (signal?.aborted) return
      mediaProcessingQueue.abort()
      if (error?.message === "Sync cancelled") {
        console.log("[GallerySyncService] Sync was cancelled")
        store.setSyncCancelled()
        await gallerySyncNotifications.showSyncCancelled()
      } else {
        console.error("[GallerySyncService] Capture download failed:", error)
        store.setSyncError(error?.message || "Download failed")
        await gallerySyncNotifications.showSyncError(error?.message || "Download failed")
      }

      if (!signal?.aborted) await this.closeHotspot()
    }
  }

  /**
   * Handle sync completion
   */
  private async onSyncComplete(downloadedCount: number, failedCount: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    console.log("[GallerySyncService] ========================================")
    console.log("[GallerySyncService] 🎉 Step 6/6: Sync completion")
    console.log("[GallerySyncService] ========================================")
    console.log("[GallerySyncService]   📊 Final results:")
    console.log(`[GallerySyncService]      - Downloaded: ${downloadedCount}`)
    console.log(`[GallerySyncService]      - Failed: ${failedCount}`)
    console.log(
      `[GallerySyncService]      - Success rate: ${
        downloadedCount > 0 ? ((downloadedCount / (downloadedCount + failedCount)) * 100).toFixed(1) : 0
      }%`,
    )

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

    const hasPendingRecovery = galleryTransferLedger.hasPendingRecovery()
    if (!hasPendingRecovery && failedCount === 0) {
      console.log("[GallerySyncService]   🧹 Clearing completed sync queue...")
      await localStorageService.clearSyncQueue()
      if (signal?.aborted) return
    } else {
      console.log("[GallerySyncService]   ♻️ Keeping recovery state for unfinished export/ack work")
    }

    if (hasPendingRecovery || failedCount > 0) {
      console.log("[GallerySyncService]   📱 Showing retry-required notification...")
      await gallerySyncNotifications.showSyncError(
        failedCount > 0
          ? `${failedCount} gallery item${failedCount === 1 ? "" : "s"} will be retried`
          : "Gallery export or acknowledgement will be retried",
      )
    } else {
      console.log("[GallerySyncService]   📱 Showing completion notification...")
      await gallerySyncNotifications.showSyncComplete(downloadedCount, 0)
    }

    if (signal?.aborted) return
    // Release the admitted phone transport even when the AP pre-existed Gallery.
    const store = useGallerySyncStore.getState()
    const failure = await this.closeHotspot()
    if (failure) throw failure

    if (signal?.aborted) return
    // Record a known empty gallery immediately after successful sync.
    // This ensures UI shows 0 items remaining right away
    // The subsequent query will update this if new photos were taken during sync
    if (!hasPendingRecovery && failedCount === 0 && selectGlassesConnected(useGlassesStore.getState())) {
      console.log("[GallerySyncService]   🔄 Clearing glasses gallery count (synced all items)")
      store.setGlassesGalleryStatus(0, 0, 0, false)
    }

    // Auto-reset to idle after 4 seconds to clear "Sync complete!" message,
    // then query glasses for any new content taken during the sync.
    // The query MUST happen after the reset — otherwise setGlassesGalleryStatus
    // sees syncState="complete" + hasContent=true and immediately resets to idle,
    // making it look like sync accomplished nothing (circular sync loop).
    console.log("[GallerySyncService]   ⏲️ Scheduling auto-reset to idle in 4 seconds...")
    BgTimer.setTimeout(async () => {
      if (signal?.aborted) return
      const currentStore = useGallerySyncStore.getState()
      if (currentStore.syncState === "complete") {
        console.log("[GallerySyncService]   🔄 Auto-resetting sync state to idle")
        currentStore.setSyncState("idle")
      }
      // Now query glasses — any content reported will show the sync button
      // naturally without preempting the "Sync complete!" message
      console.log("[GallerySyncService]   🔍 Querying glasses for post-sync gallery status...")
      await this.queryGlassesGalleryStatus()
    }, 4000)

    console.log("[GallerySyncService] ========================================")
    console.log("[GallerySyncService] ✅ SYNC FULLY COMPLETE")
    console.log("[GallerySyncService] ========================================")
  }

  /**
   * Cancel the current sync
   */
  cancelSync(): Promise<void> {
    if (this.cancellationPromise) return this.cancellationPromise
    const cancellation = this.performCancel().finally(() => {
      if (this.cancellationPromise === cancellation) this.cancellationPromise = null
    })
    this.cancellationPromise = cancellation
    return cancellation
  }

  private async performCancel(): Promise<void> {
    console.log("[GallerySyncService] Cancelling sync...")

    // Abort any ongoing downloads
    this.invalidateAttempt()


    const store = useGallerySyncStore.getState()

    store.setSyncCancelled()
    const failures: unknown[] = []
    const networkFailure = await this.closeHotspot()
    if (networkFailure) failures.push(...(networkFailure instanceof AggregateError ? networkFailure.errors : [networkFailure]))
    try {
      await localStorageService.clearSyncQueue()
    } catch (error) {
      failures.push(error)
    }
    try {
      await gallerySyncNotifications.showSyncCancelled()
    } catch (error) {
      failures.push(error)
    }
    if (failures.length) throw new AggregateError(failures, "Gallery cancellation cleanup failed", {cause: failures[0]})
  }

  /**
   * Close the hotspot
   */
  private closeHotspot(): Promise<Error | null> {
    if (this.hotspotClosePromise) return this.hotspotClosePromise
    const closing = this.performHotspotClose().finally(() => {
      if (this.hotspotClosePromise === closing) this.hotspotClosePromise = null
    })
    this.hotspotClosePromise = closing
    return closing
  }

  private async performHotspotClose(): Promise<Error | null> {
    const wifi = this.wifi
    if (!wifi) return null
    this.wifi = null
    useGallerySyncStore.getState().setHotspotInfo(null)
    try {
      await wifi.release()
      console.log("[GallerySyncService] Glasses Wi-Fi released")
      return null
    } catch (error) {
      console.error("[GallerySyncService] Failed to release the glasses Wi-Fi:", error)
      return error instanceof Error ? error : new Error(String(error))
    }
  }


  private async drainProcessingQueue(): Promise<void> {
    this.drainingProcessing = true
    try {
      await mediaProcessingQueue.waitUntilDrained()
    } finally {
      this.drainingProcessing = false
      this.lastTransferProgressAt = Date.now()
    }
  }

  /** Files are moving over the hotspot, so a dead hotspot or a stall means the sync died. */
  private isTransferring(): boolean {
    return isTransferPhase(useGallerySyncStore.getState().syncState) && !this.drainingProcessing
  }

  /** Notes transfer progress and runs the stall watchdog only while files are transferring. */
  private handleSyncStoreChange = (state: GallerySyncState, previous: GallerySyncState): void => {
    if (state.syncState !== "syncing") {
      this.stopTransferStallWatch()
      if (state.syncState === "complete") this.autoResumes = 0
      return
    }
    if (
      previous.syncState !== "syncing" ||
      state.currentFile !== previous.currentFile ||
      state.currentFileProgress !== previous.currentFileProgress ||
      state.completedFiles !== previous.completedFiles ||
      state.processedFiles !== previous.processedFiles
    ) {
      this.lastTransferProgressAt = Date.now()
    }
    if (this.transferStallTimer === null) {
      this.transferStallTimer = BgTimer.setInterval(
        () => this.checkTransferStalled(),
        TIMING.TRANSFER_STALL_CHECK_INTERVAL_MS,
      )
    }
  }

  private stopTransferStallWatch(): void {
    if (this.transferStallTimer !== null) {
      BgTimer.clearInterval(this.transferStallTimer)
      this.transferStallTimer = null
    }
  }

  private checkTransferStalled(): boolean {
    if (useGallerySyncStore.getState().syncState !== "syncing" || this.drainingProcessing) return false
    const idleMs = Date.now() - this.lastTransferProgressAt
    if (idleMs < TIMING.TRANSFER_STALL_MS) return false
    this.interruptTransfer(`no progress for ${Math.round(idleMs / 1000)}s`)
    return true
  }

  /**
   * iOS suspends the app in the background unless BLE traffic keeps waking it, and its timers
   * do not run meanwhile, so check the transfer as soon as the person is back.
   */
  private checkTransferOnForeground(): void {
    if (this.resumeOnForeground) {
      this.resumeOnForeground = false
      this.autoResume()
      return
    }
    if (!this.isTransferring()) return
    if (useGlassesStore.getState().hotspot?.state === "disabled") {
      this.interruptTransfer("the glasses hotspot is off")
      return
    }
    this.checkTransferStalled()
  }

  /**
   * End a transfer that can no longer finish, release the hotspot, and resume from the files
   * already downloaded: right away when the app is in the foreground, otherwise when it returns.
   */
  private interruptTransfer(reason: string): void {
    const store = useGallerySyncStore.getState()
    if (!this.isTransferring()) return
    console.warn(`[GallerySyncService] Transfer interrupted: ${reason}`)
    this.stopTransferStallWatch()
    this.invalidateAttempt()
    store.setSyncError(SYNC_INTERRUPTED_MESSAGE)

    const generation = this.lifecycleGeneration
    const cleanup = this.closeHotspot().then((failure) => {
      if (failure) throw failure
    })
    void cleanup
      .then(() => {
        if (generation !== this.lifecycleGeneration) return
        if (AppState.currentState === "active") {
          this.autoResume()
        } else {
          this.resumeOnForeground = true
        }
      })
      .catch((error) => {
        console.error("[GallerySyncService] Failed to release the hotspot after an interrupted transfer:", error)
        gallerySyncNotifications.showSyncError(SYNC_INTERRUPTED_MESSAGE)
      })
  }

  private autoResume(): void {
    const store = useGallerySyncStore.getState()
    if (store.syncState !== "error" || store.lastError !== SYNC_INTERRUPTED_MESSAGE) return
    if (!isGlassesConnected(useGlassesStore.getState().connection)) return
    if (this.autoResumes >= TIMING.MAX_AUTO_RESUMES) {
      console.warn("[GallerySyncService] Transfer keeps dying; waiting for the person to tap Sync")
      gallerySyncNotifications.showSyncError(SYNC_INTERRUPTED_MESSAGE)
      return
    }
    this.autoResumes++
    console.log(`[GallerySyncService] Resuming interrupted sync (${this.autoResumes}/${TIMING.MAX_AUTO_RESUMES})`)
    void this.beginSync().catch((error) => {
      console.error("[GallerySyncService] Automatic resume failed:", error)
    })
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
    const signal = (this.abortController ??= new AbortController()).signal
    if (signal.aborted) return
    const queue = await localStorageService.getSyncQueue()
    if (signal.aborted) return

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

    // R5: Resume by going through full startSync() flow to re-request hotspot
    // (stale hotspot credentials are unreliable). The saved queue will be used
    // to skip already-downloaded files when startFileDownload detects them.
    console.log(`[GallerySyncService] Resuming sync from file ${queue.currentIndex + 1}/${queue.files.length}`)
    console.log("[GallerySyncService] Re-requesting hotspot via full startSync flow")
    await this.startSync()
  }

  /**
   * Query glasses for gallery status
   */
  async queryGlassesGalleryStatus(): Promise<void> {
    try {
      await BluetoothSdk.queryGalleryStatus()
    } catch (error) {
      console.error("[GallerySyncService] Failed to query gallery status:", error)
    }
  }

  /** True while pre-flight startSync work is in flight (before sync state transitions). */
  isSyncStarting(): boolean {
    return useGallerySyncStore.getState().syncStarting
  }

  /**
   * Check if sync is currently in progress (hotspot/WiFi/preparation/download phases).
   * Does not include pre-flight — use isSyncStarting() for that.
   */
  isSyncing(): boolean {
    return selectIssyncing(useGallerySyncStore.getState())
  }
}

export const gallerySyncService = GallerySyncService.getInstance()
