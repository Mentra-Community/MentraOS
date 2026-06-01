import BluetoothSdk from "@mentra/bluetooth-sdk-internal"

import {asgCameraApi} from "@/services/asg/asgCameraApi"
import {gallerySyncNotifications} from "@/services/asg/gallerySyncNotifications"
import {localStorageService} from "@/services/asg/localStorageService"
import {mediaProcessingQueue} from "@/services/asg/mediaProcessingQueue"
import {gallerySyncService} from "./gallerySyncService"
import {useGallerySyncStore} from "@/stores/gallerySync"
import {useGlassesStore} from "@/stores/glasses"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import type {CaptureGroup} from "@/types/asg"

jest.mock("@mentra/bluetooth-sdk", () => {
  const {coreModuleMock} = require("@/test-utils/mockCoreModule")
  return {
    __esModule: true,
    default: coreModuleMock,
  }
})

jest.mock("@mentra/bluetooth-sdk-internal", () => {
  const {coreModuleMock} = require("@/test-utils/mockCoreModule")
  return {
    __esModule: true,
    default: coreModuleMock,
  }
})

jest.mock("@dr.pogodin/react-native-fs", () => ({
  getFSInfo: jest.fn(() => Promise.resolve({freeSpace: 1024 * 1024 * 1024})),
}))

jest.mock("@react-native-community/netinfo", () => ({
  fetch: jest.fn(() => Promise.resolve({isWifiEnabled: true, isConnected: true, isInternetReachable: true})),
}))

jest.mock("react-native-wifi-reborn", () => ({
  isEnabled: jest.fn(() => Promise.resolve(true)),
}))

jest.mock("@/utils/PermissionsUtils", () => ({
  PermissionFeatures: {LOCATION: "location"},
  checkConnectivityRequirementsUI: jest.fn(() => Promise.resolve(true)),
  checkFeaturePermissions: jest.fn(() => Promise.resolve(true)),
  requestFeaturePermissions: jest.fn(() => Promise.resolve(true)),
  isLocationServicesEnabled: jest.fn(() => Promise.resolve(true)),
}))

jest.mock("@/utils/AlertUtils", () => ({
  showAlert: jest.fn(),
  __esModule: true,
  default: jest.fn(),
}))

jest.mock("@/utils/SettingsNavigationUtils", () => ({
  SettingsNavigationUtils: {
    openWifiSettings: jest.fn(),
  },
}))

jest.mock("@/utils/permissions/MediaLibraryPermissions", () => ({
  MediaLibraryPermissions: {
    checkPermission: jest.fn(() => Promise.resolve(true)),
    requestPermission: jest.fn(() => Promise.resolve(true)),
  },
}))

jest.mock("@/services/asg/gallerySettingsService", () => ({
  gallerySettingsService: {
    getAutoSaveToCameraRoll: jest.fn(() => Promise.resolve(false)),
  },
}))

jest.mock("@/services/asg/gallerySyncNotifications", () => ({
  gallerySyncNotifications: {
    requestPermissions: jest.fn(() => Promise.resolve()),
    showSyncError: jest.fn(),
    showSyncStarted: jest.fn(() => Promise.resolve()),
    showSyncComplete: jest.fn(() => Promise.resolve()),
  },
}))

jest.mock("@/services/asg/localStorageService", () => ({
  localStorageService: {
    getSyncQueue: jest.fn(() => Promise.resolve(null)),
    hasResumableSyncQueue: jest.fn(() => Promise.resolve(false)),
    updateSyncQueueIndex: jest.fn(() => Promise.resolve()),
    getSyncState: jest.fn(() => Promise.resolve({total_downloaded: 0, total_size: 0})),
    updateSyncState: jest.fn(() => Promise.resolve()),
    saveSyncQueue: jest.fn(() => Promise.resolve()),
    clearSyncQueue: jest.fn(() => Promise.resolve()),
  },
}))

jest.mock("@/services/asg/mediaProcessingQueue", () => ({
  mediaProcessingQueue: {
    reset: jest.fn(),
    enqueue: jest.fn(),
    waitUntilDrained: jest.fn(() => Promise.resolve()),
    abort: jest.fn(),
  },
}))

jest.mock("@/services/asg/asgCameraApi", () => ({
  asgCameraApi: {
    setServer: jest.fn(),
    syncWithServer: jest.fn(),
    downloadCapture: jest.fn(),
  },
}))

jest.mock("@/i18n", () => ({
  translate: jest.fn((key: string) => key),
}))

const mockGetSyncState = localStorageService.getSyncState as jest.Mock
const mockSyncWithServer = asgCameraApi.syncWithServer as jest.Mock
const mockSetServer = asgCameraApi.setServer as jest.Mock

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
  beforeEach(() => {
    // Pin Date.now() to match EMPTY_SYNC_RESPONSE.server_time so detectClockSkew stays quiet
    // in tests that don't explicitly want to trigger clock-skew recovery.
    jest.useFakeTimers({now: 2000})
    jest.clearAllMocks()
    useGallerySyncStore.getState().reset()
    useGlassesStore.getState().reset()
    gallerySyncService.cleanup()
  })

  afterEach(() => {
    gallerySyncService.cleanup()
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
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(1, "test_client", 1500, true)
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(2, "test_client", 0, true)
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
      expect(mockSyncWithServer).toHaveBeenCalledWith("test_client", 1500, true)
      expect(executeCaptureDownloadSpy).not.toHaveBeenCalled()
      expect(useGallerySyncStore.getState().syncState).toBe("complete")
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
      expect(mockSyncWithServer).toHaveBeenCalledWith("test_client", 0, true)
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
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(1, "c1", futureWatermark, true)
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(2, "c1", 0, true)
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
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(2, "c1", 0, true)
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
})
