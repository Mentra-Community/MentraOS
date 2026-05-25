import BluetoothSdk from "@mentra/bluetooth-sdk"

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

jest.mock("@/services/asg/asgCameraApi", () => ({
  asgCameraApi: {},
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
})
