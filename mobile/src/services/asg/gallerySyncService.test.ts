import CoreModule from "@mentra/bluetooth-sdk"

import {gallerySyncNotifications} from "@/services/asg/gallerySyncNotifications"
import {gallerySyncService} from "./gallerySyncService"
import {useGallerySyncStore} from "@/stores/gallerySync"
import {useGlassesStore} from "@/stores/glasses"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

jest.mock("@mentra/bluetooth-sdk", () => {
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
  },
}))

jest.mock("@/services/asg/localStorageService", () => ({
  localStorageService: {
    getSyncQueue: jest.fn(() => Promise.resolve(null)),
    hasResumableSyncQueue: jest.fn(() => Promise.resolve(false)),
  },
}))

jest.mock("@/services/asg/mediaProcessingQueue", () => ({
  mediaProcessingQueue: {
    reset: jest.fn(),
  },
}))

const mockSyncWithServer = jest.fn()

jest.mock("@/services/asg/asgCameraApi", () => ({
  asgCameraApi: {
    syncWithServer: (...args: unknown[]) => mockSyncWithServer(...args),
    setServer: jest.fn(),
  },
}))

jest.mock("@/i18n", () => ({
  translate: jest.fn((key: string) => key),
}))

describe("GallerySyncService", () => {
  beforeEach(() => {
    jest.useFakeTimers()
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
    useGlassesStore.getState().setGlassesInfo({connected: true})
    useGallerySyncStore.getState().setRequestingHotspot()

    useGlassesStore.getState().setGlassesInfo({connected: false})

    expect(useGallerySyncStore.getState().syncState).toBe("error")
    expect(useGallerySyncStore.getState().lastError).toBe("Glasses disconnected")
    expect(gallerySyncNotifications.showSyncError).toHaveBeenCalledWith("Glasses disconnected")
  })

  it("requests hotspot and records ownership when starting sync", async () => {
    useGlassesStore.getState().setGlassesInfo({connected: true})

    await gallerySyncService.startSync()

    expect(useGallerySyncStore.getState().syncState).toBe("requesting_hotspot")
    expect(useGallerySyncStore.getState().syncServiceOpenedHotspot).toBe(true)
    expect(CoreModule.setHotspotState).toHaveBeenCalledWith(true)
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

      expect(CoreModule.setSystemTime).toHaveBeenCalledTimes(1)
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

      expect(CoreModule.setSystemTime).not.toHaveBeenCalled()
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

      expect(CoreModule.setSystemTime).not.toHaveBeenCalled()
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
