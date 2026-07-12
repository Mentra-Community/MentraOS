import {
  galleryMediaIntegrityThrottleKey,
  submitInvalidGalleryMediaReport,
} from "../../../modules/engine/src/services/asg/GalleryMediaIntegrityReportService"
import {submitAutomaticReport} from "../../../modules/engine/src/facades/reports"

jest.mock("../../../modules/engine/src/facades/reports", () => ({
  submitAutomaticReport: jest.fn(),
}))

describe("GalleryMediaIntegrityReportService", () => {
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    ;(submitAutomaticReport as jest.Mock).mockClear()
    ;(submitAutomaticReport as jest.Mock).mockResolvedValue({
      status: "submitted",
      reportId: "report-1",
      reportStatus: "ready",
    })
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {})
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("files invalid downloaded media reports through island internals", async () => {
    const input = {
      name: "VID_001.mp4",
      captureId: "CAPTURE_001",
      mediaKind: "video" as const,
      stage: "processing_validation" as const,
      reason: "Invalid downloaded media: invalid video container for VID_001.mp4",
      path: "/tmp/VID_001.mp4",
      expectedSize: 1234,
      duration: 5000,
      glassesModel: "Mentra Live",
    }

    const result = await submitInvalidGalleryMediaReport(input)

    expect(submitAutomaticReport).toHaveBeenCalledWith({
      kind: "automatic",
      trigger: {
        type: "automatic",
        source: "gallery_media_integrity",
        reason: "invalid_downloaded_media",
      },
      report: {
        expectedBehavior: "Gallery media synced from glasses should be valid before it is shown in the gallery.",
        actualBehavior: JSON.stringify(input, null, 2),
        systemPriority: "high",
      },
      throttleKey: galleryMediaIntegrityThrottleKey(input),
      throttleWindowMs: 90_000,
    })
    expect(result).toEqual({status: "filed", reportId: "report-1"})
    expect(logSpy).toHaveBeenCalledWith("[GalleryMediaIntegrityReport] Report filed:", "report-1")
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it("uses medium priority for invalid photo reports", async () => {
    await submitInvalidGalleryMediaReport({
      name: "IMG_001.jpg",
      mediaKind: "photo",
      stage: "download_validation",
      reason: "Invalid downloaded media: invalid photo signature for IMG_001.jpg",
    })

    expect(submitAutomaticReport).toHaveBeenCalledWith(
      expect.objectContaining({
        report: expect.objectContaining({
          systemPriority: "medium",
        }),
      }),
    )
  })
})
