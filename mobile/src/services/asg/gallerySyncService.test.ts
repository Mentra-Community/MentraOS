import BluetoothSdk from "@mentra/bluetooth-sdk"

import {asgCameraApi} from "@/services/asg/asgCameraApi"
import {gallerySyncNotifications} from "@/services/asg/gallerySyncNotifications"
import {localStorageService} from "@/services/asg/localStorageService"
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
    getSyncState: jest.fn(),
    saveSyncQueue: jest.fn(() => Promise.resolve()),
    clearSyncQueue: jest.fn(() => Promise.resolve()),
    updateSyncState: jest.fn(() => Promise.resolve()),
  },
}))

jest.mock("@/services/asg/asgCameraApi", () => ({
  asgCameraApi: {
    setServer: jest.fn(),
    syncWithServer: jest.fn(),
  },
}))

jest.mock("@/services/asg/mediaProcessingQueue", () => ({
  mediaProcessingQueue: {
    reset: jest.fn(),
    waitUntilDrained: jest.fn(() => Promise.resolve()),
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
  await (gallerySyncService as unknown as {startFileDownload: (info: typeof HOTSPOT_INFO) => Promise<void>}).startFileDownload(
    HOTSPOT_INFO,
  )
}

describe("GallerySyncService", () => {
  let executeCaptureDownloadSpy: jest.SpyInstance
  let consoleWarnSpy: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    useGallerySyncStore.getState().reset()
    useGlassesStore.getState().reset()
    gallerySyncService.cleanup()

    mockGetSyncState.mockResolvedValue({
      last_sync_time: 0,
      client_id: "test_client",
      total_downloaded: 0,
      total_size: 0,
    })

    mockSyncWithServer.mockResolvedValue(EMPTY_SYNC_RESPONSE)
    mockSetServer.mockImplementation(() => {})

    executeCaptureDownloadSpy = jest
      .spyOn(gallerySyncService as unknown as {executeCaptureDownload: () => Promise<void>}, "executeCaptureDownload")
      .mockResolvedValue(undefined)

    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    executeCaptureDownloadSpy.mockRestore()
    consoleWarnSpy.mockRestore()
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

  describe("startFileDownload /api/sync desync recovery", () => {
    beforeEach(() => {
      useGallerySyncStore.getState().setGlassesGalleryStatus(3, 5, 8, true)
    })

    it("retries with last_sync_time=0 when glasses have content but incremental sync is empty", async () => {
      mockGetSyncState.mockResolvedValue({
        last_sync_time: 1778211091355,
        client_id: "test_client",
        total_downloaded: 27,
        total_size: 1000,
      })
      mockSyncWithServer.mockResolvedValueOnce(EMPTY_SYNC_RESPONSE).mockResolvedValueOnce(CAPTURE_SYNC_RESPONSE)

      await startFileDownload()

      expect(mockSyncWithServer).toHaveBeenCalledTimes(2)
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(1, "test_client", 1778211091355, true)
      expect(mockSyncWithServer).toHaveBeenNthCalledWith(2, "test_client", 0, true)
      expect(executeCaptureDownloadSpy).toHaveBeenCalledWith([FAKE_CAPTURE], 2000)
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Desync detected: glasses report content but /api/sync returned empty"),
      )
    })

    it("does not retry when glasses report no content", async () => {
      useGallerySyncStore.getState().setGlassesGalleryStatus(0, 0, 0, false)
      mockGetSyncState.mockResolvedValue({
        last_sync_time: 1778211091355,
        client_id: "test_client",
        total_downloaded: 27,
        total_size: 1000,
      })
      mockSyncWithServer.mockResolvedValue(EMPTY_SYNC_RESPONSE)

      await startFileDownload()

      expect(mockSyncWithServer).toHaveBeenCalledTimes(1)
      expect(mockSyncWithServer).toHaveBeenCalledWith("test_client", 1778211091355, true)
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
        last_sync_time: 1778211091355,
        client_id: "test_client",
        total_downloaded: 27,
        total_size: 1000,
      })
      mockSyncWithServer.mockResolvedValue(EMPTY_SYNC_RESPONSE)

      await startFileDownload()

      expect(mockSyncWithServer).toHaveBeenCalledTimes(2)
      expect(executeCaptureDownloadSpy).not.toHaveBeenCalled()
      expect(useGallerySyncStore.getState().syncState).toBe("complete")
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Full-sync retry also returned empty"),
      )
    })

    it("does not retry when the first /api/sync response already has captures", async () => {
      mockGetSyncState.mockResolvedValue({
        last_sync_time: 1778211091355,
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
  })
})
