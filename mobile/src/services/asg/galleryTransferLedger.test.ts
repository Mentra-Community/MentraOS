// This test targets the engine source directly because the ledger is intentionally internal.
import {galleryTransferLedger} from "../../../modules/engine/src/services/asg/galleryTransferLedger"
import {localStorageService} from "../../../modules/engine/src/services/asg/localStorageService"
import {storage} from "../../../modules/engine/src/utils/storage"

jest.mock("@dr.pogodin/react-native-fs", () => ({
  DocumentDirectoryPath: "/current/Documents",
  exists: jest.fn().mockResolvedValue(true),
  mkdir: jest.fn().mockResolvedValue(undefined),
}))

describe("galleryTransferLedger", () => {
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

    const released = await localStorageService.reconcileRemoteCaptures([captureId])

    expect(released).toBe(1)
    expect(galleryTransferLedger.get(captureId)?.state).toBe("RESTORE_PENDING")
  })
})
