import * as RNFS from "@dr.pogodin/react-native-fs"
import {AbortController as ReactNativeAbortController} from "abort-controller/dist/abort-controller"
/* eslint-disable no-restricted-imports */
import {permissions} from "../../../modules/engine/src/facades/permissions"
import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import CrustModule from "@mentra/crust"

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
import {gallerySyncService, SYNC_INTERRUPTED_MESSAGE} from "../../../modules/engine/src/services/asg/gallerySyncService"
import {MediaLibraryPermissions} from "../../../modules/engine/src/utils/permissions/MediaLibraryPermissions"
import {useGallerySyncStore} from "../../../modules/engine/src/stores/gallerySync"
import {useGlassesStore} from "../../../modules/engine/src/stores/glasses"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import type {CaptureGroup} from "@/types/asg"
import {AppState, Platform} from "react-native"
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
    showSyncCancelled: jest.fn(() => Promise.resolve()),
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
const BINDING = {
  ssid: HOTSPOT_INFO.ssid,
  password: HOTSPOT_INFO.password,
  gateway: HOTSPOT_INFO.ip,
  phoneIpv4: "192.168.43.2",
}
const mockHoldGlassesWifi = jest.requireMock("@mentra/bluetooth-sdk/glasses-wifi")
  .holdGlassesWifi as jest.Mock

/** The hold the glasses Wi-Fi service hands out; a test can drop the link under it. */
function fakeWifiHold() {
  const listeners = new Set<(event: {type: string; reason?: string}) => void>()
  return {
    binding: BINDING,
    onChange: jest.fn((listener: (event: {type: string; reason?: string}) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    ready: jest.fn(async () => BINDING),
    release: jest.fn(async () => {}),
    lose: (reason = "the glasses turned their hotspot off") =>
      listeners.forEach((listener) => listener({type: "lost", reason})),
  }
}
let wifiHold = fakeWifiHold()

async function startFileDownload(): Promise<void> {
  await (
    gallerySyncService as unknown as {startFileDownload: (info: typeof HOTSPOT_INFO) => Promise<void>}
  ).startFileDownload(HOTSPOT_INFO)
}

/** Starts a sync that holds the link and stops where its download would begin. */
async function startHeldSync(): Promise<void> {
  jest
    .spyOn(gallerySyncService as unknown as {startFileDownload(): Promise<void>}, "startFileDownload")
    .mockResolvedValueOnce(undefined)
  await gallerySyncService.startSync()
}

describe("GallerySyncService", () => {
  const originalPlatformOS = Platform.OS

  beforeEach(async () => {
    // Drain retained ownership before resetting the stores used to verify its pair.
    await gallerySyncService.cleanup()
    // Pin Date.now() to match EMPTY_SYNC_RESPONSE.server_time so detectClockSkew stays quiet
    // in tests that don't explicitly want to trigger clock-skew recovery.
    jest.useFakeTimers({now: 2000})
    jest.clearAllMocks()
    Object.defineProperty(CrustModule, "isIOSAppOnMac", {value: false, configurable: true, writable: true})
    mockIsWifiEnabled.mockResolvedValue(true)
    wifiHold = fakeWifiHold()
    mockHoldGlassesWifi.mockImplementation(async () => wifiHold)
    // On iOS a sync probes the glasses' server before its download; it answers.
    jest.spyOn(localNetworkTransport, "fetch").mockResolvedValue({status: 200} as Response)
    useGallerySyncStore.getState().reset()
    useGlassesStore.getState().reset()
    useGlassesStore.getState().setGlassesInfo({bluetoothMacAddress: "CC:CC:CC:CC:CC:CC"})
    await gallerySyncService.cleanup()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await gallerySyncService.cleanup()
    Object.defineProperty(Platform, "OS", {value: originalPlatformOS, configurable: true, writable: true})
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("holds the glasses Wi-Fi link and downloads from its gateway once the iOS route answers", async () => {
    Object.defineProperty(Platform, "OS", {value: "ios", configurable: true, writable: true})
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    let probes = 0
    const fetch = jest.spyOn(localNetworkTransport, "fetch").mockImplementation(async () => {
      if (++probes < 3) throw new Error("route not ready")
      return {status: 200} as Response
    })
    const download = jest.spyOn(gallerySyncService as any, "startFileDownload").mockImplementation(async () => {
      expect(useGallerySyncStore.getState().hotspotInfo).toEqual(HOTSPOT_INFO)
    })
    const starting = gallerySyncService.startSync()
    await jest.advanceTimersByTimeAsync(5_000)
    await starting
    expect(mockHoldGlassesWifi).toHaveBeenCalledWith(
      expect.objectContaining({consumer: "gallery-sync", signal: expect.any(AbortSignal)}),
    )
    expect(fetch).toHaveBeenCalledWith(`http://${HOTSPOT_INFO.ip}:8089/api/health`, expect.anything())
    expect(download).toHaveBeenCalledWith(HOTSPOT_INFO, expect.any(AbortSignal))
    expect(wifiHold.release).not.toHaveBeenCalled()
  })

  it("releases the link when the glasses' server never answers on iOS", async () => {
    Object.defineProperty(Platform, "OS", {value: "ios", configurable: true, writable: true})
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    jest.spyOn(localNetworkTransport, "fetch").mockRejectedValue(new Error("route not ready"))
    const starting = gallerySyncService.startSync()
    await jest.advanceTimersByTimeAsync(30_000)
    await starting
    expect(wifiHold.release).toHaveBeenCalledTimes(1)
    expect(useGallerySyncStore.getState()).toMatchObject({syncState: "error", hotspotInfo: null})
    expect(useGallerySyncStore.getState().lastError).toContain(`could not reach ${HOTSPOT_INFO.ip}:8089`)
  })

  it("reports a glasses Wi-Fi link that cannot come up as the sync error", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    mockHoldGlassesWifi.mockRejectedValueOnce(new Error("Hotspot request timed out"))
    await gallerySyncService.startSync()
    expect(useGallerySyncStore.getState()).toMatchObject({syncState: "error", lastError: "Hotspot request timed out"})
  })

  it("explains the join once and asks for Local Network access while it waits, not after cancellation", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    type HoldOptions = {
      signal: AbortSignal
      beforeJoin(ssid: string): Promise<void>
      onPermissionRequired(systemAnswer: string): void
    }
    let options: HoldOptions | undefined
    let fail!: (error: Error) => void
    mockHoldGlassesWifi.mockImplementationOnce((given: HoldOptions) => {
      options = given
      return new Promise((_resolve, reject) => (fail = reject))
    })
    const notices: {code: string; ack?: () => void}[] = []
    const unsubscribe = onGalleryNotice((notice) => notices.push(notice))
    try {
      const starting = gallerySyncService.startSync()
      for (let i = 0; i < 40 && !options; i++) await Promise.resolve()
      const join = options!
      const explained = join.beforeJoin(HOTSPOT_INFO.ssid)
      expect(useGallerySyncStore.getState().syncState).toBe("connecting_wifi")
      expect(notices.map((notice) => notice.code)).toEqual(["connect_to_glasses"])
      notices[0].ack!()
      await explained
      await join.beforeJoin(HOTSPOT_INFO.ssid)
      join.onPermissionRequired("unsatisfiedReason=localNetworkDenied")
      expect(notices.map((notice) => notice.code)).toEqual(["connect_to_glasses", "local_network_permission_required"])

      await gallerySyncService.cancelSync()
      expect(join.signal.aborted).toBe(true)
      join.onPermissionRequired("unsatisfiedReason=localNetworkDenied")
      expect(notices).toHaveLength(2)
      fail(new Error("Glasses Wi-Fi hold cancelled"))
      await starting
      expect(useGallerySyncStore.getState().syncState).toBe("cancelled")
    } finally {
      unsubscribe()
    }
  })

  it("updates gallery status from glasses events", () => {
    gallerySyncService.initialize()
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})

    GlobalEventEmitter.emit("gallery_status", {
      photos: 2,
      videos: 1,
      total: 3,
      has_content: true,
      camera_busy: false,
    })

    expect(useGallerySyncStore.getState()).toEqual(
      expect.objectContaining({
        glassesGalleryStatusKnown: true,
        glassesPhotoCount: 2,
        glassesVideoCount: 1,
        glassesTotalCount: 3,
        glassesHasContent: true,
      }),
    )
  })

  it("invalidates idle gallery counts across reconnects and ignores late disconnected events", async () => {
    gallerySyncService.initialize()
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    GlobalEventEmitter.emit("gallery_status", {photos: 2, videos: 1, total: 3, has_content: true})

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    GlobalEventEmitter.emit("gallery_status", {photos: 2, videos: 1, total: 3, has_content: true})
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    expect(useGallerySyncStore.getState()).toMatchObject({
      syncState: "idle",
      glassesGalleryStatusKnown: false,
      glassesPhotoCount: 0,
      glassesVideoCount: 0,
    })

    GlobalEventEmitter.emit("gallery_status", {photos: 0, videos: 0, total: 0, has_content: false})
    expect(useGallerySyncStore.getState().glassesGalleryStatusKnown).toBe(true)
    await gallerySyncService.cleanup()
    expect(useGallerySyncStore.getState().glassesGalleryStatusKnown).toBe(false)
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

  it("releases the link after a Bluetooth disconnect while keeping the disconnect as the failure", async () => {
    gallerySyncService.initialize()
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    await startHeldSync()
    wifiHold.release.mockRejectedValueOnce(new Error("Release failed"))
    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(wifiHold.release).toHaveBeenCalledTimes(1)
    expect(useGallerySyncStore.getState().lastError).toBe("Glasses disconnected")
  })

  it.each(["requesting_hotspot", "connecting_wifi", "preparing", "syncing"] as const)(
    "allows a fresh sync after cleanup of %s",
    async (state) => {
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      await startHeldSync()
      useGallerySyncStore.getState().setSyncState(state)
      await gallerySyncService.cleanup()
      expect(useGallerySyncStore.getState().syncState).toBe("cancelled")
      expect(wifiHold.release).toHaveBeenCalledTimes(1)
      await startHeldSync()
      expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(2)
      expect(useGallerySyncStore.getState().syncState).toBe("connecting_wifi")
    },
  )

  it.each([false, true])(
    "keeps post-sync counts known unless glasses disconnect (disconnect=%s)",
    async (disconnect) => {
      gallerySyncService.initialize()
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      useGallerySyncStore.getState().setGlassesGalleryStatus(2, 1, 3, true)
      useGallerySyncStore.getState().setSyncComplete()
      if (disconnect) {
        ;(gallerySyncNotifications.showSyncComplete as jest.Mock).mockImplementationOnce(async () => {
          useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
        })
      }

      await (
        gallerySyncService as unknown as {onSyncComplete: (downloaded: number, failed: number) => Promise<void>}
      ).onSyncComplete(3, 0)

      expect(useGallerySyncStore.getState()).toMatchObject({
        glassesGalleryStatusKnown: !disconnect,
        glassesPhotoCount: 0,
        glassesVideoCount: 0,
        glassesTotalCount: 0,
        glassesHasContent: false,
      })
    },
  )

  it("waits for the link release during engine cleanup and preserves the sync failure", async () => {
    gallerySyncService.initialize()
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    await startHeldSync()
    useGallerySyncStore.getState().setSyncError("Original transfer failed")
    let finishRelease!: () => void
    wifiHold.release.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRelease = resolve)))
    let cleaned = false
    const cleanup = gallerySyncService.cleanup().then(() => {
      cleaned = true
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(wifiHold.release).toHaveBeenCalledTimes(1)
    expect(cleaned).toBe(false)
    finishRelease()
    await cleanup
    expect(useGallerySyncStore.getState()).toMatchObject({
      hotspotInfo: null,
      syncState: "error",
      lastError: "Original transfer failed",
    })
    expect(mediaProcessingQueue.abort).toHaveBeenCalled()
  })

  it("reports a failed link release from cleanup without erasing the sync failure", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    await startHeldSync()
    useGallerySyncStore.getState().setSyncError("Original transfer failed")
    const failure = new Error("Release failed")
    wifiHold.release.mockRejectedValueOnce(failure)
    await expect(gallerySyncService.cleanup()).rejects.toBe(failure)
    expect(useGallerySyncStore.getState().lastError).toBe("Original transfer failed")
  })

  it("releases the held link once when a transfer is cancelled", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    let releaseTransfer: (() => void) | undefined
    jest
      .spyOn(gallerySyncService as unknown as {startFileDownload(): Promise<void>}, "startFileDownload")
      .mockImplementationOnce(() => new Promise<void>((resolve) => (releaseTransfer = resolve)))
    const starting = gallerySyncService.startSync()
    for (let i = 0; i < 40 && !releaseTransfer; i++) await Promise.resolve()
    expect(releaseTransfer).toBeDefined()
    await gallerySyncService.cancelSync()
    expect(wifiHold.release).toHaveBeenCalledTimes(1)
    expect(useGallerySyncStore.getState().hotspotInfo).toBeNull()
    releaseTransfer!()
    await starting
    expect(wifiHold.release).toHaveBeenCalledTimes(1)
    expect(useGallerySyncStore.getState().syncState).toBe("cancelled")
  })

  it("attempts all cancellation cleanup before rejecting and admitting later work", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    await startHeldSync()
    const releaseFailure = new Error("Release failed"),
      queueFailure = new Error("Queue cleanup failed")
    wifiHold.release.mockRejectedValueOnce(releaseFailure)
    ;(localStorageService.clearSyncQueue as jest.Mock).mockRejectedValueOnce(queueFailure)
    let releaseNotification!: () => void
    ;(gallerySyncNotifications.showSyncCancelled as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseNotification = resolve
        }),
    )
    const cancellation = gallerySyncService.cancelSync().catch((error: unknown) => error)
    const freshStart = gallerySyncService.startSync().catch((error: unknown) => error)
    for (let i = 0; i < 20 && !releaseNotification; i++) await Promise.resolve()
    expect(localStorageService.clearSyncQueue).toHaveBeenCalled()
    expect(gallerySyncNotifications.showSyncCancelled).toHaveBeenCalled()
    expect(wifiHold.release).toHaveBeenCalledTimes(1)
    expect(useGallerySyncStore.getState().syncState).toBe("cancelled")
    releaseNotification()
    const [failure, startFailure] = await Promise.all([cancellation, freshStart])
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([releaseFailure, queueFailure])
    expect(startFailure).toBe(failure)
    expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(1)
  })

  it("keeps a new start behind the original link release and joins repeated cleanup", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    await startHeldSync()
    let finishRelease: (() => void) | undefined
    wifiHold.release.mockImplementationOnce(() => new Promise<void>((resolve) => (finishRelease = resolve)))
    const cleanup = gallerySyncService.cleanup()
    const joinedCleanup = gallerySyncService.cleanup()
    const freshStart = startHeldSync()
    for (let i = 0; i < 20 && !finishRelease; i++) await Promise.resolve()
    expect(joinedCleanup).toBe(cleanup)
    expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(1)
    expect(gallerySyncService.isSyncStarting()).toBe(false)
    finishRelease!()
    await Promise.all([cleanup, joinedCleanup, freshStart])
    expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(2)
  })

  it("rejects a waiting new start if the original link release fails", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    await startHeldSync()
    let rejectRelease: ((error: Error) => void) | undefined
    wifiHold.release.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (rejectRelease = reject)))
    const cleanup = gallerySyncService.cleanup().catch((error: unknown) => error)
    const freshStart = gallerySyncService.startSync().catch((error: unknown) => error)
    for (let i = 0; i < 20 && !rejectRelease; i++) await Promise.resolve()
    rejectRelease!(new Error("Release failed"))
    const [cleanupFailure, startFailure] = await Promise.all([cleanup, freshStart])
    expect(cleanupFailure).toMatchObject({message: "Release failed"})
    expect(startFailure).toBe(cleanupFailure)
    expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(1)
  })

  it("aborts an admitted pre-flight without making cleanup wait for its permission prompt", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    let releasePreFlight!: () => void
    ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releasePreFlight = resolve
        }),
    )
    const starting = gallerySyncService.startSync()
    for (let i = 0; i < 20 && !releasePreFlight; i++) await Promise.resolve()
    expect(gallerySyncNotifications.requestPermissions).toHaveBeenCalledTimes(1)
    await gallerySyncService.cleanup()
    releasePreFlight()
    await starting
    expect(mockHoldGlassesWifi).not.toHaveBeenCalled()
    expect(useGallerySyncStore.getState().syncStarting).toBe(false)
  })

  it("allows a fresh start after cleanup while the old permission prompt remains unresolved", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    let releaseOld!: () => void
    ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseOld = resolve
        }),
    )
    const oldStart = gallerySyncService.startSync()
    for (let i = 0; i < 20 && !releaseOld; i++) await Promise.resolve()
    await gallerySyncService.cleanup()
    let releaseFresh!: () => void
    ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFresh = resolve
        }),
    )
    const freshStart = startHeldSync()
    for (let i = 0; i < 20 && !releaseFresh; i++) await Promise.resolve()
    releaseOld()
    await oldStart
    expect(gallerySyncService.isSyncStarting()).toBe(true)
    const joined = gallerySyncService.startSync()
    expect(gallerySyncNotifications.requestPermissions).toHaveBeenCalledTimes(2)
    releaseFresh()
    await Promise.all([freshStart, joined])
    expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(1)
    expect(useGallerySyncStore.getState().syncState).toBe("connecting_wifi")
  })

  it.each([false, true])("ignores an old Wi-Fi hold rejection after cleanup (fresh start=%s)", async (fresh) => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    let rejectOld: ((error: Error) => void) | undefined
    mockHoldGlassesWifi.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectOld = reject)))
    const oldStart = gallerySyncService.startSync()
    for (let i = 0; i < 40 && !rejectOld; i++) await Promise.resolve()
    expect(rejectOld).toBeDefined()
    await gallerySyncService.cleanup()
    let releaseFresh!: () => void
    let freshStart: Promise<void> | undefined
    if (fresh) {
      ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFresh = resolve
          }),
      )
      freshStart = gallerySyncService.startSync()
      for (let i = 0; i < 20 && !releaseFresh; i++) await Promise.resolve()
    }
    const saved = useGallerySyncStore.getState()
    rejectOld!(new Error("Hotspot join timed out"))
    await oldStart
    expect(useGallerySyncStore.getState()).toBe(saved)
    expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(1)
    if (freshStart) {
      await gallerySyncService.cleanup()
      releaseFresh()
      await freshStart
    }
  })

  it.each(["location", "local_wifi", "storage"])(
    "ignores a delayed %s pre-flight denial after cleanup",
    async (gate) => {
      Object.defineProperty(Platform, "OS", {value: "android", configurable: true, writable: true})
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      let release!: () => void
      if (gate === "storage") {
        ;(RNFS.getFSInfo as jest.Mock).mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => resolve({freeSpace: 0})
            }),
        )
      } else {
        ;(permissions.check as jest.Mock).mockImplementation(async (feature: string) => {
          if (feature === gate)
            return new Promise((resolve) => {
              release = () => resolve(false)
            })
          return true
        })
      }
      const starting = gallerySyncService.startSync()
      for (let i = 0; i < 40 && !release; i++) await Promise.resolve()
      expect(release).toBeDefined()
      await gallerySyncService.cleanup()
      const saved = useGallerySyncStore.getState()
      const requests = (permissions.request as jest.Mock).mock.calls.length
      release()
      await starting
      expect(useGallerySyncStore.getState()).toBe(saved)
      expect(permissions.request).toHaveBeenCalledTimes(requests)
      expect(mockHoldGlassesWifi).not.toHaveBeenCalled()
      ;(permissions.check as jest.Mock).mockResolvedValue(true)
    },
  )

  it("admits a fresh sync after cancelling an unresolved permission prompt", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    let releaseOld!: () => void, releaseFresh!: () => void
    ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseOld = resolve
        }),
    )
    const oldStart = gallerySyncService.startSync()
    for (let i = 0; i < 20 && !releaseOld; i++) await Promise.resolve()
    await gallerySyncService.cancelSync()
    expect(gallerySyncService.isSyncStarting()).toBe(false)
    ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFresh = resolve
        }),
    )
    const fresh = startHeldSync()
    for (let i = 0; i < 20 && !releaseFresh; i++) await Promise.resolve()
    expect(gallerySyncNotifications.requestPermissions).toHaveBeenCalledTimes(2)
    releaseOld()
    await oldStart
    expect(gallerySyncService.isSyncStarting()).toBe(true)
    releaseFresh()
    await fresh
    expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(1)
  })

  it("does not resume preparation work after cleanup", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    let resume: (() => void) | undefined
    ;(mediaProcessingQueue.retryPending as jest.Mock).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (resume = resolve))
      return {retried: 0, failed: 0}
    })
    const starting = gallerySyncService.startSync()
    for (let i = 0; i < 100 && !resume; i++) await Promise.resolve()
    expect(resume).toBeDefined()
    await gallerySyncService.cleanup()
    const state = useGallerySyncStore.getState()
    resume!()
    await starting
    expect(mockSyncWithServer).not.toHaveBeenCalled()
    expect(asgCameraApi.downloadCapture).not.toHaveBeenCalled()
    expect(useGallerySyncStore.getState()).toBe(state)
    expect(wifiHold.release).toHaveBeenCalledTimes(1)
  })

  it("ignores a late capture completion after cleanup", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    await startHeldSync()
    const service = gallerySyncService as unknown as {
      abortController: AbortController
      executeCaptureDownload(captures: CaptureGroup[], serverTime: number, signal: AbortSignal): Promise<void>
    }
    const signal = service.abortController.signal
    useGallerySyncStore.getState().setSyncError("Original transfer failed")
    let complete!: () => void
    ;(asgCameraApi.downloadCapture as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({primaryPath: "/late/video.mp4"})
        }),
    )
    const pending = service.executeCaptureDownload([FAKE_CAPTURE], 2000, signal)
    for (let i = 0; i < 20 && !complete; i++) await Promise.resolve()
    expect(asgCameraApi.downloadCapture).toHaveBeenCalledTimes(1)
    await gallerySyncService.cleanup()
    const state = useGallerySyncStore.getState()
    complete()
    await pending
    expect(mediaProcessingQueue.enqueue).not.toHaveBeenCalled()
    expect(localStorageService.updateSyncState).not.toHaveBeenCalled()
    expect(useGallerySyncStore.getState()).toBe(state)
  })

  it("releases the link even when reporting a failed transfer also rejects", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    await startHeldSync()
    ;(mediaProcessingQueue.retryPending as jest.Mock).mockRejectedValueOnce(new Error("Recovery failed"))
    const notificationFailure = new Error("Notification failed")
    ;(gallerySyncNotifications.showSyncError as jest.Mock).mockRejectedValueOnce(notificationFailure)
    await expect(startFileDownload()).rejects.toBe(notificationFailure)
    expect(wifiHold.release).toHaveBeenCalledTimes(1)
    expect(useGallerySyncStore.getState()).toMatchObject({hotspotInfo: null, lastError: "Recovery failed"})
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
    expect(mockHoldGlassesWifi).not.toHaveBeenCalled()
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
    expect(mockHoldGlassesWifi).not.toHaveBeenCalled()
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

    expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(1)
  })

  it.each(["cleanup", "cancel", "fresh start"])(
    "does not resume an old foreground WiFi check after %s",
    async (terminal) => {
      Object.defineProperty(Platform, "OS", {value: "android", configurable: true, writable: true})
      ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockResolvedValue(undefined)
      mockIsWifiEnabled.mockResolvedValue(false)
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      let acknowledge!: () => void
      const unsubscribe = onGalleryNotice((notice) => {
        if (notice.code === "wifi_off") acknowledge = notice.ack!
      })
      try {
        await gallerySyncService.startSync()
      } finally {
        unsubscribe()
      }
      expect(acknowledge).toBeDefined()
      acknowledge()
      let releaseCheck!: () => void
      mockIsWifiEnabled.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseCheck = () => resolve(true)
          }),
      )
      const foreground = (
        gallerySyncService as unknown as {
          handleAppStateChange(state: string): Promise<void>
        }
      ).handleAppStateChange("active")
      await jest.advanceTimersByTimeAsync(1000)
      expect(releaseCheck).toBeDefined()
      if (terminal === "cancel") await gallerySyncService.cancelSync()
      else await gallerySyncService.cleanup()
      if (terminal === "fresh start") {
        mockIsWifiEnabled.mockResolvedValue(true)
        await gallerySyncService.startSync()
      }
      const saved = useGallerySyncStore.getState()
      const calls = mockHoldGlassesWifi.mock.calls.length
      releaseCheck()
      await foreground
      expect(useGallerySyncStore.getState()).toBe(saved)
      expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(calls)
    },
  )

  it("does not resume a saved queue whose lookup settles after cleanup", async () => {
    let releaseQueue!: () => void
    ;(localStorageService.getSyncQueue as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseQueue = () => resolve({files: [{}], currentIndex: 0, startedAt: Date.now()})
        }),
    )
    const resume = gallerySyncService.resumeSync()
    await gallerySyncService.cleanup()
    releaseQueue()
    await resume
    expect(mockHoldGlassesWifi).not.toHaveBeenCalled()
    expect(localStorageService.clearSyncQueue).not.toHaveBeenCalled()
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

  describe("interrupted transfers", () => {
    const VIDEO = {name: "VID_1.mp4", size: 150_000_000, modified: 1, is_video: true} as any
    const originalAppState = AppState.currentState
    const setAppState = (state: string) =>
      Object.defineProperty(AppState, "currentState", {value: state, configurable: true, writable: true})

    const flush = async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve()
    }

    // Every attempt, the first and each resume, holds the link and stops before its download.
    const startTransfer = async () => {
      gallerySyncService.initialize()
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      jest
        .spyOn(gallerySyncService as unknown as {startFileDownload(): Promise<void>}, "startFileDownload")
        .mockResolvedValue(undefined)
      await gallerySyncService.startSync()
      useGallerySyncStore.getState().setSyncing([VIDEO])
      mockHoldGlassesWifi.mockClear()
    }

    beforeEach(() => setAppState("active"))
    afterEach(() => setAppState(originalAppState))

    it("ends a download when the glasses Wi-Fi link goes down, then resumes it", async () => {
      await startTransfer()

      wifiHold.lose()
      expect(useGallerySyncStore.getState()).toMatchObject({syncState: "error", lastError: SYNC_INTERRUPTED_MESSAGE})
      await flush()

      // The dead attempt's link is released, then a fresh attempt holds it again.
      expect(wifiHold.release).toHaveBeenCalledTimes(1)
      expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(1)
      expect(useGallerySyncStore.getState().syncState).toBe("connecting_wifi")
    })

    it.each(["idle", "complete", "error"] as const)("ignores the link going down while %s", async (state) => {
      await startTransfer()
      useGallerySyncStore.getState().setSyncState(state)

      wifiHold.lose()

      expect(useGallerySyncStore.getState().lastError).not.toBe(SYNC_INTERRUPTED_MESSAGE)
      expect(wifiHold.release).not.toHaveBeenCalled()
    })

    it("waits for the foreground to resume a transfer interrupted in the background", async () => {
      await startTransfer()
      setAppState("background")

      wifiHold.lose()
      await flush()
      expect(useGallerySyncStore.getState().syncState).toBe("error")
      expect(mockHoldGlassesWifi).not.toHaveBeenCalled()

      setAppState("active")
      await (gallerySyncService as any).handleAppStateChange("active")
      await flush()
      expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(1)
      expect(useGallerySyncStore.getState().syncState).toBe("connecting_wifi")
    })

    it("notices on return to the app that the hotspot went away while suspended", async () => {
      await startTransfer()
      useGlassesStore.getState().setGlassesInfo({hotspotEnabled: false} as any)

      await (gallerySyncService as any).handleAppStateChange("active")

      expect(useGallerySyncStore.getState().lastError).toBe(SYNC_INTERRUPTED_MESSAGE)
      expect(wifiHold.release).toHaveBeenCalledTimes(1)
    })

    it("ends a download that makes no progress for three minutes", async () => {
      await startTransfer()

      await jest.advanceTimersByTimeAsync(170_000)
      expect(useGallerySyncStore.getState().syncState).toBe("syncing")

      await jest.advanceTimersByTimeAsync(20_000)
      expect(wifiHold.release).toHaveBeenCalledTimes(1)
    })

    it("keeps a slow download that is still making progress", async () => {
      await startTransfer()

      for (let percent = 1; percent <= 6; percent++) {
        await jest.advanceTimersByTimeAsync(60_000)
        useGallerySyncStore.getState().setCurrentFile(VIDEO.name, percent)
      }

      expect(useGallerySyncStore.getState().syncState).toBe("syncing")
      expect(wifiHold.release).not.toHaveBeenCalled()
    })

    it("leaves the sync alone while it waits for local processing to finish", async () => {
      await startTransfer()
      jest.spyOn(mediaProcessingQueue, "waitUntilDrained").mockReturnValue(new Promise<void>(() => {}))
      void (gallerySyncService as any).drainProcessingQueue()

      // A long stabilization or export: no network traffic, so the glasses stop their hotspot.
      await jest.advanceTimersByTimeAsync(200_000)
      wifiHold.lose()
      await flush()

      expect(useGallerySyncStore.getState().syncState).toBe("syncing")
      expect(wifiHold.release).not.toHaveBeenCalled()
    })

    it("does not resume after the engine is torn down mid-interruption", async () => {
      await startTransfer()
      const beginSync = jest.spyOn(gallerySyncService as any, "beginSync")

      wifiHold.lose()
      await gallerySyncService.cleanup()
      await flush()

      expect(beginSync).not.toHaveBeenCalled()
    })

    it("stops resuming on its own after three interruptions in a row", async () => {
      await startTransfer()

      for (let attempt = 1; attempt <= 4; attempt++) {
        useGallerySyncStore.getState().setSyncing([VIDEO])
        mockHoldGlassesWifi.mockClear()
        wifiHold.lose()
        await flush()
        if (attempt <= 3) {
          expect(useGallerySyncStore.getState().syncState).toBe("connecting_wifi")
        }
      }

      expect(useGallerySyncStore.getState()).toMatchObject({syncState: "error", lastError: SYNC_INTERRUPTED_MESSAGE})
      expect(mockHoldGlassesWifi).not.toHaveBeenCalled()
      expect(gallerySyncNotifications.showSyncError).toHaveBeenCalledWith(SYNC_INTERRUPTED_MESSAGE)
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

    it("shows preparation while the gallery inventory is loading", async () => {
      const retainedPhoto = {
        name: "retained.jpg",
        url: "file:///retained.jpg",
        download: "file:///retained.jpg",
        filePath: "/retained.jpg",
        size: 100,
        modified: 1,
      }
      useGallerySyncStore.getState().setSyncing([retainedPhoto])
      useGallerySyncStore.getState().setConnectingWifi()
      mockGetV3Manifest.mockImplementationOnce(async () => {
        const state = useGallerySyncStore.getState()
        expect(state.syncState).toBe("preparing")
        expect(state.totalFiles).toBe(1)
        expect(state.queue).toEqual([retainedPhoto])
        expect(gallerySyncService.isSyncing()).toBe(true)
        return null
      })
      mockSyncWithServer.mockResolvedValueOnce(CAPTURE_SYNC_RESPONSE)

      await startFileDownload()

      expect(executeCaptureDownloadSpy).toHaveBeenCalledWith([FAKE_CAPTURE], 2000, undefined)
    })

    it.each(["request failure", "unresolved inventory"])(
      "retains the display queue and recovery progress after %s",
      async (failure) => {
        const store = useGallerySyncStore.getState()
        store.setSyncing([
          {name: "saved.jpg", url: "file:///saved.jpg", download: "", filePath: "/saved.jpg", size: 100, modified: 1},
          {name: "failed.jpg", url: "", download: "", size: 100, modified: 2},
        ])
        store.onFileComplete("saved.jpg")
        store.onFileFailed("failed.jpg")
        store.onFileProcessing("saved.jpg")
        store.setSyncError("Previous transfer interrupted")
        const previous = useGallerySyncStore.getState()
        mockGetSyncState.mockResolvedValue({last_sync_time: 0, client_id: "test", total_downloaded: 1, total_size: 100})
        if (failure === "request failure") {
          mockGetV3Manifest.mockRejectedValueOnce(new Error("Inventory unavailable"))
        }

        await startFileDownload()

        const state = useGallerySyncStore.getState()
        expect(state.syncState).toBe("error")
        expect(state.queue).toBe(previous.queue)
        expect(state.failedFiles).toEqual(previous.failedFiles)
        expect(state.processingFiles).toEqual(previous.processingFiles)
        expect(state.completedFiles).toBe(previous.completedFiles)
        expect(state.totalFiles).toBe(previous.totalFiles)
        expect(state.queueIndex).toBe(previous.queueIndex)
        expect(executeCaptureDownloadSpy).not.toHaveBeenCalled()
      },
    )

    it("does not start a second sync during preparation", async () => {
      useGallerySyncStore.getState().setSyncState("preparing")

      await gallerySyncService.startSync()

      expect(useGallerySyncStore.getState().syncState).toBe("preparing")
      expect(mockHoldGlassesWifi).not.toHaveBeenCalled()
      expect(mockGetV3Manifest).not.toHaveBeenCalled()
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
      expect(executeCaptureDownloadSpy).toHaveBeenCalledWith([FAKE_CAPTURE], 2000, undefined)
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
      expect(executeCaptureDownloadSpy).toHaveBeenCalledWith([FAKE_CAPTURE], 2000, undefined)
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

  it.each(["cleanup", "cancel"])(
    "does not publish an old final queue-save continuation after %s and fresh start",
    async (terminal) => {
      ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockResolvedValue(undefined)
      ;(gallerySettingsService.getAutoSaveToCameraRoll as jest.Mock).mockResolvedValue(false)
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      await startHeldSync()
      const signal = (gallerySyncService as unknown as {abortController: AbortController}).abortController.signal
      const oldFile = {name: "old.jpg", size: 10, modified: 1}
      ;(asgCameraApi.batchSyncFiles as jest.Mock).mockResolvedValueOnce({
        downloaded: [],
        failed: [oldFile.name],
        total_size: 0,
      })
      let releaseSave!: () => void
      ;(localStorageService.updateSyncQueueIndex as jest.Mock).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseSave = resolve
          }),
      )
      const old = (
        gallerySyncService as unknown as {
          executeDownload(files: unknown[], time: number, signal: AbortSignal): Promise<void>
        }
      ).executeDownload([oldFile], 2000, signal)
      for (let i = 0; i < 20 && !releaseSave; i++) await Promise.resolve()
      expect(releaseSave).toBeDefined()
      if (terminal === "cleanup") await gallerySyncService.cleanup()
      else await gallerySyncService.cancelSync()
      await startHeldSync()
      const saved = useGallerySyncStore.getState()
      const drained = (mediaProcessingQueue.waitUntilDrained as jest.Mock).mock.calls.length
      releaseSave()
      await old
      expect(useGallerySyncStore.getState()).toBe(saved)
      expect(mediaProcessingQueue.waitUntilDrained).toHaveBeenCalledTimes(drained)
      expect(saved.failedFiles).not.toContain(oldFile.name)
    },
  )

  it("finishes a successful sync once and admits a follow-up after idempotent cleanup", async () => {
    ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockResolvedValue(undefined)
    ;(gallerySettingsService.getAutoSaveToCameraRoll as jest.Mock).mockResolvedValue(false)
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    await startHeldSync()
    const service = gallerySyncService as unknown as {
      resolveSyncManifest(client: string, time: number): Promise<unknown>
      closeHotspot(): Promise<Error | null>
    }
    jest
      .spyOn(service, "resolveSyncManifest")
      .mockResolvedValueOnce({syncData: EMPTY_SYNC_RESPONSE, usedFullSync: false})
    await startFileDownload()
    expect(wifiHold.release).toHaveBeenCalledTimes(1)
    expect(useGallerySyncStore.getState().hotspotInfo).toBeNull()
    const repeated = service.closeHotspot()
    const followup = startHeldSync()
    await expect(repeated).resolves.toBeNull()
    expect(wifiHold.release).toHaveBeenCalledTimes(1)
    await followup
    expect(mockHoldGlassesWifi).toHaveBeenCalledTimes(2)
  })

  it.each(["manifest", "legacy", "capture"])(
    "does not let an old %s error notification release a fresh session's link",
    async (stage) => {
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockResolvedValue(undefined)
      ;(gallerySettingsService.getAutoSaveToCameraRoll as jest.Mock).mockResolvedValue(false)
      await startHeldSync()
      const signal = (gallerySyncService as unknown as {abortController: AbortController}).abortController.signal
      const service = gallerySyncService as unknown as {
        resolveSyncManifest(client: string, time: number, signal: AbortSignal): Promise<null>
        executeDownload(files: unknown[], time: number, signal: AbortSignal): Promise<void>
        executeCaptureDownload(captures: CaptureGroup[], time: number, signal: AbortSignal): Promise<void>
      }
      let releaseError!: () => void
      ;(gallerySyncNotifications.showSyncError as jest.Mock).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseError = resolve
          }),
      )
      let failed: Promise<void>
      if (stage === "manifest") {
        jest.spyOn(service, "resolveSyncManifest").mockResolvedValueOnce(null)
        failed = startFileDownload()
      } else {
        if (stage === "legacy") {
          ;(asgCameraApi.batchSyncFiles as jest.Mock).mockRejectedValueOnce(new Error("Original failure"))
        } else {
          ;(localStorageService.updateSyncQueueIndex as jest.Mock).mockRejectedValueOnce(new Error("Original failure"))
        }
        failed =
          stage === "legacy"
            ? service.executeDownload([], 2000, signal)
            : service.executeCaptureDownload([], 2000, signal)
      }
      for (let i = 0; i < 30 && !releaseError; i++) await Promise.resolve()
      expect(releaseError).toBeDefined()
      await gallerySyncService.cleanup()
      await startHeldSync()
      const state = useGallerySyncStore.getState()
      const releases = wifiHold.release.mock.calls.length
      releaseError()
      await failed
      expect(wifiHold.release).toHaveBeenCalledTimes(releases)
      expect(useGallerySyncStore.getState()).toBe(state)
      expect(state.hotspotInfo).toEqual(HOTSPOT_INFO)
    },
  )

  it.each(["manifest", "legacy", "capture"])(
    "does not let an old %s error notification release an ordinary retry's link",
    async (stage) => {
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      ;(gallerySyncNotifications.requestPermissions as jest.Mock).mockResolvedValue(undefined)
      ;(gallerySettingsService.getAutoSaveToCameraRoll as jest.Mock).mockResolvedValue(false)
      await startHeldSync()
      const signal = (gallerySyncService as unknown as {abortController: AbortController}).abortController.signal
      const service = gallerySyncService as unknown as {
        resolveSyncManifest(client: string, time: number, signal: AbortSignal): Promise<null>
        executeDownload(files: unknown[], time: number, signal: AbortSignal): Promise<void>
        executeCaptureDownload(captures: CaptureGroup[], time: number, signal: AbortSignal): Promise<void>
      }
      let releaseError!: () => void
      ;(gallerySyncNotifications.showSyncError as jest.Mock).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseError = resolve
          }),
      )
      let failed: Promise<void>
      if (stage === "manifest") {
        jest.spyOn(service, "resolveSyncManifest").mockResolvedValueOnce(null)
        failed = startFileDownload()
      } else {
        if (stage === "legacy") {
          ;(asgCameraApi.batchSyncFiles as jest.Mock).mockRejectedValueOnce(new Error("Original failure"))
        } else {
          ;(localStorageService.updateSyncQueueIndex as jest.Mock).mockRejectedValueOnce(new Error("Original failure"))
        }
        failed =
          stage === "legacy"
            ? service.executeDownload([], 2000, signal)
            : service.executeCaptureDownload([], 2000, signal)
      }
      for (let i = 0; i < 30 && !releaseError; i++) await Promise.resolve()
      expect(releaseError).toBeDefined()
      await startHeldSync()
      const state = useGallerySyncStore.getState()
      const releases = wifiHold.release.mock.calls.length
      releaseError()
      await failed
      expect(wifiHold.release).toHaveBeenCalledTimes(releases)
      expect(useGallerySyncStore.getState()).toBe(state)
      expect(state.hotspotInfo).toEqual(HOTSPOT_INFO)
    },
  )

  it.each([false, true])("supports React Native manifest cancellation (aborted=%s)", async (aborted) => {
    const controller = new ReactNativeAbortController()
    expect("throwIfAborted" in controller.signal).toBe(false)
    if (aborted) controller.abort()
    const service = gallerySyncService as unknown as {
      fetchSyncManifest(clientId: string, lastSyncTime: number, signal: AbortSignal): Promise<unknown>
    }
    const pending = service.fetchSyncManifest("c1", 0, controller.signal as AbortSignal)
    if (aborted) {
      await expect(pending).rejects.toMatchObject({name: "AbortError"})
      expect(mockGetV3Manifest).not.toHaveBeenCalled()
    } else {
      await expect(pending).resolves.toMatchObject({changed_files: []})
      expect(mockGetV3Manifest).toHaveBeenCalledTimes(1)
    }
  })

  it("stops React Native manifest continuation when its request settles after abort", async () => {
    const controller = new ReactNativeAbortController()
    let release!: () => void
    mockGetV3Manifest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null)
        }),
    )
    const service = gallerySyncService as unknown as {
      fetchSyncManifest(clientId: string, lastSyncTime: number, signal: AbortSignal): Promise<unknown>
    }
    const pending = service.fetchSyncManifest("c1", 0, controller.signal as AbortSignal)
    controller.abort()
    release()
    await expect(pending).rejects.toMatchObject({name: "AbortError"})
    expect(mockSyncWithServer).not.toHaveBeenCalled()
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
