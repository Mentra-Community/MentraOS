/* eslint-disable no-restricted-imports */
import BluetoothSdk from "@mentra/bluetooth-sdk-internal"

// gallerySyncService + its asg cluster moved into @mentra/engine; this CI-gated jest
// test stays in the host tree and imports them by relative path so it keeps running
// (island's own test runner is bit-rotted). The stores + GlobalEventEmitter come
// through the host shims, which the @mentra/engine jest mock resolves to the SAME
// real island instances the service uses — so store writes here are visible to it.
import {asgCameraApi} from "../../../modules/engine/src/services/asg/asgCameraApi"
import {gallerySyncNotifications} from "../../../modules/engine/src/services/asg/gallerySyncNotifications"
import {galleryTransferLedger} from "../../../modules/engine/src/services/asg/galleryTransferLedger"
import {gallerySettingsService} from "../../../modules/engine/src/services/asg/gallerySettingsService"
import {onGalleryNotice} from "../../../modules/engine/src/services/asg/galleryNotices"
import {localNetworkTransport} from "../../../modules/engine/src/services/asg/localNetworkTransport"
import {localStorageService} from "../../../modules/engine/src/services/asg/localStorageService"
import {mediaProcessingQueue} from "../../../modules/engine/src/services/asg/mediaProcessingQueue"
import {gallerySyncService} from "../../../modules/engine/src/services/asg/gallerySyncService"
import {MediaLibraryPermissions} from "../../../modules/engine/src/utils/permissions/MediaLibraryPermissions"
import {useGallerySyncStore} from "../../../modules/engine/src/stores/gallerySync"
import {useGlassesStore} from "../../../modules/engine/src/stores/glasses"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import type {CaptureGroup} from "@/types/asg"
import {Platform} from "react-native"
import WifiManager from "react-native-wifi-reborn"

jest.mock("@mentra/bluetooth-sdk", () => {
  const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
  return {
    __esModule: true,
    default: bluetoothSdkMock,
    ...bluetoothSdkMock,
  }
})

jest.mock("@mentra/bluetooth-sdk-internal", () => {
  const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
  return {
    __esModule: true,
    default: bluetoothSdkMock,
  }
})

jest.mock("@dr.pogodin/react-native-fs", () => ({
  getFSInfo: jest.fn(() => Promise.resolve({freeSpace: 1024 * 1024 * 1024})),
}))

jest.mock("@react-native-community/netinfo", () => ({
  fetch: jest.fn(() => Promise.resolve({isWifiEnabled: true, isConnected: true, isInternetReachable: true})),
}))

jest.mock("react-native-wifi-reborn", () => ({
  getCurrentWifiSSID: jest.fn(() => Promise.resolve("")),
  isEnabled: jest.fn(() => Promise.resolve(true)),
}))

// Location-services check moved off @/utils/PermissionsUtils onto the crust native
// module (CrustModule.isLocationServicesEnabled) when gallery sync moved into island.
jest.mock("crust", () => ({
  __esModule: true,
  default: {
    isLocationServicesEnabled: jest.fn(() => Promise.resolve(true)),
  },
}))

// Feature permissions now flow through the island permissions facade (was
// @/utils/PermissionsUtils.checkFeaturePermissions/requestFeaturePermissions). The
// connectivity gate (checkConnectivityRequirementsUI) + alert/navigation seams moved
// host-side (GalleryScreen renders them off engine.gallery.onNotice), so they're no
// longer mocked here.
jest.mock("../../../modules/engine/src/facades/permissions", () => ({
  permissions: {
    check: jest.fn(() => Promise.resolve(true)),
    request: jest.fn(() => Promise.resolve(true)),
    openSettings: jest.fn(() => Promise.resolve()),
  },
  PermissionFeatures: {LOCATION: "location", LOCAL_WIFI: "local_wifi"},
}))

jest.mock("../../../modules/engine/src/utils/permissions/MediaLibraryPermissions", () => ({
  MediaLibraryPermissions: {
    checkPermission: jest.fn(() => Promise.resolve(true)),
    requestPermission: jest.fn(() => Promise.resolve(true)),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/gallerySettingsService", () => ({
  gallerySettingsService: {
    getAutoSaveToCameraRoll: jest.fn(() => Promise.resolve(false)),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/gallerySyncNotifications", () => ({
  gallerySyncNotifications: {
    requestPermissions: jest.fn(() => Promise.resolve()),
    showSyncError: jest.fn(),
    showSyncStarted: jest.fn(() => Promise.resolve()),
    showSyncComplete: jest.fn(() => Promise.resolve()),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/localStorageService", () => ({
  localStorageService: {
    getSyncQueue: jest.fn(() => Promise.resolve(null)),
    hasResumableSyncQueue: jest.fn(() => Promise.resolve(false)),
    updateSyncQueueIndex: jest.fn(() => Promise.resolve()),
    getSyncState: jest.fn(() => Promise.resolve({total_downloaded: 0, total_size: 0})),
    updateSyncState: jest.fn(() => Promise.resolve()),
    saveSyncQueue: jest.fn(() => Promise.resolve()),
    clearSyncQueue: jest.fn(() => Promise.resolve()),
    convertToDownloadedFile: jest.fn((file: any) => file),
    saveDownloadedFile: jest.fn(() => Promise.resolve()),
    getDownloadedFiles: jest.fn(() => Promise.resolve({})),
    reconcileRemoteCaptures: jest.fn(() => Promise.resolve(0)),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/cameraRollExportCoordinator", () => ({
  cameraRollExportCoordinator: {
    initialize: jest.fn(() => Promise.resolve()),
    cleanup: jest.fn(),
    resume: jest.fn(() => Promise.resolve()),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/mediaProcessingQueue", () => ({
  mediaProcessingQueue: {
    reset: jest.fn(),
    retryPending: jest.fn(() => Promise.resolve({retried: 0, failed: 0})),
    enqueue: jest.fn(),
    waitUntilDrained: jest.fn(() => Promise.resolve()),
    abort: jest.fn(),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/asgCameraApi", () => ({
  asgCameraApi: {
    setServer: jest.fn(),
    getV3Manifest: jest.fn(() => Promise.resolve(null)),
    syncWithServer: jest.fn(),
    downloadCapture: jest.fn(),
    batchSyncFiles: jest.fn(),
  },
}))

const mockGetSyncState = localStorageService.getSyncState as jest.Mock
const mockGetDownloadedFiles = localStorageService.getDownloadedFiles as jest.Mock
const mockGetV3Manifest = asgCameraApi.getV3Manifest as jest.Mock
const mockSyncWithServer = asgCameraApi.syncWithServer as jest.Mock
const mockSetServer = asgCameraApi.setServer as jest.Mock
const mockGetCurrentWifiSSID = WifiManager.getCurrentWifiSSID as jest.Mock
const mockIsWifiEnabled = WifiManager.isEnabled as jest.Mock

const EMPTY_SYNC_RESPONSE = {
  data: {
    api_version: 2,
    server_time: 2000,
    captures: [] as CaptureGroup[],
    changed_files: [],
  },
}

const FAKE_CAPTURE: CaptureGroup = {
  capture_id: "IMG_20260205_163852_546_480",
  type: "video",
  timestamp: 1000,
  total_size: 1000,
  files: [{name: "IMG_20260205_163852_546_480/base.mp4", size: 1000, role: "primary"}],
}

const CAPTURE_SYNC_RESPONSE = {
  data: {
    api_version: 2,
    server_time: 2000,
    captures: [FAKE_CAPTURE],
    changed_files: [],
  },
}

const HOTSPOT_INFO = {ssid: "MentraLive_test", password: "00001111", ip: "192.168.43.1"}

async function startFileDownload(): Promise<void> {
  await (
    gallerySyncService as unknown as {startFileDownload: (info: typeof HOTSPOT_INFO) => Promise<void>}
  ).startFileDownload(HOTSPOT_INFO)
}

describe("GallerySyncService", () => {
  const originalPlatformOS = Platform.OS

  beforeEach(() => {
    // Pin Date.now() to match EMPTY_SYNC_RESPONSE.server_time so detectClockSkew stays quiet
    // in tests that don't explicitly want to trigger clock-skew recovery.
    jest.useFakeTimers({now: 2000})
    jest.clearAllMocks()
    mockGetCurrentWifiSSID.mockResolvedValue("")
    mockIsWifiEnabled.mockResolvedValue(true)
    useGallerySyncStore.getState().reset()
    useGlassesStore.getState().reset()
    gallerySyncService.cleanup()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    gallerySyncService.cleanup()
    Object.defineProperty(Platform, "OS", {value: originalPlatformOS, configurable: true, writable: true})
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("updates gallery status from glasses events", () => {
    gallerySyncService.initialize()

    GlobalEventEmitter.emit("gallery_status", {
      photos: 2,
      videos: 1,
      total: 3,
      has_content: true,
      camera_busy: false,
    })

    expect(useGallerySyncStore.getState()).toEqual(
      expect.objectContaining({
        glassesPhotoCount: 2,
        glassesVideoCount: 1,
        glassesTotalCount: 3,
        glassesHasContent: true,
      }),
    )
  })

  it("cancels an active sync if glasses disconnect", () => {
    gallerySyncService.initialize()
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    useGallerySyncStore.getState().setRequestingHotspot()

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})

    expect(useGallerySyncStore.getState().syncState).toBe("error")
    expect(useGallerySyncStore.getState().lastError).toBe("Glasses disconnected")
    expect(gallerySyncNotifications.showSyncError).toHaveBeenCalledWith("Glasses disconnected")
  })

  it("requests hotspot and records ownership when starting sync", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})

    await gallerySyncService.startSync()

    expect(useGallerySyncStore.getState().syncState).toBe("requesting_hotspot")
    expect(useGallerySyncStore.getState().syncServiceOpenedHotspot).toBe(true)
    expect(BluetoothSdk.setHotspotState).toHaveBeenCalledWith(true)
  })

  it("establishes scoped routing when the system SSID already matches the hotspot", async () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      hotspotEnabled: true,
      hotspotSsid: HOTSPOT_INFO.ssid,
      hotspotPassword: HOTSPOT_INFO.password,
      hotspotGatewayIp: HOTSPOT_INFO.ip,
    })
    mockGetCurrentWifiSSID.mockResolvedValue(HOTSPOT_INFO.ssid)
    jest.spyOn(localNetworkTransport, "supportsScopedConnection").mockReturnValue(true)
    jest.spyOn(localNetworkTransport, "isScopedConnectionActive").mockReturnValue(false)
    const connectSpy = jest.spyOn(gallerySyncService as any, "connectToHotspotWifi").mockResolvedValue(undefined)
    const downloadSpy = jest.spyOn(gallerySyncService as any, "startFileDownload").mockResolvedValue(undefined)

    await gallerySyncService.startSync()

    expect(connectSpy).toHaveBeenCalledWith(HOTSPOT_INFO)
    expect(downloadSpy).not.toHaveBeenCalled()
    expect(BluetoothSdk.setHotspotState).not.toHaveBeenCalled()
  })

  it("does not begin a source-destructive sync when camera-roll intent is on but permission is denied", async () => {
    ;(gallerySettingsService.getAutoSaveToCameraRoll as jest.Mock).mockResolvedValueOnce(true)
    ;(MediaLibraryPermissions.checkPermission as jest.Mock).mockResolvedValueOnce(false)
    ;(MediaLibraryPermissions.requestPermission as jest.Mock).mockResolvedValueOnce(false)
    const notices: string[] = []
    const unsubscribe = onGalleryNotice((notice) => notices.push(notice.code))
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})

    await gallerySyncService.startSync()
    unsubscribe()

    expect(notices).toContain("camera_roll_permission_required")
    expect(useGallerySyncStore.getState().syncState).toBe("error")
    expect(BluetoothSdk.setHotspotState).not.toHaveBeenCalled()
    expect(mediaProcessingQueue.reset).not.toHaveBeenCalled()
  })

  it("aborts pre-flight quietly when glasses disconnect during any pre-flight await", async () => {
    // Suspend the notification-permission pre-flight await, disconnect mid-flight,
    // then resolve — shouldAbortPreFlight() (which re-checks glasses connection
    // after the await) must abort quietly.
    let resolvePreflightGate: () => void = () => {
      throw new Error("Pre-flight gate resolver was not initialized")
    }
    ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePreflightGate = () => resolve()
        }),
    )

    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})

    const startPromise = gallerySyncService.startSync()
    expect(gallerySyncService.isSyncStarting()).toBe(true)
    expect(gallerySyncService.isSyncing()).toBe(false)

    // The island pre-flight now awaits the bluetooth-adapter check before the
    // permission step — flush microtasks until the permission gate arms.
    for (let i = 0; i < 20 && (gallerySyncNotifications.requestPermissions as jest.Mock).mock.calls.length === 0; i++) {
      await Promise.resolve()
    }

    // Disconnect while the permission request is in flight — shouldAbortPreFlight catches it after the await
    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})

    resolvePreflightGate()
    await startPromise

    expect(useGallerySyncStore.getState().syncState).toBe("idle")
    expect(useGallerySyncStore.getState().lastError).toBeNull()
    expect(BluetoothSdk.setHotspotState).not.toHaveBeenCalled()
    // The gate ran once, then pre-flight aborted before requesting the hotspot.
    expect(gallerySyncNotifications.requestPermissions).toHaveBeenCalledTimes(1)
  })

  it("coalesces concurrent startSync calls into a single pre-flight attempt", async () => {
    // Suspend the notification-permission pre-flight await. Two concurrent
    // startSync() calls must coalesce into a single pre-flight attempt.
    let resolvePreflightGate: () => void = () => {
      throw new Error("Pre-flight gate resolver was not initialized")
    }
    ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePreflightGate = () => resolve()
        }),
    )

    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})

    const first = gallerySyncService.startSync()
    const second = gallerySyncService.startSync()

    expect(gallerySyncService.isSyncStarting()).toBe(true)

    // The island pre-flight now awaits the bluetooth-adapter check before the
    // permission step — flush microtasks until the permission gate arms.
    for (let i = 0; i < 20 && (gallerySyncNotifications.requestPermissions as jest.Mock).mock.calls.length === 0; i++) {
      await Promise.resolve()
    }
    expect(gallerySyncNotifications.requestPermissions).toHaveBeenCalledTimes(1)

    resolvePreflightGate()
    await Promise.all([first, second])

    expect(useGallerySyncStore.getState().syncState).toBe("requesting_hotspot")
  })

  it("makes sync tappable and uses native WiFi state after returning from settings", async () => {
    Object.defineProperty(Platform, "OS", {value: "android", configurable: true, writable: true})
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    useGallerySyncStore.getState().setSyncError("WiFi disabled - enable WiFi and try again")
    ;(gallerySyncService as any).waitingForWifiRetry = true
    ;(gallerySyncService as any).wifiSettingsOpenedAt = Date.now()
    mockIsWifiEnabled.mockResolvedValueOnce(true)
    const startSpy = jest.spyOn(gallerySyncService, "startSync").mockResolvedValue(undefined)

    const foregroundPromise = (gallerySyncService as any).handleAppStateChange("active")
    expect(useGallerySyncStore.getState().syncState).toBe("idle")
    await jest.advanceTimersByTimeAsync(1000)
    await foregroundPromise

    expect(mockIsWifiEnabled).toHaveBeenCalledTimes(1)
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect((gallerySyncService as any).waitingForWifiRetry).toBe(false)
    expect((gallerySyncService as any).wifiSettingsOpenedAt).toBeNull()
  })

  it("releases the WiFi retry guard after native checks fail", async () => {
    Object.defineProperty(Platform, "OS", {value: "android", configurable: true, writable: true})
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    useGallerySyncStore.getState().setSyncError("WiFi disabled - enable WiFi and try again")
    ;(gallerySyncService as any).waitingForWifiRetry = true
    ;(gallerySyncService as any).wifiSettingsOpenedAt = Date.now()
    mockIsWifiEnabled.mockResolvedValue(false)
    const startSpy = jest.spyOn(gallerySyncService, "startSync").mockResolvedValue(undefined)

    const foregroundPromise = (gallerySyncService as any).handleAppStateChange("active")
    await jest.advanceTimersByTimeAsync(5000)
    await foregroundPromise

    expect(useGallerySyncStore.getState().syncState).toBe("idle")
    expect(startSpy).not.toHaveBeenCalled()
    expect((gallerySyncService as any).waitingForWifiRetry).toBe(false)
    expect((gallerySyncService as any).wifiSettingsOpenedAt).toBeNull()
  })

  it("keeps sync watermark before zero-byte video captures", async () => {
    const serverTime = 1_700_000_000_000
    const failedTimestamp = serverTime - 5_000
    const zeroByteCapture = {
      capture_id: "VID_zero",
      type: "video" as const,
      timestamp: failedTimestamp,
      total_size: 0,
      files: [{name: "VID_zero/base.mp4", size: 0, role: "primary" as const}],
    }

    await (gallerySyncService as any).executeCaptureDownload([zeroByteCapture], serverTime)

    expect(asgCameraApi.downloadCapture).not.toHaveBeenCalled()
    expect(mediaProcessingQueue.enqueue).not.toHaveBeenCalled()
    expect(useGallerySyncStore.getState().failedFiles).toContain("VID_zero")
    expect(localStorageService.updateSyncState).toHaveBeenCalledWith({
      last_sync_time: failedTimestamp - 1,
      total_downloaded: 0,
      total_size: 0,
    })
  })

  it("holds back sync watermark when post-download validation fails async in the queue", async () => {
    // Regression for the bug where validateDownloadedMediaFile failures inside
    // mediaProcessingQueue (post-download, async) didn't surface to
    // executeCaptureDownload's failedCount/oldestFailedTimestamp — letting the
    // watermark advance to serverTime and skipping the broken capture forever.
    const serverTime = 1_700_000_000_000
    const failedTimestamp = serverTime - 10_000
    const capture = {
      capture_id: "VID_validation_fail",
      type: "video" as const,
      timestamp: failedTimestamp,
      total_size: 100,
      files: [{name: "VID_validation_fail/base.mp4", size: 100, role: "primary" as const}],
    }
    ;(asgCameraApi.downloadCapture as jest.Mock).mockResolvedValue({
      primaryPath: "/tmp/VID_validation_fail/base.mp4",
      bracketPaths: undefined,
      sidecarPath: undefined,
      captureDir: "/tmp/VID_validation_fail",
    })
    // Simulate the processing queue running and reporting a validation failure
    // via the gallerySync store (the same path validateDownloadedMediaFile takes).
    ;(mediaProcessingQueue.waitUntilDrained as jest.Mock).mockImplementation(async () => {
      useGallerySyncStore.getState().onFileFailed(capture.capture_id, "Invalid downloaded media")
    })

    await (gallerySyncService as any).executeCaptureDownload([capture], serverTime)

    expect(useGallerySyncStore.getState().failedFiles).toContain("VID_validation_fail")
    expect(localStorageService.updateSyncState).toHaveBeenCalledWith({
      last_sync_time: failedTimestamp - 1,
      total_downloaded: 1,
      total_size: 100,
    })
  })

  it("passes the downloaded thumbnail to capture-aware media processing", async () => {
    const capture = {
      capture_id: "VID_with_thumbnail",
      type: "video" as const,
      timestamp: 1_000,
      total_size: 100,
      files: [{name: "VID_with_thumbnail/base.mp4", size: 100, role: "primary" as const}],
    }
    ;(asgCameraApi.downloadCapture as jest.Mock).mockResolvedValue({
      primaryPath: "/tmp/VID_with_thumbnail/base.mp4",
      bracketPaths: [],
      sidecarPath: undefined,
      captureDir: "/tmp/VID_with_thumbnail",
      thumbnailPath: "/tmp/VID_with_thumbnail/.thumb.jpg",
    })

    await (gallerySyncService as any).executeCaptureDownload([capture], 2_000)

    expect(mediaProcessingQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        id: capture.capture_id,
        thumbnailPath: "/tmp/VID_with_thumbnail/.thumb.jpg",
      }),
    )
  })

  it("holds back the legacy watermark when processing fails after download", async () => {
    const serverTime = 1_700_000_000_000
    const failedTimestamp = serverTime - 20_000
    const file = {
      name: "IMG_legacy_failure.jpg",
      size: 100,
      modified: failedTimestamp,
      is_video: false,
      filePath: "/tmp/IMG_legacy_failure.jpg",
    }
    ;(asgCameraApi.batchSyncFiles as jest.Mock).mockResolvedValue({downloaded: [file], failed: [], total_size: 100})
    ;(mediaProcessingQueue.waitUntilDrained as jest.Mock).mockImplementation(async () => {
      useGallerySyncStore.getState().onFileFailed(file.name, "PhotoKit unavailable")
    })

    await (gallerySyncService as any).executeDownload([file], serverTime)

    expect(localStorageService.updateSyncState).toHaveBeenCalledWith({
      last_sync_time: failedTimestamp - 1,
      total_downloaded: 1,
      total_size: 100,
    })
    expect(useGallerySyncStore.getState().syncState).toBe("error")
    expect(localStorageService.clearSyncQueue).not.toHaveBeenCalled()
  })

  describe("startFileDownload /api/sync desync recovery", () => {
    let executeCaptureDownloadSpy: jest.SpyInstance
    let consoleWarnSpy: jest.SpyInstance
    let consoleLogSpy: jest.SpyInstance

    beforeEach(() => {
      useGallerySyncStore.getState().setGlassesGalleryStatus(3, 5, 8, true)
      // Reset the singleton's full-sync guard between tests so each test starts fresh.
      ;(gallerySyncService as unknown as {lastFullSyncRetryKey: string | null}).lastFullSyncRetryKey = null

      mockSyncWithServer.mockResolvedValue(EMPTY_SYNC_RESPONSE)
      mockSetServer.mockImplementation(() => {})

      executeCaptureDownloadSpy = jest
        .spyOn(gallerySyncService as unknown as {executeCaptureDownload: () => Promise<void>}, "executeCaptureDownload")
        .mockResolvedValue(undefined)

      consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
      consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {})
    })

    afterEach(() => {
      executeCaptureDownloadSpy.mockRestore()
      consoleWarnSpy.mockRestore()
      consoleLogSpy.mockRestore()
    })

    it("retries with last_sync_time=0 when glasses have content but incremental sync is empty", async () => {
      mockGetSyncState.mockResolvedValue({
        last_sync_time: 1500,
        client_id: "test_client",
        total_downloaded: 27,
        total_size: 1000,
      })
      mockSyncWithServer.mockResolvedValueOnce(EMPTY_SYNC_RESPONSE).mockResolvedValueOnce(CAPTURE_SYNC_RESPONSE)

      await startFileDownload()

      expect(mockSyncWithServer).toHaveBeenCalledTimes(2)
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(1, "test_client", 1500, false)
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(2, "test_client", 0, false)
      expect(executeCaptureDownloadSpy).toHaveBeenCalledWith([FAKE_CAPTURE], 2000)
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Empty sync but glasses report content — retrying with last_sync_time=0"),
      )
    })

    it("does not retry when glasses report no content", async () => {
      useGallerySyncStore.getState().setGlassesGalleryStatus(0, 0, 0, false)
      mockGetSyncState.mockResolvedValue({
        last_sync_time: 1500,
        client_id: "test_client",
        total_downloaded: 27,
        total_size: 1000,
      })
      mockSyncWithServer.mockResolvedValue(EMPTY_SYNC_RESPONSE)

      await startFileDownload()

      expect(mockSyncWithServer).toHaveBeenCalledTimes(1)
      expect(mockSyncWithServer).toHaveBeenCalledWith("test_client", 1500, false)
      expect(executeCaptureDownloadSpy).not.toHaveBeenCalled()
      expect(useGallerySyncStore.getState().syncState).toBe("complete")
    })

    it("does not report completion when durable recovery is still pending", async () => {
      useGallerySyncStore.getState().setGlassesGalleryStatus(0, 0, 0, false)
      mockGetSyncState.mockResolvedValue({
        last_sync_time: 1500,
        client_id: "test_client",
        total_downloaded: 27,
        total_size: 1000,
      })
      mockSyncWithServer.mockResolvedValue(EMPTY_SYNC_RESPONSE)
      const pendingRecoverySpy = jest.spyOn(galleryTransferLedger, "hasPendingRecovery").mockReturnValue(true)

      try {
        await startFileDownload()
      } finally {
        pendingRecoverySpy.mockRestore()
      }

      expect(useGallerySyncStore.getState().syncState).toBe("error")
      expect(gallerySyncNotifications.showSyncComplete).not.toHaveBeenCalled()
      expect(gallerySyncNotifications.showSyncError).toHaveBeenCalledWith(
        "Gallery export or acknowledgement will be retried",
      )
      expect(localStorageService.clearSyncQueue).not.toHaveBeenCalled()
    })

    it("does not retry on first sync when last_sync_time is 0", async () => {
      mockGetSyncState.mockResolvedValue({
        last_sync_time: 0,
        client_id: "test_client",
        total_downloaded: 0,
        total_size: 0,
      })
      mockSyncWithServer.mockResolvedValue(EMPTY_SYNC_RESPONSE)

      await startFileDownload()

      expect(mockSyncWithServer).toHaveBeenCalledTimes(1)
      expect(mockSyncWithServer).toHaveBeenCalledWith("test_client", 0, false)
      expect(consoleWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Desync detected"))
    })

    it("retries at most once when full-sync retry is also empty", async () => {
      mockGetSyncState.mockResolvedValue({
        last_sync_time: 1500,
        client_id: "test_client",
        total_downloaded: 27,
        total_size: 1000,
      })
      mockSyncWithServer.mockResolvedValue(EMPTY_SYNC_RESPONSE)

      await startFileDownload()

      expect(mockSyncWithServer).toHaveBeenCalledTimes(2)
      expect(executeCaptureDownloadSpy).not.toHaveBeenCalled()
      // PR's resolveSyncManifest surfaces an error when glasses still report content after retry —
      // this is the loud failure mode for "leftover files on glasses that we can't see".
      expect(useGallerySyncStore.getState().syncState).toBe("error")
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Empty sync while glasses still report gallery content"),
      )
    })

    it("does not retry when the first /api/sync response already has captures", async () => {
      mockGetSyncState.mockResolvedValue({
        last_sync_time: 1500,
        client_id: "test_client",
        total_downloaded: 27,
        total_size: 1000,
      })
      mockSyncWithServer.mockResolvedValue(CAPTURE_SYNC_RESPONSE)

      await startFileDownload()

      expect(mockSyncWithServer).toHaveBeenCalledTimes(1)
      expect(executeCaptureDownloadSpy).toHaveBeenCalledWith([FAKE_CAPTURE], 2000)
      expect(consoleWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Desync detected"))
    })

    it("does not retry full-sync twice for the same (client_id, last_sync_time) pair", async () => {
      // Regression: if glasses retain leftover files from a failed delete-from-glasses,
      // `has_content` stays true and /api/sync stays empty for the same watermark. Without
      // a guard, every sync would retry with last_sync_time=0 and re-download the whole gallery.
      mockGetSyncState.mockResolvedValue({
        last_sync_time: 1500,
        client_id: "test_client",
        total_downloaded: 27,
        total_size: 1000,
      })
      mockSyncWithServer.mockResolvedValue(EMPTY_SYNC_RESPONSE)

      await startFileDownload()

      // onSyncComplete clears glassesHasContent; re-set it to simulate glasses still
      // reporting leftover files (the exact desync condition the guard protects against).
      useGallerySyncStore.getState().setGlassesGalleryStatus(3, 5, 8, true)

      await startFileDownload()

      // First call: incremental + full-sync retry = 2 calls.
      // Second call: incremental only — guard suppresses the retry.
      expect(mockSyncWithServer).toHaveBeenCalledTimes(3)
      expect(executeCaptureDownloadSpy).not.toHaveBeenCalled()
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("already retried this watermark, skipping to avoid re-download loop"),
      )
    })
  })

  describe("resolveSyncManifest (clock skew)", () => {
    const resolveSyncManifest = (clientId: string, lastSyncTime: number) =>
      (gallerySyncService as any).resolveSyncManifest(clientId, lastSyncTime)

    beforeEach(() => {
      mockGetV3Manifest.mockResolvedValue(null)
      mockSyncWithServer.mockReset()
    })

    it("fixes glasses clock and retries full sync when watermark is ahead of server time", async () => {
      const phoneNow = Date.now()
      const glassesServerTime = phoneNow - 32 * 24 * 60 * 60 * 1000
      const futureWatermark = phoneNow

      mockSyncWithServer
        .mockResolvedValueOnce({
          data: {server_time: glassesServerTime, changed_files: [], client_id: "c1"},
        })
        .mockResolvedValueOnce({
          data: {
            server_time: phoneNow,
            changed_files: [{name: "IMG_1.jpg", size: 1, modified: glassesServerTime}],
            client_id: "c1",
          },
        })

      const resultPromise = resolveSyncManifest("c1", futureWatermark)
      await jest.advanceTimersByTimeAsync(600)
      const result = await resultPromise

      expect(BluetoothSdk.setSystemTime).toHaveBeenCalledTimes(1)
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(1, "c1", futureWatermark, false)
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(2, "c1", 0, false)
      expect(result).not.toBeNull()
      expect(result?.syncData.changed_files).toHaveLength(1)
    })

    it("does not call setSystemTime when clocks are aligned", async () => {
      const now = Date.now()
      mockSyncWithServer.mockResolvedValue({
        data: {
          server_time: now,
          changed_files: [{name: "a.jpg", size: 1}],
          client_id: "c1",
        },
      })

      await resolveSyncManifest("c1", now - 1000)

      expect(BluetoothSdk.setSystemTime).not.toHaveBeenCalled()
    })

    it("retries with last_sync_time=0 when empty but glasses have content", async () => {
      const now = Date.now()
      useGallerySyncStore.getState().setGlassesGalleryStatus(2, 1, 3, true)

      mockSyncWithServer
        .mockResolvedValueOnce({
          data: {server_time: now, changed_files: [], client_id: "c1"},
        })
        .mockResolvedValueOnce({
          data: {server_time: now, changed_files: [{name: "b.jpg", size: 1}], client_id: "c1"},
        })

      const result = await resolveSyncManifest("c1", now - 5000)

      expect(BluetoothSdk.setSystemTime).not.toHaveBeenCalled()
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(2, "c1", 0, false)
      expect(result?.syncData.changed_files).toHaveLength(1)
    })

    it("returns null when still empty and glasses report content", async () => {
      const now = Date.now()
      useGallerySyncStore.getState().setGlassesGalleryStatus(1, 0, 1, true)

      mockSyncWithServer.mockResolvedValue({
        data: {server_time: now, changed_files: [], client_id: "c1"},
      })

      const result = await resolveSyncManifest("c1", now - 5000)

      expect(result).toBeNull()
    })

    it("allows legitimate empty sync when glasses have no content", async () => {
      const now = Date.now()
      useGallerySyncStore.getState().setGlassesGalleryStatus(0, 0, 0, false)

      mockSyncWithServer.mockResolvedValue({
        data: {server_time: now, changed_files: [], client_id: "c1"},
      })

      const result = await resolveSyncManifest("c1", now - 5000)

      expect(result).not.toBeNull()
      expect(result?.syncData.changed_files).toHaveLength(0)
    })
  })

  describe("v3 manifest reconciliation", () => {
    it("does not suppress a remote capture when its committed ledger row has no local gallery record", async () => {
      mockGetV3Manifest.mockResolvedValue({
        api_version: 3,
        captures: [FAKE_CAPTURE],
        has_more: false,
        next_cursor: null,
        total_count: 1,
        server_time: Date.now(),
      })
      mockGetDownloadedFiles.mockResolvedValue({})
      const committedSpy = jest.spyOn(galleryTransferLedger, "isLocallyCommitted").mockReturnValue(true)

      const result = await (gallerySyncService as any).fetchSyncManifest("c1", 0)

      expect(result.captures).toEqual([FAKE_CAPTURE])
      expect(localStorageService.reconcileRemoteCaptures).toHaveBeenCalledWith([FAKE_CAPTURE.capture_id], {})
      committedSpy.mockRestore()
    })
  })
})
