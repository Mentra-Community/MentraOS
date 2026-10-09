import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

import {reports, submitAutomaticReport} from "../../../modules/engine/src/facades/reports"
import {cloudClientService} from "../../../modules/engine/src/services/CloudClientService"
import {useGlassesStore} from "../../../modules/engine/src/stores/glasses"
import {logBuffer} from "../../../modules/engine/src/utils/devLogging"

jest.mock("../../../modules/engine/src/services/CloudClientService", () => ({
  cloudClientService: {
    core: {
      reports: {
        submit: jest.fn(async () => ({reportId: "rep_delivery", status: "collecting"})),
        addLogs: jest.fn(async () => ({stored: 1})),
        updateLogCollection: jest.fn(async () => {}),
        complete: jest.fn(async () => ({status: "ready"})),
      },
    },
    hasCore: () => true,
    getCoreUrl: () => "https://core.example",
    syncCoreTokenToBluetooth: jest.fn(async () => "unused-token"),
  },
}))

jest.mock("../../../modules/engine/src/utils/diagnosticContext", () => ({
  collectDiagnosticContext: async () => ({}),
}))

jest.mock("../../../modules/engine/src/utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  },
}))

const input = {
  kind: "automatic" as const,
  trigger: {type: "automatic" as const, source: "system", reason: "test"},
  report: {actualBehavior: "Test report", systemPriority: "medium" as const},
}
const addLogs = jest.mocked(cloudClientService.core.reports.addLogs)
const update = jest.mocked(cloudClientService.core.reports.updateLogCollection)
const sync = jest.mocked(cloudClientService.syncCoreTokenToBluetooth)
const send = jest.mocked(BluetoothSdk.sendIncidentId)

function connected() {
  useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
}

describe("report source collection and phone delivery diagnostics", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    logBuffer.clear()
    useGlassesStore.getState().reset()
    addLogs.mockResolvedValue({stored: 1})
    update.mockResolvedValue(undefined)
    sync.mockResolvedValue("unused-token")
    send.mockResolvedValue(undefined)
  })

  afterEach(() => jest.useRealTimers())

  it("keeps the original phone snapshot and captures native logs during dispatch separately", async () => {
    connected()
    logBuffer.append({level: "info", source: "console", message: "Before report"})
    send.mockImplementationOnce(async () => {
      logBuffer.append({level: "info", source: "native:ios", message: "Incident ID queued"})
    })

    await expect(submitAutomaticReport(input)).resolves.toMatchObject({status: "submitted"})

    expect(send).toHaveBeenCalledWith("rep_delivery", "https://core.example")
    expect(update.mock.calls).toEqual([
      ["rep_delivery", "glasses", {state: "requested", reason: "local_sdk_dispatch_completed"}],
      ["rep_delivery", "glasses_firmware", {state: "requested", reason: "local_sdk_dispatch_completed"}],
    ])
    expect(addLogs.mock.calls[0]).toEqual([
      "rep_delivery",
      "phone",
      [expect.objectContaining({message: "Before report"})],
    ])
    expect(addLogs.mock.calls[1]).toEqual([
      "rep_delivery",
      "phone_delivery",
      [
        expect.objectContaining({message: "Incident ID queued"}),
        expect.objectContaining({
          message: "Report rep_delivery: glasses log notification requested (local_sdk_dispatch_completed)",
        }),
      ],
    ])
  })

  it("marks disconnected glasses sources unavailable without invoking the SDK", async () => {
    await submitAutomaticReport(input)

    expect(sync).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(update.mock.calls.map(([, source, outcome]) => [source, outcome])).toEqual([
      ["glasses", {state: "unavailable", reason: "glasses_disconnected"}],
      ["glasses_firmware", {state: "unavailable", reason: "glasses_disconnected"}],
    ])
  })

  it("checks the actual connection again after token synchronization", async () => {
    connected()
    sync.mockImplementationOnce(async () => {
      useGlassesStore.getState().reset()
      return "unused-token"
    })

    await submitAutomaticReport(input)

    expect(send).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith("rep_delivery", "glasses", {
      state: "unavailable",
      reason: "glasses_disconnected",
    })
  })

  it.each(["core_token_sync", "incident_dispatch"])(
    "records sanitized %s failure without leaking native errors",
    async (stage) => {
      connected()
      const privateError = new Error("Authorization: Bearer PRIVATE_SENTINEL")
      if (stage === "core_token_sync") sync.mockRejectedValueOnce(privateError)
      else send.mockRejectedValueOnce(privateError)

      await submitAutomaticReport(input)

      expect(update).toHaveBeenCalledWith("rep_delivery", "glasses_firmware", {
        state: "failed",
        reason: `${stage}_failed`,
      })
      expect(JSON.stringify([update.mock.calls, addLogs.mock.calls])).not.toContain("PRIVATE_SENTINEL")
    },
  )

  it("bounds local notification and never sends after an expired token synchronization", async () => {
    jest.useFakeTimers()
    connected()
    let finishSync!: (token: string) => void
    sync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSync = resolve
        }),
    )

    const pending = submitAutomaticReport(input)
    await jest.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toMatchObject({status: "submitted"})
    expect(update).toHaveBeenCalledWith("rep_delivery", "glasses", {
      state: "failed",
      reason: "incident_dispatch_timeout",
    })
    finishSync("unused-token")
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it("retains timeout diagnostics when an already invoked SDK call rejects later", async () => {
    jest.useFakeTimers()
    connected()
    let rejectSend!: (error: Error) => void
    send.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSend = reject
        }),
    )

    const pending = submitAutomaticReport(input)
    await jest.advanceTimersByTimeAsync(10_000)
    await pending
    rejectSend(new Error("PRIVATE_SENTINEL"))
    await Promise.resolve()

    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls.every(([, , outcome]) => outcome.state === "failed")).toBe(true)
    expect(JSON.stringify(addLogs.mock.calls)).not.toContain("PRIVATE_SENTINEL")
    expect(jest.getTimerCount()).toBe(0)
  })

  it("records a failed initial phone upload and still preserves dispatch diagnostics", async () => {
    addLogs.mockRejectedValueOnce(new Error("PRIVATE_SENTINEL"))

    await submitAutomaticReport(input)

    expect(update).toHaveBeenCalledWith("rep_delivery", "phone", {
      state: "failed",
      reason: "phone_log_upload_failed",
    })
    expect(addLogs).toHaveBeenLastCalledWith("rep_delivery", "phone_delivery", expect.any(Array))
  })

  it("keeps failed status storage in the bounded diagnostic delta", async () => {
    update.mockRejectedValueOnce(new Error("PRIVATE_SENTINEL"))

    await submitAutomaticReport(input)

    const delivery = addLogs.mock.calls[1][2]
    expect(delivery).toContainEqual(
      expect.objectContaining({
        message: "Report rep_delivery: glasses collection status could not be stored",
      }),
    )
    expect(JSON.stringify(delivery)).not.toContain("PRIVATE_SENTINEL")
  })

  it("reports truncation while retaining the report-correlated outcome in a large dispatch burst", async () => {
    connected()
    send.mockImplementationOnce(async () => {
      for (let index = 0; index < 600; index++) {
        logBuffer.append({level: "info", source: "native:android", message: `Dispatch log ${index}`})
      }
    })

    await submitAutomaticReport(input)

    const entries = addLogs.mock.calls[1][2]
    expect(entries).toHaveLength(500)
    expect(entries).toContainEqual(expect.objectContaining({
      message: "Report rep_delivery: glasses log notification requested (local_sdk_dispatch_completed)",
    }))
    expect(entries.at(-1)?.message).toBe("Report rep_delivery: phone delivery logs omitted 102 earlier entries")
  })

  it("stores an empty original phone snapshot instead of leaving its source ambiguously requested", async () => {
    await submitAutomaticReport(input)

    expect(addLogs).toHaveBeenNthCalledWith(1, "rep_delivery", "phone", [])
    expect(update.mock.calls.some(([, source]) => source === "phone")).toBe(false)
  })

  it("keeps feature feedback outside device log collection", async () => {
    connected()

    await reports.submit({kind: "feedback", feedback: "Add a setting"})

    expect(addLogs).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
