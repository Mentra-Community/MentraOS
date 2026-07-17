// This test targets the engine source directly because the ledger is intentionally internal.
import {galleryTransferLedger} from "../../../modules/engine/src/services/asg/galleryTransferLedger"

jest.mock("@dr.pogodin/react-native-fs", () => ({
  DocumentDirectoryPath: "/current/Documents",
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
})
