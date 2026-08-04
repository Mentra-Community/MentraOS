/* eslint-disable no-restricted-imports */
import * as RNFS from "@dr.pogodin/react-native-fs"

import {localStorageService} from "../../../modules/engine/src/services/asg/localStorageService"
import {reportInvalidGalleryMedia} from "../../../modules/engine/src/services/asg/GalleryMediaIntegrityReportService"
import {useGallerySyncStore} from "../../../modules/engine/src/stores/gallerySync"
import {asgCameraApi} from "../../../modules/engine/src/services/asg/asgCameraApi"
// The durable ledger is engine-internal; this host test exercises restart recovery directly.
import {galleryTransferLedger} from "../../../modules/engine/src/services/asg/galleryTransferLedger"
import {cameraRollExportCoordinator} from "../../../modules/engine/src/services/asg/cameraRollExportCoordinator"

import {mediaProcessingQueue} from "../../../modules/engine/src/services/asg/mediaProcessingQueue"

jest.mock("@dr.pogodin/react-native-fs", () => ({
  DocumentDirectoryPath: "/tmp",
  exists: jest.fn(),
  stat: jest.fn(),
  read: jest.fn(),
  writeFile: jest.fn(),
  unlink: jest.fn(() => Promise.resolve()),
}))

jest.mock("@mentra/crust", () => ({
  __esModule: true,
  default: {},
}))

jest.mock("../../../modules/engine/src/services/asg/asgCameraApi", () => ({
  asgCameraApi: {
    deleteFilesFromServer: jest.fn((files: string[]) => Promise.resolve({deleted: files, failed: []})),
    acknowledgeCapture: jest.fn(() => Promise.resolve()),
    restoreCapture: jest.fn(() => Promise.resolve()),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/localStorageService", () => ({
  localStorageService: {
    convertToDownloadedFile: jest.fn((info: any) => info),
    saveDownloadedFile: jest.fn(),
    getDownloadedFile: jest.fn(),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/cameraRollExportCoordinator", () => ({
  cameraRollExportCoordinator: {
    recordIndexed: jest.fn(() => Promise.resolve()),
    isAutoSaveEnabled: jest.fn(() => Promise.resolve(false)),
    exportForSource: jest.fn(() => Promise.resolve({platform: "ios", identifier: "asset", exportedAt: Date.now()})),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/GalleryMediaIntegrityReportService", () => ({
  reportInvalidGalleryMedia: jest.fn(),
}))

jest.mock("../../../modules/engine/src/utils/permissions/MediaLibraryPermissions", () => ({
  MediaLibraryPermissions: {
    saveToLibrary: jest.fn(),
    saveToLibraryWithReceipt: jest.fn(() => Promise.resolve({success: true, platform: "ios", identifier: "asset"})),
  },
}))

describe("mediaProcessingQueue", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useGallerySyncStore.getState().reset()
  })

  it("does not save metadata when local file is zero bytes", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 0})

    mediaProcessingQueue.reset()
    mediaProcessingQueue.enqueue({
      id: "VID_zero",
      type: "video",
      primaryPath: "/tmp/VID_zero/base.mp4",
      totalSize: 0,
      shouldProcess: false,
      shouldAutoSave: false,
      deleteFromGlasses: ["VID_zero"],
    })

    await expect(mediaProcessingQueue.waitUntilDrained(5000)).resolves.toBeUndefined()

    expect(localStorageService.saveDownloadedFile).not.toHaveBeenCalled()
    expect(reportInvalidGalleryMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "VID_zero",
        mediaKind: "video",
        stage: "processing_validation",
        reason: expect.stringContaining("zero-byte file VID_zero"),
      }),
    )
    expect(useGallerySyncStore.getState().failedFiles).toContain("VID_zero")
  })

  it("does not compare processed output size against capture total size", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 100})
    ;(RNFS.read as jest.Mock).mockResolvedValue(
      Buffer.from([0xff, 0xd8, 0x76, 0x61, 0x6c, 0x69, 0x64]).toString("base64"),
    )

    mediaProcessingQueue.reset()
    mediaProcessingQueue.enqueue({
      id: "IMG_with_sidecar",
      type: "photo",
      primaryPath: "/tmp/IMG_with_sidecar/base.jpg",
      totalSize: 200,
      timestamp: 1234,
      shouldProcess: false,
      shouldAutoSave: false,
    })

    await expect(mediaProcessingQueue.waitUntilDrained(5000)).resolves.toBeUndefined()

    expect(localStorageService.saveDownloadedFile).toHaveBeenCalledWith(
      expect.objectContaining({size: 100, modified: 1234}),
    )
    expect(cameraRollExportCoordinator.recordIndexed).toHaveBeenCalledWith(
      expect.objectContaining({size: 100, modified: 1234}),
      false,
      "HISTORICAL_BACKFILL",
      "IMG_with_sidecar",
    )
    expect(useGallerySyncStore.getState().failedFiles).not.toContain("IMG_with_sidecar")
  })

  it("never acknowledges the glasses when camera-roll export fails", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 100})
    ;(RNFS.read as jest.Mock).mockResolvedValue(
      Buffer.from([0xff, 0xd8, 0x76, 0x61, 0x6c, 0x69, 0x64]).toString("base64"),
    )
    ;(cameraRollExportCoordinator.exportForSource as jest.Mock).mockRejectedValueOnce(new Error("PhotoKit unavailable"))
    ;(cameraRollExportCoordinator.isAutoSaveEnabled as jest.Mock).mockResolvedValueOnce(true)

    mediaProcessingQueue.reset()
    mediaProcessingQueue.enqueue({
      id: "IMG_export_failure",
      type: "photo",
      primaryPath: "/tmp/IMG_export_failure/base.jpg",
      totalSize: 100,
      shouldProcess: false,
      shouldAutoSave: true,
      deleteFromGlasses: ["IMG_export_failure"],
      protocolVersion: 3,
    })

    await expect(mediaProcessingQueue.waitUntilDrained(5000)).resolves.toBeUndefined()

    expect(asgCameraApi.acknowledgeCapture).not.toHaveBeenCalled()
    expect(asgCameraApi.deleteFilesFromServer).not.toHaveBeenCalled()
    expect(useGallerySyncStore.getState().failedFiles).toContain("IMG_export_failure")
    expect(galleryTransferLedger.get("IMG_export_failure")).toMatchObject({
      state: "EXPORT_PENDING",
      retryCount: 1,
      lastError: "PhotoKit unavailable",
    })
  })

  it("acknowledges an app-local capture when automatic camera-roll saving was turned off", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 100})
    ;(RNFS.read as jest.Mock).mockResolvedValue(
      Buffer.from([0xff, 0xd8, 0x76, 0x61, 0x6c, 0x69, 0x64]).toString("base64"),
    )

    mediaProcessingQueue.reset()
    mediaProcessingQueue.enqueue({
      id: "IMG_disabled_during_sync",
      type: "photo",
      primaryPath: "/tmp/IMG_disabled_during_sync/base.jpg",
      totalSize: 100,
      shouldProcess: false,
      shouldAutoSave: true,
      deleteFromGlasses: ["IMG_disabled_during_sync"],
      protocolVersion: 3,
    })

    await expect(mediaProcessingQueue.waitUntilDrained(5000)).resolves.toBeUndefined()

    expect(cameraRollExportCoordinator.exportForSource).not.toHaveBeenCalled()
    expect(cameraRollExportCoordinator.recordIndexed).toHaveBeenCalledWith(
      expect.objectContaining({capture_id: "IMG_disabled_during_sync"}),
      false,
      "HISTORICAL_BACKFILL",
      "IMG_disabled_during_sync",
    )
    expect(asgCameraApi.acknowledgeCapture).toHaveBeenCalled()
    expect(galleryTransferLedger.get("IMG_disabled_during_sync")).toMatchObject({
      state: "TRASHED",
      shouldAutoSave: false,
    })
  })

  it("retains both copies and reports failure when the local index cannot be saved", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 100})
    ;(RNFS.read as jest.Mock).mockResolvedValue(
      Buffer.from([0xff, 0xd8, 0x76, 0x61, 0x6c, 0x69, 0x64]).toString("base64"),
    )
    ;(localStorageService.saveDownloadedFile as jest.Mock).mockRejectedValueOnce(new Error("MMKV write failed"))

    mediaProcessingQueue.reset()
    mediaProcessingQueue.enqueue({
      id: "IMG_metadata_failure",
      type: "photo",
      primaryPath: "/tmp/IMG_metadata_failure/base.jpg",
      totalSize: 100,
      shouldProcess: false,
      shouldAutoSave: false,
      deleteFromGlasses: ["IMG_metadata_failure"],
      protocolVersion: 3,
    })

    await expect(mediaProcessingQueue.waitUntilDrained(5000)).resolves.toBeUndefined()

    expect(asgCameraApi.acknowledgeCapture).not.toHaveBeenCalled()
    expect(asgCameraApi.deleteFilesFromServer).not.toHaveBeenCalled()
    expect(useGallerySyncStore.getState().failedFiles).toContain("IMG_metadata_failure")
  })

  it("retries acknowledgement from an export receipt without inserting another asset", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 100})
    const capture = {
      capture_id: "IMG_exported_before_restart",
      type: "photo" as const,
      timestamp: 1000,
      total_size: 100,
      files: [{name: "IMG_exported_before_restart/base.jpg", size: 100, role: "primary" as const}],
    }
    galleryTransferLedger.ensureCapture(capture, 3)
    const entry = galleryTransferLedger.transition(capture.capture_id, "EXPORTED", {
      finalPath: "/tmp/IMG_exported_before_restart/base.jpg",
      shouldAutoSave: true,
      assetReceipt: {platform: "ios", identifier: "asset-existing", exportedAt: Date.now()},
    })
    const recoverySpy = jest.spyOn(galleryTransferLedger, "pendingRecovery").mockReturnValue([entry])

    await expect(mediaProcessingQueue.retryPending()).resolves.toEqual({retried: 1, failed: 0})

    expect(cameraRollExportCoordinator.exportForSource).not.toHaveBeenCalled()
    expect(asgCameraApi.acknowledgeCapture).toHaveBeenCalledWith(capture.capture_id, entry.ackId)
    expect(galleryTransferLedger.get(capture.capture_id)?.state).toBe("TRASHED")
    recoverySpy.mockRestore()
  })

  it("rebuilds a missing local index before retrying a durable export", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 75})
    ;(localStorageService.getDownloadedFile as jest.Mock).mockResolvedValueOnce(null)
    ;(cameraRollExportCoordinator.isAutoSaveEnabled as jest.Mock).mockResolvedValueOnce(true)
    const capture = {
      capture_id: "IMG_recover_index",
      type: "photo" as const,
      timestamp: 1000,
      total_size: 100,
      files: [{name: "IMG_recover_index/base.jpg", size: 100, role: "primary" as const}],
    }
    galleryTransferLedger.ensureCapture(capture, 3)
    const entry = galleryTransferLedger.transition(capture.capture_id, "EXPORT_PENDING", {
      finalPath: "/tmp/IMG_recover_index/base.jpg",
      thumbnailPath: "/tmp/IMG_recover_index/thumb.jpg",
      shouldAutoSave: true,
    })
    const recoverySpy = jest.spyOn(galleryTransferLedger, "pendingRecovery").mockReturnValue([entry])

    await expect(mediaProcessingQueue.retryPending()).resolves.toEqual({retried: 1, failed: 0})

    expect(localStorageService.saveDownloadedFile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: capture.capture_id,
        filePath: entry.finalPath,
        capture_id: capture.capture_id,
        size: 75,
        modified: capture.timestamp,
      }),
    )
    expect(cameraRollExportCoordinator.exportForSource).toHaveBeenCalledWith(
      expect.objectContaining({capture_id: capture.capture_id}),
      capture.capture_id,
    )
    expect(galleryTransferLedger.get(capture.capture_id)?.state).toBe("TRASHED")
    recoverySpy.mockRestore()
  })

  it("repairs a stale local index from the durable transfer path before retrying export", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 75})
    ;(localStorageService.getDownloadedFile as jest.Mock).mockResolvedValueOnce({
      name: "IMG_recover_stale_index",
      filePath: "/tmp/old-generation/base.jpg",
      capture_id: "IMG_recover_stale_index",
      size: 100,
      modified: 500,
    })
    ;(cameraRollExportCoordinator.isAutoSaveEnabled as jest.Mock).mockResolvedValueOnce(true)
    const capture = {
      capture_id: "IMG_recover_stale_index",
      type: "photo" as const,
      timestamp: 1000,
      total_size: 100,
      files: [{name: "IMG_recover_stale_index/base.jpg", size: 100, role: "primary" as const}],
    }
    galleryTransferLedger.ensureCapture(capture, 3)
    const entry = galleryTransferLedger.transition(capture.capture_id, "EXPORT_PENDING", {
      finalPath: "/tmp/current-generation/base.jpg",
      thumbnailPath: "/tmp/current-generation/thumb.jpg",
      shouldAutoSave: true,
    })
    const recoverySpy = jest.spyOn(galleryTransferLedger, "pendingRecovery").mockReturnValue([entry])

    await expect(mediaProcessingQueue.retryPending()).resolves.toEqual({retried: 1, failed: 0})

    expect(localStorageService.saveDownloadedFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: entry.finalPath,
        capture_id: capture.capture_id,
        size: 75,
        modified: capture.timestamp,
      }),
    )
    expect(cameraRollExportCoordinator.exportForSource).toHaveBeenCalledWith(
      expect.objectContaining({filePath: entry.finalPath, size: 75, modified: capture.timestamp}),
      capture.capture_id,
    )
    expect(galleryTransferLedger.get(capture.capture_id)?.state).toBe("TRASHED")
    recoverySpy.mockRestore()
  })

  it("acks recovered EXPORT_PENDING media when automatic saving is now disabled", async () => {
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.stat as jest.Mock).mockResolvedValue({size: 100})
    ;(localStorageService.getDownloadedFile as jest.Mock).mockResolvedValueOnce({
      name: "IMG_recover_disabled",
      capture_id: "IMG_recover_disabled",
    })
    const capture = {
      capture_id: "IMG_recover_disabled",
      type: "photo" as const,
      timestamp: 1000,
      total_size: 100,
      files: [{name: "IMG_recover_disabled/base.jpg", size: 100, role: "primary" as const}],
    }
    galleryTransferLedger.ensureCapture(capture, 3)
    const entry = galleryTransferLedger.transition(capture.capture_id, "EXPORT_PENDING", {
      finalPath: "/tmp/IMG_recover_disabled/base.jpg",
      shouldAutoSave: true,
    })
    const recoverySpy = jest.spyOn(galleryTransferLedger, "pendingRecovery").mockReturnValue([entry])

    await expect(mediaProcessingQueue.retryPending()).resolves.toEqual({retried: 1, failed: 0})

    expect(cameraRollExportCoordinator.exportForSource).not.toHaveBeenCalled()
    expect(asgCameraApi.acknowledgeCapture).toHaveBeenCalledWith(capture.capture_id, entry.ackId)
    expect(galleryTransferLedger.get(capture.capture_id)).toMatchObject({state: "TRASHED", shouldAutoSave: false})
    recoverySpy.mockRestore()
  })

  it("attempts restore for a v2-negotiated capture when committed local media disappears", async () => {
    const capture = {
      capture_id: "IMG_restore_missing",
      type: "photo" as const,
      timestamp: 1000,
      total_size: 100,
      files: [{name: "IMG_restore_missing/base.jpg", size: 100, role: "primary" as const}],
    }
    // A transient v3 capability probe failure can negotiate v2 against new glasses firmware.
    // Recovery must still try the additive restore endpoint instead of silently losing the source.
    galleryTransferLedger.ensureCapture(capture, 2)
    galleryTransferLedger.transition(capture.capture_id, "TRASHED", {
      finalPath: "/tmp/IMG_restore_missing/base.jpg",
    })
    galleryTransferLedger.releaseMissingLocalCommit(capture.capture_id, true)
    const recoveryEntry = galleryTransferLedger.get(capture.capture_id)!
    const recoverySpy = jest.spyOn(galleryTransferLedger, "pendingRecovery").mockReturnValue([recoveryEntry])

    await expect(mediaProcessingQueue.retryPending()).resolves.toEqual({retried: 1, failed: 0})

    expect(asgCameraApi.restoreCapture).toHaveBeenCalledWith(capture.capture_id)
    expect(asgCameraApi.acknowledgeCapture).not.toHaveBeenCalled()
    expect(galleryTransferLedger.get(capture.capture_id)?.state).toBe("DISCOVERED")
    recoverySpy.mockRestore()
  })
})
