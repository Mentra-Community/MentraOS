import {toolkit} from "@mentra/island"
import {submitAutomaticBugIncident} from "./automaticBugReport"

jest.mock("@mentra/island", () => ({
  toolkit: {
    incidents: {
      fileAutomatic: jest.fn(),
    },
  },
}))

describe("submitAutomaticBugIncident", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("builds trigger/report inputs and delegates automatic filing to toolkit", async () => {
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
      systemPriority: "high",
      dedupeKey: "gallery|video",
      dedupeWindowMs: 1234,
      screenshots: [{uri: "file:///tmp/shot.jpg"} as never],
    })

    expect(toolkit.incidents.fileAutomatic).toHaveBeenCalledWith({
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
    expect(result).toEqual({status: "filed", incidentId: "inc_1"})
  })

  it("defaults automatic incidents to medium system priority", async () => {
    ;(toolkit.incidents.fileAutomatic as jest.Mock).mockResolvedValue({status: "filed", incidentId: "inc_2"})

    await submitAutomaticBugIncident({
      categorization: {
        submissionMode: "USER_INITIATED",
        triggerArea: "pairing",
        triggerReason: "timeout",
      },
      expectedBehavior: "Connect.",
      actualBehavior: "Timed out.",
      dedupeKey: "pairing|timeout",
    })

    expect(toolkit.incidents.fileAutomatic).toHaveBeenCalledWith(
      expect.objectContaining({
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
        systemPriority: "medium",
        dedupeKey: "pairing|timeout",
      }),
    ).resolves.toEqual({status: "skipped", reason: "duplicate_within_window"})
  })
})
