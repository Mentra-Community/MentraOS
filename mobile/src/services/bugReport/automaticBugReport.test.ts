import {toolkit} from "@mentra/island"
import {submitAutomaticBugReport} from "./automaticBugReport"

jest.mock("@mentra/island", () => ({
  toolkit: {
    reports: {
      submit: jest.fn(),
    },
  },
}))

describe("submitAutomaticBugReport", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("builds trigger/report inputs and delegates automatic filing to toolkit", async () => {
    ;(toolkit.reports.submit as jest.Mock).mockResolvedValue({
      status: "submitted",
      reportId: "rep_1",
      reportStatus: "ready",
      created: true,
    })

    const result = await submitAutomaticBugReport({
      categorization: {
        submissionMode: "AUTOMATIC",
        triggerArea: "gallery_video",
        triggerReason: "gallery_video_on_error",
        sourceAppletPackageName: "com.example",
        sourceAppletName: "Example",
      },
      expectedBehavior: "Video should play.",
      actualBehavior: "Video failed.",
      systemPriority: "high",
      dedupeKey: "gallery|video",
      dedupeWindowMs: 1234,
      screenshots: [{uri: "file:///tmp/shot.jpg"} as never],
    })

    expect(toolkit.reports.submit).toHaveBeenCalledWith({
      kind: "automatic",
      trigger: {
        type: "automatic",
        area: "gallery_video",
        reason: "gallery_video_on_error",
        sourceAppletPackageName: "com.example",
        sourceAppletName: "Example",
      },
      report: {
        expectedBehavior: "Video should play.",
        actualBehavior: "Video failed.",
        systemPriority: "high",
      },
      screenshots: [{uri: "file:///tmp/shot.jpg"}],
      dedupeKey: "gallery|video",
      dedupeWindowMs: 1234,
    })
    expect(result).toEqual({status: "filed", reportId: "rep_1"})
  })

  it("defaults automatic reports to medium system priority", async () => {
    ;(toolkit.reports.submit as jest.Mock).mockResolvedValue({
      status: "submitted",
      reportId: "rep_2",
      reportStatus: "ready",
      created: true,
    })

    await submitAutomaticBugReport({
      categorization: {
        submissionMode: "USER_INITIATED",
        triggerArea: "pairing",
        triggerReason: "timeout",
      },
      expectedBehavior: "Connect.",
      actualBehavior: "Timed out.",
      dedupeKey: "pairing|timeout",
    })

    expect(toolkit.reports.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "automatic",
        trigger: {
          type: "automatic",
          area: "pairing",
          reason: "timeout",
        },
        report: {
          expectedBehavior: "Connect.",
          actualBehavior: "Timed out.",
          systemPriority: "medium",
        },
      }),
    )
  })

  it("passes through toolkit duplicate skips", async () => {
    ;(toolkit.reports.submit as jest.Mock).mockResolvedValue({
      status: "skipped",
      reason: "duplicate_within_window",
    })

    await expect(
      submitAutomaticBugReport({
        categorization: {
          submissionMode: "AUTOMATIC",
          triggerArea: "pairing",
          triggerReason: "timeout",
        },
        expectedBehavior: "Connect.",
        actualBehavior: "Timed out.",
        systemPriority: "medium",
        dedupeKey: "pairing|timeout",
      }),
    ).resolves.toEqual({status: "skipped", reason: "duplicate_within_window"})
  })
})
