// This test targets the engine source directly because the ledger is intentionally internal.
import * as RNFS from "@dr.pogodin/react-native-fs"

import {galleryTransferLedger} from "../../../modules/engine/src/services/asg/galleryTransferLedger"
import {localStorageService} from "../../../modules/engine/src/services/asg/localStorageService"
import {storage} from "../../../modules/engine/src/utils/storage"

const mockExists = RNFS.exists as jest.Mock
const mockStat = RNFS.stat as jest.Mock

jest.mock("@dr.pogodin/react-native-fs", () => ({
  DocumentDirectoryPath: "/current/Documents",
  exists: jest.fn().mockResolvedValue(true),
  stat: jest.fn().mockResolvedValue({size: 100}),
  mkdir: jest.fn().mockResolvedValue(undefined),
}))

describe("galleryTransferLedger", () => {
  beforeEach(() => {
    mockExists.mockResolvedValue(true)
    mockStat.mockResolvedValue({size: 100})
  })

  it("resets a committed entry when v3 introduces a different source generation", () => {
    const captureId = `IMG_generation_${Date.now()}`
    const legacyCapture = {
      capture_id: captureId,
      type: "photo" as const,
      timestamp: 1000,
      total_size: 100,
      files: [{name: `${captureId}/base.jpg`, size: 100, role: "primary" as const}],
    }
    const initial = galleryTransferLedger.ensureCapture(legacyCapture, 2)
    galleryTransferLedger.transition(captureId, "TRASHED")

    const v3 = galleryTransferLedger.ensureCapture(
      {
        ...legacyCapture,
        files: [{...legacyCapture.files[0], etag: '"generation-2"'}],
      },
      3,
    )

    expect(v3.state).toBe("DISCOVERED")
    expect(v3.ackId).not.toBe(initial.ackId)
    expect(v3.retryCount).toBe(0)
    expect(v3.files[0].completedSegments).toEqual([])
  })

  it("resets a legacy entry when an individual file changes but the capture total does not", () => {
    const captureId = `IMG_legacy_generation_${Date.now()}`
    const initial = galleryTransferLedger.ensureCapture(
      {
        capture_id: captureId,
        type: "photo",
        timestamp: 1000,
        total_size: 100,
        files: [
          {name: `${captureId}/base.jpg`, size: 90, role: "primary"},
          {name: `${captureId}/base.imu.json`, size: 10, role: "sidecar"},
        ],
      },
      2,
    )
    galleryTransferLedger.transition(captureId, "INDEXED")

    const changed = galleryTransferLedger.ensureCapture(
      {
        capture_id: captureId,
        type: "photo",
        timestamp: 1001,
        total_size: 100,
        files: [
          {name: `${captureId}/base.jpg`, size: 89, role: "primary"},
          {name: `${captureId}/base.imu.json`, size: 11, role: "sidecar"},
        ],
      },
      2,
    )

    expect(changed.state).toBe("DISCOVERED")
    expect(changed.ackId).not.toBe(initial.ackId)
  })

  it("queues source restore for a trashed v2 entry when local media is quarantined", () => {
    const captureId = `IMG_v2_restore_${Date.now()}`
    galleryTransferLedger.ensureCapture(
      {
        capture_id: captureId,
        type: "photo",
        timestamp: 1000,
        total_size: 100,
        files: [{name: `${captureId}/base.jpg`, size: 100, role: "primary"}],
      },
      2,
    )
    galleryTransferLedger.transition(captureId, "TRASHED", {
      finalPath: "/current/Documents/MentraPhotos/v2/base.jpg",
      thumbnailPath: "/current/Documents/MentraPhotos/v2/thumb.jpg",
      files: [
        {
          name: `${captureId}/base.jpg`,
          size: 100,
          role: "primary",
          completedSegments: [0],
        },
      ],
    })

    galleryTransferLedger.releaseMissingLocalCommit(captureId, true)

    const pending = galleryTransferLedger.get(captureId)!
    expect(pending.state).toBe("RESTORE_PENDING")
    expect(pending.finalPath).toBeUndefined()
    expect(pending.thumbnailPath).toBeUndefined()
    expect(pending.files[0].completedSegments).toEqual([])
  })

  it("releases every committed entry when local gallery metadata was not restored", () => {
    const captureId = `IMG_missing_local_metadata_${Date.now()}`
    galleryTransferLedger.ensureCapture(
      {
        capture_id: captureId,
        type: "photo",
        timestamp: 1000,
        total_size: 100,
        files: [{name: `${captureId}/base.jpg`, size: 100, role: "primary"}],
      },
      3,
    )
    galleryTransferLedger.transition(captureId, "TRASHED", {
      finalPath: `/current/Documents/MentraPhotos/${captureId}/base.jpg`,
    })

    galleryTransferLedger.releaseAllMissingLocalCommits(true)

    const released = galleryTransferLedger.get(captureId)!
    expect(released.state).toBe("RESTORE_PENDING")
    expect(released.finalPath).toBeUndefined()
    expect(released.files[0].completedSegments).toEqual([])
  })

  it("releases a stale committed ledger when a remote capture is missing from the local index", async () => {
    const captureId = `IMG_empty_restored_index_${Date.now()}`
    galleryTransferLedger.ensureCapture(
      {
        capture_id: captureId,
        type: "photo",
        timestamp: 1000,
        total_size: 100,
        files: [{name: `${captureId}/base.jpg`, size: 100, role: "primary"}],
      },
      3,
    )
    galleryTransferLedger.transition(captureId, "TRASHED", {
      finalPath: `/current/Documents/MentraPhotos/${captureId}/base.jpg`,
    })
    storage.save("asg_downloaded_files", {})
    mockExists.mockResolvedValue(false)

    const released = await localStorageService.reconcileRemoteCaptures([captureId])

    expect(released).toBe(1)
    expect(galleryTransferLedger.get(captureId)?.state).toBe("RESTORE_PENDING")
  })

  it("rebuilds a missing local index from committed media on disk", async () => {
    const captureId = `IMG_missing_index_${Date.now()}`
    const filePath = `/current/Documents/MentraPhotos/${captureId}/base.jpg`
    galleryTransferLedger.ensureCapture(
      {
        capture_id: captureId,
        type: "photo",
        timestamp: 1000,
        total_size: 100,
        files: [{name: `${captureId}/base.jpg`, size: 100, role: "primary"}],
      },
      3,
    )
    galleryTransferLedger.transition(captureId, "TRASHED", {finalPath: filePath})
    storage.save("asg_downloaded_files", {})

    const downloadedFiles = {}
    const released = await localStorageService.reconcileRemoteCaptures([captureId], downloadedFiles)

    expect(mockStat).toHaveBeenCalledWith(filePath)
    expect(released).toBe(0)
    expect(downloadedFiles).toEqual(
      expect.objectContaining({
        [captureId]: expect.objectContaining({capture_id: captureId, filePath}),
      }),
    )
    expect(await localStorageService.getDownloadedFile(captureId)).toEqual(
      expect.objectContaining({capture_id: captureId, filePath}),
    )
    expect(galleryTransferLedger.get(captureId)?.state).toBe("TRASHED")
  })

  it("releases a restored local record when its media file is missing", async () => {
    const captureId = `IMG_missing_restored_file_${Date.now()}`
    const filePath = `/current/Documents/MentraPhotos/${captureId}/base.jpg`
    galleryTransferLedger.ensureCapture(
      {
        capture_id: captureId,
        type: "photo",
        timestamp: 1000,
        total_size: 100,
        files: [{name: `${captureId}/base.jpg`, size: 100, role: "primary"}],
      },
      3,
    )
    galleryTransferLedger.transition(captureId, "TRASHED", {finalPath: filePath})
    storage.save("asg_downloaded_files", {
      [captureId]: {
        name: captureId,
        filePath: `MentraPhotos/${captureId}/base.jpg`,
        size: 100,
        modified: 1000,
        mime_type: "image/jpeg",
        is_video: false,
        downloaded_at: 1000,
        capture_id: captureId,
      },
    })
    mockExists.mockResolvedValue(false)

    const released = await localStorageService.reconcileRemoteCaptures([captureId])

    expect(mockExists).toHaveBeenCalledWith(filePath)
    expect(released).toBe(1)
    expect(galleryTransferLedger.get(captureId)?.state).toBe("RESTORE_PENDING")
  })
})
