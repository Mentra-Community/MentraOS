import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

import {submitAutomaticReport} from "../../../modules/engine/src/facades/reports"
import {cloudClientService} from "../../../modules/engine/src/services/CloudClientService"
import {logBuffer} from "../../../modules/engine/src/utils/devLogging"

jest.mock("../../../modules/engine/src/services/CloudClientService", () => ({
  cloudClientService: {
    core: {
      reports: {
        submit: jest.fn(),
        addLogs: jest.fn(),
        addScreenshots: jest.fn(),
        complete: jest.fn(),
      },
    },
    getCoreUrl: jest.fn(() => "https://core.example"),
    syncCoreTokenToBluetooth: jest.fn(),
  },
}))

jest.mock("../../../modules/engine/src/utils/diagnosticContext", () => ({
  collectDiagnosticContext: jest.fn(async (context) => context ?? {}),
}))

jest.mock("../../../modules/engine/src/utils/devLogging", () => ({
  logBuffer: {
    getRecentLogs: jest.fn(() => []),
  },
}))

const submitMock = cloudClientService.core.reports.submit as jest.Mock
const addLogsMock = cloudClientService.core.reports.addLogs as jest.Mock
const completeMock = cloudClientService.core.reports.complete as jest.Mock
const getRecentLogsMock = logBuffer.getRecentLogs as jest.Mock
const getNativeLogsMock = BluetoothSdk.getNativeLogs as jest.Mock

const automaticInput = (throttleKey: string) => ({
  kind: "automatic" as const,
  trigger: {type: "automatic" as const, source: "system", reason: "test"},
  report: {
    actualBehavior: "Test report",
    systemPriority: "medium" as const,
  },
  throttleKey,
  throttleWindowMs: 60_000,
})

describe("reports facade automatic throttling", () => {
  beforeEach(() => {
    submitMock.mockReset()
    addLogsMock.mockReset()
    completeMock.mockReset()
    getRecentLogsMock.mockReset()
    getNativeLogsMock.mockReset()
    addLogsMock.mockResolvedValue({stored: 1})
    completeMock.mockResolvedValue({status: "complete"})
    getRecentLogsMock.mockReturnValue([])
    getNativeLogsMock.mockResolvedValue([])
  })

  it("merges React Native and native Android logs into the phone artifact", async () => {
    getRecentLogsMock.mockReturnValue([
      {timestamp: 200, level: "info", message: "CORE: bridge event", source: "console"},
    ])
    getNativeLogsMock.mockResolvedValue([
      {
        timestamp: 100,
        level: "warn",
        message: "Requested MTU size",
        source: "android-logcat",
        metadata: {tag: "MentraLive", pid: 12, tid: 34, priority: "W"},
      },
    ])
    submitMock.mockResolvedValueOnce({reportId: "report-native-logs", status: "open"})

    await expect(submitAutomaticReport(automaticInput("native-logs"))).resolves.toMatchObject({
      status: "submitted",
      reportId: "report-native-logs",
    })

    expect(addLogsMock).toHaveBeenCalledWith("report-native-logs", "phone", [
      expect.objectContaining({timestamp: 100, source: "android-logcat", message: "Requested MTU size"}),
      expect.objectContaining({timestamp: 200, source: "console", message: "CORE: bridge event"}),
    ])
  })

  it("still uploads React Native logs when native collection fails", async () => {
    getRecentLogsMock.mockReturnValue([{timestamp: 100, level: "info", message: "JS survived", source: "console"}])
    getNativeLogsMock.mockRejectedValue(new Error("logcat unavailable"))
    submitMock.mockResolvedValueOnce({reportId: "report-native-failure", status: "open"})

    await expect(submitAutomaticReport(automaticInput("native-failure"))).resolves.toMatchObject({
      status: "submitted",
      reportId: "report-native-failure",
    })

    expect(addLogsMock).toHaveBeenCalledWith(
      "report-native-failure",
      "phone",
      expect.arrayContaining([
        expect.objectContaining({message: "JS survived", source: "console"}),
        expect.objectContaining({
          message: "Native log collection failed: logcat unavailable",
          source: "report-collector",
        }),
      ]),
    )
  })

  it("does not throttle a later automatic report after Cloud V2 submit fails", async () => {
    const key = `failure-retry-${Date.now()}`
    submitMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({reportId: "report-1", status: "open"})

    await expect(submitAutomaticReport(automaticInput(key))).resolves.toEqual({
      status: "failed",
      error: "network down",
    })
    await expect(submitAutomaticReport(automaticInput(key))).resolves.toEqual({
      status: "submitted",
      reportId: "report-1",
      reportStatus: "complete",
    })

    expect(submitMock).toHaveBeenCalledTimes(2)
  })

  it("throttles repeated automatic reports after Cloud V2 accepts one", async () => {
    const key = `success-throttle-${Date.now()}`
    submitMock.mockResolvedValueOnce({reportId: "report-2", status: "open"})

    await expect(submitAutomaticReport(automaticInput(key))).resolves.toMatchObject({
      status: "submitted",
      reportId: "report-2",
    })
    await expect(submitAutomaticReport(automaticInput(key))).resolves.toEqual({
      status: "skipped",
      reason: "throttled_within_window",
    })

    expect(submitMock).toHaveBeenCalledTimes(1)
  })

  it("does not throttle a later automatic report after log upload fails", async () => {
    const key = `artifact-retry-${Date.now()}`
    getRecentLogsMock.mockReturnValue([{timestamp: 1, level: "info", message: "diagnostic"}])
    submitMock
      .mockResolvedValueOnce({reportId: "report-log-1", status: "open"})
      .mockResolvedValueOnce({reportId: "report-log-2", status: "open"})
    addLogsMock.mockRejectedValueOnce(new Error("upload failed")).mockResolvedValueOnce({stored: 1})

    await expect(submitAutomaticReport(automaticInput(key))).resolves.toMatchObject({
      status: "submitted",
      reportId: "report-log-1",
    })
    await expect(submitAutomaticReport(automaticInput(key))).resolves.toMatchObject({
      status: "submitted",
      reportId: "report-log-2",
    })

    expect(submitMock).toHaveBeenCalledTimes(2)
    expect(addLogsMock).toHaveBeenCalledTimes(2)
  })
})
