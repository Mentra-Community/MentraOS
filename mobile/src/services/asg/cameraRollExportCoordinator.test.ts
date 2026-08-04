/* eslint-disable no-restricted-imports */
import * as RNFS from "@dr.pogodin/react-native-fs"

import {cameraRollExportCoordinator} from "../../../modules/engine/src/services/asg/cameraRollExportCoordinator"
import {cameraRollExportLedger} from "../../../modules/engine/src/services/asg/cameraRollExportLedger"
import {galleryTransferLedger} from "../../../modules/engine/src/services/asg/galleryTransferLedger"
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
    hasLimitedAccess: jest.fn(() => Promise.resolve(false)),
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
    ;(MediaLibraryPermissions.hasLimitedAccess as jest.Mock).mockResolvedValue(false)
    ;(MediaLibraryPermissions.saveToLibraryWithReceipt as jest.Mock).mockResolvedValue({
      success: true,
      platform: "ios",
      identifier: "asset-1",
    })
  })

  afterEach(() => cameraRollExportCoordinator.cleanup())

  it("does not emit a default enabled state before durable settings load", async () => {
    mockAutoSaveEnabled = false
    const listener = jest.fn()

    const unsubscribe = cameraRollExportCoordinator.subscribe(listener)
    expect(listener).not.toHaveBeenCalled()

    await cameraRollExportCoordinator.initialize()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({enabled: false}))
    unsubscribe()
  })

  it("reconciles durable receipts before reporting delete-loss warnings", async () => {
    const file = legacyFile("IMG_already_exported")
    file.assetReceipt = {platform: "ios", identifier: "existing", exportedAt: Date.now()}
    mockFiles[file.name] = file

    await expect(cameraRollExportCoordinator.countNotExported([file.name])).resolves.toBe(0)
    expect(cameraRollExportCoordinator.getSummary()).toMatchObject({exported: 1, pending: 0})
  })

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

  it("retains a hidden export receipt until its missing local index row is recovered", async () => {
    const file = legacyFile("IMG_receipt_recovery")
    file.assetReceipt = {platform: "ios", identifier: "durable-receipt", exportedAt: Date.now()}
    mockFiles[file.name] = file

    await cameraRollExportCoordinator.initialize()
    cameraRollExportCoordinator.cleanup()
    mockFiles = {}
    await cameraRollExportCoordinator.initialize()

    expect(cameraRollExportLedger.list()).toEqual([
      expect.objectContaining({state: "EXPORTED", localPresent: false, receipt: file.assetReceipt}),
    ])
    expect(cameraRollExportCoordinator.getSummary()).toMatchObject({total: 0, exported: 0})

    cameraRollExportCoordinator.cleanup()
    mockFiles[file.name] = {...file, assetReceipt: undefined}
    await cameraRollExportCoordinator.initialize()
    await cameraRollExportCoordinator.resume("recovered index")

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).not.toHaveBeenCalled()
    expect(cameraRollExportLedger.list()[0]).toMatchObject({
      state: "EXPORTED",
      localPresent: true,
      receipt: file.assetReceipt,
    })
  })

  it("reports an unexported missing row and retries it after the local index is recovered", async () => {
    const file = legacyFile("IMG_missing_backfill")
    mockAutoSaveEnabled = false
    mockFiles[file.name] = file
    await cameraRollExportCoordinator.initialize()

    cameraRollExportCoordinator.cleanup()
    mockAutoSaveEnabled = true
    mockFiles = {}
    await cameraRollExportCoordinator.initialize()

    expect(cameraRollExportCoordinator.getSummary()).toMatchObject({total: 1, exported: 0, missing: 1})
    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).not.toHaveBeenCalled()

    mockFiles[file.name] = file
    await cameraRollExportCoordinator.retryNow()

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).toHaveBeenCalledWith(file.filePath, file.modified)
    expect(cameraRollExportCoordinator.getSummary()).toMatchObject({exported: 1, missing: 0})
  })

  it("does not let an older receipt confirm a replacement generation with the same name", async () => {
    const original = legacyFile("IMG_replaced")
    original.assetReceipt = {platform: "ios", identifier: "old-generation", exportedAt: Date.now()}
    mockFiles[original.name] = original
    await cameraRollExportCoordinator.initialize()

    cameraRollExportCoordinator.cleanup()
    mockAutoSaveEnabled = false
    mockFiles[original.name] = {
      ...original,
      size: original.size + 1,
      modified: original.modified + 1,
      assetReceipt: undefined,
    }
    await cameraRollExportCoordinator.initialize()

    await expect(cameraRollExportCoordinator.countNotExported([original.name])).resolves.toBe(1)
  })

  it("returns a durable source receipt even when automatic saving is disabled", async () => {
    const file = legacyFile("IMG_exported_before_disable")
    file.assetReceipt = {platform: "ios", identifier: "existing", exportedAt: Date.now()}
    mockFiles[file.name] = file
    mockAutoSaveEnabled = false

    await expect(cameraRollExportCoordinator.exportForSource(file, file.name)).resolves.toMatchObject({
      identifier: "existing",
    })
    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).not.toHaveBeenCalled()
  })

  it("keeps an unexported source app-local when automatic saving is disabled", async () => {
    const file = legacyFile("IMG_disabled_source")
    mockFiles[file.name] = file
    mockAutoSaveEnabled = false

    await expect(cameraRollExportCoordinator.exportForSource(file, file.name)).resolves.toBeUndefined()
    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).not.toHaveBeenCalled()
    expect(cameraRollExportLedger.list()[0]).toMatchObject({state: "NOT_REQUESTED", localPresent: true})
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

  it("retries an item after a transient local filesystem miss", async () => {
    const file = legacyFile("IMG_transient_missing")
    mockFiles[file.name] = file
    ;(RNFS.exists as jest.Mock).mockResolvedValue(false)

    await cameraRollExportCoordinator.initialize()
    await cameraRollExportCoordinator.resume("missing")
    expect(cameraRollExportLedger.list()[0].state).toBe("MISSING_LOCAL")
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    await cameraRollExportCoordinator.retryNow()

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).toHaveBeenCalledWith(file.filePath, file.modified)
    expect(cameraRollExportCoordinator.getSummary()).toMatchObject({exported: 1, missing: 0})
  })

  it("requeues a previously missing generation when restart reconciliation sees it again", async () => {
    const file = legacyFile("IMG_missing_at_restart")
    mockFiles[file.name] = file
    ;(RNFS.exists as jest.Mock).mockResolvedValue(false)

    await cameraRollExportCoordinator.initialize()
    await cameraRollExportCoordinator.resume("missing")
    expect(cameraRollExportLedger.list()[0].state).toBe("MISSING_LOCAL")

    cameraRollExportCoordinator.cleanup()
    ;(RNFS.exists as jest.Mock).mockResolvedValue(true)
    await cameraRollExportCoordinator.initialize()
    await cameraRollExportCoordinator.resume("restart")

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).toHaveBeenCalledWith(file.filePath, file.modified)
    expect(cameraRollExportCoordinator.getSummary()).toMatchObject({exported: 1, missing: 0})
  })

  it("does not duplicate an unreceipted legacy export under limited iOS access", async () => {
    const file = legacyFile()
    mockFiles[file.name] = file
    ;(MediaLibraryPermissions.hasLimitedAccess as jest.Mock).mockResolvedValue(true)

    await cameraRollExportCoordinator.initialize()
    await cameraRollExportCoordinator.resume("limited")

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).not.toHaveBeenCalled()
    expect(cameraRollExportLedger.list()[0]).toMatchObject({
      state: "BLOCKED_PERMISSION",
      requiresFullLibraryReconciliation: true,
    })
  })

  it("still exports newly indexed media under limited iOS access", async () => {
    const file = legacyFile("IMG_new")
    ;(MediaLibraryPermissions.hasLimitedAccess as jest.Mock).mockResolvedValue(true)
    await cameraRollExportCoordinator.initialize()
    mockFiles[file.name] = file

    const receipt = await cameraRollExportCoordinator.exportForSource(file, file.name)

    expect(receipt?.identifier).toBe("asset-1")
    expect(cameraRollExportLedger.list()[0]).toMatchObject({
      state: "EXPORTED",
      requiresFullLibraryReconciliation: false,
    })
  })

  it("does not misclassify a new-pipeline transfer as an ambiguous legacy export", async () => {
    const file = legacyFile("IMG_new_pipeline_recovery")
    mockFiles[file.name] = file
    ;(galleryTransferLedger.get as jest.Mock).mockReturnValue({captureId: file.name})
    ;(MediaLibraryPermissions.hasLimitedAccess as jest.Mock).mockResolvedValue(true)

    await cameraRollExportCoordinator.initialize()
    await cameraRollExportCoordinator.resume("new pipeline recovery")

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).toHaveBeenCalledWith(file.filePath, file.modified)
    expect(cameraRollExportLedger.list()[0]).toMatchObject({
      state: "EXPORTED",
      requiresFullLibraryReconciliation: false,
    })
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

  it("pauses queued source barriers when automatic saving is disabled", async () => {
    const file = legacyFile("IMG_source_paused")
    await cameraRollExportCoordinator.initialize()
    mockFiles[file.name] = file
    await cameraRollExportCoordinator.recordIndexed(file, true, "SOURCE_BARRIER", file.name)

    await cameraRollExportCoordinator.setEnabled(false)
    await cameraRollExportCoordinator.resume("disabled foreground")

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).not.toHaveBeenCalled()
    expect(cameraRollExportLedger.list()[0]).toMatchObject({
      priority: "SOURCE_BARRIER",
      state: "NOT_REQUESTED",
    })
  })

  it("does not start a native save after an active source barrier is disabled", async () => {
    const file = legacyFile("IMG_source_disabled_during_checks")
    let finishExists!: (exists: boolean) => void
    ;(RNFS.exists as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishExists = resolve
        }),
    )

    await cameraRollExportCoordinator.initialize()
    mockFiles[file.name] = file
    const sourceExport = cameraRollExportCoordinator.exportForSource(file, file.name)
    for (let i = 0; i < 10 && !finishExists; i += 1) await Promise.resolve()
    expect(finishExists).toBeDefined()

    await cameraRollExportCoordinator.setEnabled(false)
    finishExists(true)

    await expect(sourceExport).resolves.toBeUndefined()
    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).not.toHaveBeenCalled()
    expect(cameraRollExportLedger.list()[0].state).toBe("NOT_REQUESTED")
  })

  it("uses the same durable path for a source-deletion barrier", async () => {
    const file = legacyFile("IMG_source")
    mockFiles[file.name] = file

    const receipt = await cameraRollExportCoordinator.exportForSource(file, "IMG_source")

    expect(receipt?.identifier).toBe("asset-1")
    expect(cameraRollExportLedger.list()[0]).toMatchObject({
      priority: "SOURCE_BARRIER",
      state: "EXPORTED",
    })
  })

  it("returns a receipt committed before its source waiter registers", async () => {
    const file = legacyFile("IMG_receipt_race")
    const receipt = {platform: "ios" as const, identifier: "already-exported", exportedAt: Date.now()}
    await cameraRollExportCoordinator.initialize()
    mockFiles[file.name] = file
    const staleEntry = await cameraRollExportCoordinator.recordIndexed(file, true, "SOURCE_BARRIER", file.name)
    cameraRollExportLedger.update(staleEntry.id, {state: "EXPORTED", receipt})
    const recordSpy = jest
      .spyOn(cameraRollExportCoordinator, "recordIndexed")
      .mockResolvedValueOnce({...staleEntry, state: "QUEUED", receipt: undefined})

    try {
      await expect(cameraRollExportCoordinator.exportForSource(file, file.name)).resolves.toEqual(receipt)
    } finally {
      recordSpy.mockRestore()
    }
  })

  it("stops source waiters and serializes restart reconciliation behind an in-flight export", async () => {
    const file = legacyFile("IMG_engine_restart")
    let finishExport!: (receipt: {success: true; platform: "ios"; identifier: string}) => void
    ;(MediaLibraryPermissions.saveToLibraryWithReceipt as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishExport = resolve
        }),
    )

    await cameraRollExportCoordinator.initialize()
    mockFiles[file.name] = file
    const sourceExport = cameraRollExportCoordinator.exportForSource(file, file.name)
    for (let i = 0; i < 10 && !finishExport; i += 1) await Promise.resolve()
    expect(finishExport).toBeDefined()

    cameraRollExportCoordinator.cleanup()
    await expect(sourceExport).rejects.toThrow("coordinator stopped")

    const reconciliationCalls = (localStorageService.getDownloadedFiles as jest.Mock).mock.calls.length
    const restart = cameraRollExportCoordinator.initialize()
    await Promise.resolve()
    expect(localStorageService.getDownloadedFiles).toHaveBeenCalledTimes(reconciliationCalls)

    finishExport({success: true, platform: "ios", identifier: "asset-after-restart"})
    await restart

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).toHaveBeenCalledTimes(1)
    expect(cameraRollExportCoordinator.getSummary()).toMatchObject({exported: 1, pending: 0, isRunning: false})
  })

  it("drains eligible work after a concurrent resume handoff", async () => {
    const file = legacyFile("IMG_resume_handoff")
    await cameraRollExportCoordinator.initialize()
    mockFiles[file.name] = file
    await cameraRollExportCoordinator.recordIndexed(file, true, "HISTORICAL_BACKFILL", file.name)

    const coordinatorState = cameraRollExportCoordinator as unknown as {
      running: boolean
      rerunRequested: boolean
    }
    coordinatorState.running = true
    const concurrentResume = cameraRollExportCoordinator.resume("concurrent handoff")
    for (let i = 0; i < 10 && !coordinatorState.rerunRequested; i += 1) await Promise.resolve()
    expect(coordinatorState.rerunRequested).toBe(true)

    coordinatorState.running = false
    await concurrentResume

    expect(MediaLibraryPermissions.saveToLibraryWithReceipt).toHaveBeenCalledWith(file.filePath, file.modified)
    expect(cameraRollExportLedger.list()[0].state).toBe("EXPORTED")
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
    let finishExport!: (receipt: {success: true; platform: "ios"; identifier: string}) => void
    ;(MediaLibraryPermissions.saveToLibraryWithReceipt as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishExport = resolve
        }),
    )

    await cameraRollExportCoordinator.initialize()
    mockFiles[file.name] = file
    const exportForSource = cameraRollExportCoordinator.exportForSource(file, file.name)
    for (let i = 0; i < 10 && !finishExport; i += 1) await Promise.resolve()
    expect(finishExport).toBeDefined()

    const deletion = cameraRollExportCoordinator.deleteLocalMedia(file.name)
    await Promise.resolve()
    expect(localStorageService.deleteDownloadedFile).not.toHaveBeenCalled()

    finishExport({success: true, platform: "ios", identifier: "asset-1"})
    await expect(exportForSource).resolves.toMatchObject({identifier: "asset-1"})
    await deletion

    expect(localStorageService.deleteDownloadedFile).toHaveBeenCalledWith(file.name)
    expect(cameraRollExportLedger.list()).toEqual([])
  })

  it("keeps a source barrier alive when local deletion fails", async () => {
    const activeFile = legacyFile("IMG_active")
    const queuedFile = legacyFile("IMG_delete_failed")
    let finishActiveExport!: (receipt: {success: true; platform: "ios"; identifier: string}) => void
    ;(MediaLibraryPermissions.saveToLibraryWithReceipt as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishActiveExport = resolve
          }),
      )
      .mockResolvedValueOnce({success: true, platform: "ios", identifier: "asset-2"})
    ;(localStorageService.deleteDownloadedFile as jest.Mock).mockResolvedValueOnce(false)

    await cameraRollExportCoordinator.initialize()
    mockFiles[activeFile.name] = activeFile
    mockFiles[queuedFile.name] = queuedFile
    const activeExport = cameraRollExportCoordinator.exportForSource(activeFile, activeFile.name)
    for (let i = 0; i < 10 && !finishActiveExport; i += 1) await Promise.resolve()
    expect(finishActiveExport).toBeDefined()
    const queuedExport = cameraRollExportCoordinator.exportForSource(queuedFile, queuedFile.name)
    for (let i = 0; i < 10 && cameraRollExportLedger.list().length < 2; i += 1) await Promise.resolve()

    await expect(cameraRollExportCoordinator.deleteLocalMedia(queuedFile.name)).resolves.toBe(false)
    finishActiveExport({success: true, platform: "ios", identifier: "asset-1"})

    await expect(activeExport).resolves.toMatchObject({identifier: "asset-1"})
    await expect(queuedExport).resolves.toMatchObject({identifier: "asset-2"})
    expect(cameraRollExportLedger.list().find((entry) => entry.mediaName === queuedFile.name)).toMatchObject({
      state: "EXPORTED",
    })
  })

  it("keeps queued barriers alive when clearing local media fails", async () => {
    const activeFile = legacyFile("IMG_active_clear")
    const queuedFile = legacyFile("IMG_clear_failed")
    let finishActiveExport!: (receipt: {success: true; platform: "ios"; identifier: string}) => void
    ;(MediaLibraryPermissions.saveToLibraryWithReceipt as jest.Mock)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishActiveExport = resolve
          }),
      )
      .mockResolvedValueOnce({success: true, platform: "ios", identifier: "asset-2"})
    ;(localStorageService.clearAllFiles as jest.Mock).mockRejectedValueOnce(new Error("clear failed"))

    await cameraRollExportCoordinator.initialize()
    mockFiles[activeFile.name] = activeFile
    mockFiles[queuedFile.name] = queuedFile
    const activeExport = cameraRollExportCoordinator.exportForSource(activeFile, activeFile.name)
    for (let i = 0; i < 10 && !finishActiveExport; i += 1) await Promise.resolve()
    expect(finishActiveExport).toBeDefined()
    const queuedExport = cameraRollExportCoordinator.exportForSource(queuedFile, queuedFile.name)
    for (let i = 0; i < 10 && cameraRollExportLedger.list().length < 2; i += 1) await Promise.resolve()

    const clearing = cameraRollExportCoordinator.clearLocalMedia()
    finishActiveExport({success: true, platform: "ios", identifier: "asset-1"})

    await expect(activeExport).resolves.toMatchObject({identifier: "asset-1"})
    await expect(clearing).rejects.toThrow("clear failed")
    await expect(queuedExport).resolves.toMatchObject({identifier: "asset-2"})
    expect(cameraRollExportLedger.list().find((entry) => entry.mediaName === queuedFile.name)).toMatchObject({
      state: "EXPORTED",
    })
  })
})
