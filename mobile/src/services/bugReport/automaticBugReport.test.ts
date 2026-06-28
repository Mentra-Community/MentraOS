import {toolkit} from "@mentra/island"
import {logBuffer} from "@/utils/dev/logging"
import {buildBugReportFeedbackDataForBug, buildBugReportPhoneState} from "./bugReportIncident"
import {submitAutomaticBugIncident} from "./automaticBugReport"

jest.mock("@mentra/island", () => ({
  toolkit: {
    incidents: {
      fileAutomatic: jest.fn(),
    },
  },
}))

jest.mock("@/utils/dev/logging", () => ({
  logBuffer: {
    getRecentLogs: jest.fn(),
  },
}))

jest.mock("./bugReportIncident", () => ({
  buildBugReportFeedbackDataForBug: jest.fn(),
  buildBugReportPhoneState: jest.fn(),
}))

describe("submitAutomaticBugIncident", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(buildBugReportFeedbackDataForBug as jest.Mock).mockResolvedValue({type: "bug"})
    ;(buildBugReportPhoneState as jest.Mock).mockReturnValue({phone: "state"})
    ;(logBuffer.getRecentLogs as jest.Mock).mockReturnValue([{timestamp: 1, level: "info", message: "hello"}])
  })

  it("builds diagnostics and delegates automatic filing to toolkit", async () => {
    ;(toolkit.incidents.fileAutomatic as jest.Mock).mockResolvedValue({status: "filed", incidentId: "inc_1"})

    const result = await submitAutomaticBugIncident({
      categorization: {
        submissionMode: "AUTOMATIC",
        triggerArea: "gallery_video",
        triggerReason: "gallery_video_on_error",
        sourceAppletPackageName: "com.example",
        sourceAppletName: "Example",
      },
      expectedBehavior: "Video should play.",
      actualBehavior: "Video failed.",
      severityRating: 5,
      dedupeKey: "gallery|video",
      dedupeWindowMs: 1234,
      screenshots: [{uri: "file:///tmp/shot.jpg"} as never],
    })

    expect(buildBugReportFeedbackDataForBug).toHaveBeenCalledWith({
      expectedBehavior: "Video should play.",
      actualBehavior: "Video failed.",
      severityRating: 5,
      contactEmail: undefined,
      extraFeedbackFields: {
        submissionMode: "AUTOMATIC",
        triggerArea: "gallery_video",
        triggerReason: "gallery_video_on_error",
        sourceAppletPackageName: "com.example",
        sourceAppletName: "Example",
      },
    })
    expect(toolkit.incidents.fileAutomatic).toHaveBeenCalledWith({
      feedbackData: {type: "bug"},
      phoneState: {phone: "state"},
      logs: [{timestamp: 1, level: "info", message: "hello"}],
      screenshots: [{uri: "file:///tmp/shot.jpg"}],
      dedupeKey: "gallery|video",
      dedupeWindowMs: 1234,
    })
    expect(result).toEqual({status: "filed", incidentId: "inc_1"})
  })

  it("passes through toolkit duplicate skips", async () => {
    ;(toolkit.incidents.fileAutomatic as jest.Mock).mockResolvedValue({
      status: "skipped",
      reason: "duplicate_within_window",
    })

    await expect(
      submitAutomaticBugIncident({
        categorization: {
          submissionMode: "AUTOMATIC",
          triggerArea: "pairing",
          triggerReason: "timeout",
        },
        expectedBehavior: "Connect.",
        actualBehavior: "Timed out.",
        severityRating: 4,
        dedupeKey: "pairing|timeout",
      }),
    ).resolves.toEqual({status: "skipped", reason: "duplicate_within_window"})
  })
})
