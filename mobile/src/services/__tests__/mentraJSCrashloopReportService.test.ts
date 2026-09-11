import {waitFor} from "@testing-library/react-native"

import {
  startMentraJSCrashloopReportService,
  stopMentraJSCrashloopReportService,
  submitMentraJSCrashloopReport,
} from "../../../modules/engine/src/services/MentraJSCrashloopReportService"
import {islandNotifications} from "../../../modules/engine/src/services/NotificationsEmitter"
import {submitAutomaticReport} from "../../../modules/engine/src/facades/reports"

let mockApps: Array<{packageName: string; name: string}> = []
let mockEngine: {router: {logRing: {snapshot: jest.Mock}}} | null = null

jest.mock("../../../modules/engine/src/facades/reports", () => ({
  submitAutomaticReport: jest.fn(),
}))

jest.mock("../../../modules/engine/src/stores/apps", () => ({
  useAppStatusStore: {
    getState: jest.fn(() => ({apps: mockApps})),
  },
}))

jest.mock("../../../modules/engine/src/services/MiniappEngine", () => ({
  getMiniappEngine: jest.fn(() => mockEngine),
}))

describe("MentraJSCrashloopReportService", () => {
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    mockApps = [{packageName: "com.example.app", name: "Example App"}]
    mockEngine = {
      router: {
        logRing: {
          snapshot: jest.fn(() => ["line 1", "line 2"]),
        },
      },
    }
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
    stopMentraJSCrashloopReportService()
    jest.restoreAllMocks()
  })

  it("files crashloop-disabled reports through island internals", async () => {
    const result = await submitMentraJSCrashloopReport({
      packageName: "com.example.app",
      reason: "too_many_crashes",
      lastLogLines: ["line 1", "line 2"],
    })

    expect(submitAutomaticReport).toHaveBeenCalledWith({
      kind: "automatic",
      trigger: {
        type: "automatic",
        source: "miniapp_crashloop",
        reason: "mentrajs_crashloop_disabled",
        sourceAppletPackageName: "com.example.app",
        sourceAppletName: "Example App",
      },
      report: {
        expectedBehavior: "Example App should run without crashing.",
        actualBehavior: JSON.stringify({reason: "too_many_crashes", lastLogLines: ["line 1", "line 2"]}, null, 2),
        systemPriority: "critical",
      },
      throttleKey: "mentrajs_crashloop:com.example.app",
    })
    expect(result).toEqual({status: "filed", reportId: "report-1"})
    expect(logSpy).toHaveBeenCalledWith("[MentraJSCrashloopReport] Report filed:", "report-1")
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it("subscribes to island crashloop notifications and removes the listener when stopped", async () => {
    startMentraJSCrashloopReportService()

    islandNotifications.emit({
      kind: "miniapp_crashloop",
      packageName: "com.example.app",
      reason: "too_many_crashes",
      timestamp: 123,
    })

    await waitFor(() => {
      expect(submitAutomaticReport).toHaveBeenCalledWith(
        expect.objectContaining({
          throttleKey: "mentrajs_crashloop:com.example.app",
        }),
      )
    })
    expect(mockEngine?.router.logRing.snapshot).toHaveBeenCalledWith("com.example.app")

    ;(submitAutomaticReport as jest.Mock).mockClear()
    stopMentraJSCrashloopReportService()
    islandNotifications.emit({
      kind: "miniapp_crashloop",
      packageName: "com.example.app",
      reason: "too_many_crashes",
      timestamp: 124,
    })
    await Promise.resolve()
    expect(submitAutomaticReport).not.toHaveBeenCalled()
  })
})
