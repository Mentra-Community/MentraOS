/* eslint-disable no-restricted-imports */
import * as RNFS from "@dr.pogodin/react-native-fs"

import {cameraRollExportCoordinator} from "../../../modules/engine/src/services/asg/cameraRollExportCoordinator"
import {cameraRollExportLedger} from "../../../modules/engine/src/services/asg/cameraRollExportLedger"
import {localStorageService, type DownloadedFile} from "../../../modules/engine/src/services/asg/localStorageService"
import {MediaLibraryPermissions} from "../../../modules/engine/src/utils/permissions/MediaLibraryPermissions"
import {storage} from "../../../modules/engine/src/utils/storage"

let mockFiles: Record<string, DownloadedFile> = {}
let mockAutoSaveEnabled = true

jest.mock("@dr.pogodin/react-native-fs", () => ({
  DocumentDirectoryPath: "/tmp",
  exists: jest.fn(() => Promise.resolve(true)),
  getFSInfo: jest.fn(() => Promise.resolve({freeSpace: 10 * 1024 * 1024 * 1024})),
}))

jest.mock("../../../modules/engine/src/services/asg/localStorageService", () => ({
  localStorageService: {
    getDownloadedFiles: jest.fn(() => Promise.resolve(mockFiles)),
    updateDownloadedFileAssetReceipt: jest.fn((name: string, receipt: any) => {
      mockFiles[name] = {...mockFiles[name], assetReceipt: receipt}
      return Promise.resolve()
    }),
    deleteDownloadedFile: jest.fn((name: string) => {
      const existed = !!mockFiles[name]
      delete mockFiles[name]
      return Promise.resolve(existed)
    }),
    clearAllFiles: jest.fn(() => {
      mockFiles = {}
      return Promise.resolve()
    }),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/gallerySettingsService", () => ({
  gallerySettingsService: {
    getAutoSaveToCameraRoll: jest.fn(() => Promise.resolve(mockAutoSaveEnabled)),
    setAutoSaveToCameraRoll: jest.fn((enabled: boolean) => {
      mockAutoSaveEnabled = enabled
      return Promise.resolve()
    }),
  },
}))

jest.mock("../../../modules/engine/src/services/asg/galleryTransferLedger", () => ({
  galleryTransferLedger: {
    get: jest.fn(),
    update: jest.fn(),
  },
}))

jest.mock("../../../modules/engine/src/utils/permissions/MediaLibraryPermissions", () => ({
  MediaLibraryPermissions: {
    checkPermission: jest.fn(() => Promise.resolve(true)),
    saveToLibraryWithReceipt: jest.fn(() => Promise.resolve({success: true, platform: "ios", identifier: "asset-1"})),
  },
}))

function legacyFile(name = "IMG_20260101_120000"): DownloadedFile {
  return {
    name,
    filePath: `/tmp/MentraPhotos/${name}/base.jpg`,
    size: 1234,
    modified: 1_767_268_800_000,
    mime_type: "image/jpeg",
    is_video: false,
    downloaded_at: Date.now(),
  }
}

describe("cameraRollExportCoordinator", () => {
  beforeEach(() => {
    cameraRollExportCoordinator.cleanup()
    storage.clearAll()
    mockFiles = {}
    mockAutoSaveEnabled = true
    jest.clearAllMocks()
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    ;(RNFS.getFSInfo as jest.Mock).mockResolvedValue({freeSpace: 10 * 1024 * 1024 * 1024})
    ;(MediaLibraryPermissions.checkPermission as jest.Mock).mockResolvedValue(true)
    ;(MediaLibraryPermissions.saveToLibraryWithReceipt as jest.Mock).mockResolvedValue({
      success: true,
      platform: "ios",
      identifier: "asset-1",
    })
  })

  afterEach(() => cameraRollExportCoordinator.cleanup())

  it("backfills a legacy item and reconciles its old basename before inserting", async () => {
    const file = legacyFile()
    mockFiles[file.name] = file

    await cameraRollExportCoordinator.initialize()
    await cameraRollExportCoordinator.resume("test")

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).toHaveBeenCalledWith(file.filePath, file.modified)
    expect(localStorageService.updateDownloadedFileAssetReceipt).toHaveBeenCalledWith(
      file.name,
      expect.objectContaining({identifier: "asset-1"}),
    )
    expect(cameraRollExportCoordinator.getSummary()).toMatchObject({exported: 1, pending: 0})
  })

  it("does not recreate an asset that already has a durable receipt", async () => {
    const file = legacyFile()
    file.assetReceipt = {platform: "ios", identifier: "existing", exportedAt: Date.now()}
    mockFiles[file.name] = file

    await cameraRollExportCoordinator.initialize()
    await cameraRollExportCoordinator.resume("test")

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).not.toHaveBeenCalled()
    expect(cameraRollExportCoordinator.getSummary()).toMatchObject({exported: 1, pending: 0})
  })

  it("keeps denied exports durable and blocked instead of dropping them", async () => {
    const file = legacyFile()
    mockFiles[file.name] = file
    ;(MediaLibraryPermissions.checkPermission as jest.Mock).mockResolvedValue(false)

    await cameraRollExportCoordinator.initialize()
    await cameraRollExportCoordinator.resume("test")

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).not.toHaveBeenCalled()
    expect(cameraRollExportCoordinator.getSummary()).toMatchObject({blockedPermission: 1, pending: 1})
    expect(cameraRollExportLedger.list()[0].state).toBe("BLOCKED_PERMISSION")
  })

  it("queues all still-local unsaved items when automatic saving is re-enabled", async () => {
    const file = legacyFile()
    mockFiles[file.name] = file
    mockAutoSaveEnabled = false

    await cameraRollExportCoordinator.initialize()
    await cameraRollExportCoordinator.resume("disabled")
    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).not.toHaveBeenCalled()

    await cameraRollExportCoordinator.setEnabled(true)
    await cameraRollExportCoordinator.resume("enabled")

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).toHaveBeenCalledTimes(1)
    expect(cameraRollExportCoordinator.getSummary().exported).toBe(1)
  })

  it("uses the same durable path for a source-deletion barrier", async () => {
    const file = legacyFile("IMG_source")
    mockFiles[file.name] = file

    const receipt = await cameraRollExportCoordinator.exportForSource(file, "IMG_source")

    expect(receipt.identifier).toBe("asset-1")
    expect(cameraRollExportLedger.list()[0]).toMatchObject({
      priority: "SOURCE_BARRIER",
      state: "EXPORTED",
    })
  })

  it("clears local media and its export receipts through one serialized operation", async () => {
    const file = legacyFile()
    mockFiles[file.name] = file
    await cameraRollExportCoordinator.initialize()
    await cameraRollExportCoordinator.resume("test")

    await cameraRollExportCoordinator.clearLocalMedia()

    expect(localStorageService.clearAllFiles).toHaveBeenCalled()
    expect(cameraRollExportLedger.list()).toEqual([])
    expect(cameraRollExportCoordinator.getSummary().total).toBe(0)
  })

  it("waits for an in-flight native export before deleting its local source", async () => {
    const file = legacyFile()
    mockFiles[file.name] = file
    let finishExport!: (receipt: {success: true; platform: "ios"; identifier: string}) => void
    ;(MediaLibraryPermissions.saveToLibraryWithReceipt as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishExport = resolve
        }),
    )

    await cameraRollExportCoordinator.initialize()
    const drain = cameraRollExportCoordinator.resume("test")
    for (let i = 0; i < 10 && !finishExport; i += 1) await Promise.resolve()
    expect(finishExport).toBeDefined()

    const deletion = cameraRollExportCoordinator.deleteLocalMedia(file.name)
    await Promise.resolve()
    expect(localStorageService.deleteDownloadedFile).not.toHaveBeenCalled()

    finishExport({success: true, platform: "ios", identifier: "asset-1"})
    await drain
    await deletion

    expect(localStorageService.deleteDownloadedFile).toHaveBeenCalledWith(file.name)
    expect(cameraRollExportLedger.list()).toEqual([])
  })
})
