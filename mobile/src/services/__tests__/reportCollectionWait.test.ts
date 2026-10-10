import {reports} from "../../../modules/engine/src/facades/reports"
import {cloudClientService} from "../../../modules/engine/src/services/CloudClientService"

jest.mock("../../../modules/engine/src/services/CloudClientService", () => ({
  cloudClientService: {
    hasCore: jest.fn(() => true),
    core: {reports: {getLogCollection: jest.fn()}},
  },
}))
jest.mock("../../../modules/engine/src/utils/diagnosticContext", () => ({collectDiagnosticContext: jest.fn()}))
jest.mock("../../../modules/engine/src/utils/timers", () => ({
  BgTimer: {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  },
}))

const read = jest.mocked(cloudClientService.core.reports.getLogCollection)
const requested = {
  state: "requested" as const,
  requestedAt: "2026-10-09T00:00:00.000Z",
  deadlineAt: "2026-10-09T00:04:00.000Z",
}
const received = (artifactId: string) => ({...requested, state: "received" as const, artifactId, entryCount: 0})
const snapshot = (logCollection: Awaited<ReturnType<typeof read>>["logCollection"]) => ({
  reportId: "rep_test",
  logCollection,
})

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  jest.mocked(cloudClientService.hasCore).mockReturnValue(true)
})
afterEach(() => jest.useRealTimers())

it("holds completion for delayed glasses and BES receipts while ignoring server collection", async () => {
  read
    .mockResolvedValueOnce(snapshot({phone: received("art_phone"), glasses: requested, glasses_firmware: requested}))
    .mockResolvedValueOnce(
      snapshot({phone: received("art_phone"), glasses: received("art_glasses"), glasses_firmware: requested}),
    )
    .mockResolvedValueOnce(
      snapshot({
        phone: received("art_phone"),
        glasses: received("art_glasses"),
        glasses_firmware: received("art_bes"),
        cloud: requested,
      }),
    )
  const pending = reports.waitForCollection("rep_test", {sources: ["phone", "glasses", "glasses_firmware"]})
  let complete = false
  void pending.then(() => {
    complete = true
  })
  await jest.advanceTimersByTimeAsync(500)
  expect(complete).toBe(false)
  expect(read).toHaveBeenCalledTimes(2)
  await jest.advanceTimersByTimeAsync(500)
  await expect(pending).resolves.toMatchObject({
    state: "complete",
    logCollection: {glasses_firmware: {artifactId: "art_bes", entryCount: 0}},
  })
  expect(jest.getTimerCount()).toBe(0)
})

it("finishes immediately for recorded disconnection or failure outcomes", async () => {
  read.mockResolvedValue(
    snapshot({
      phone: received("art_phone"),
      glasses: {...requested, state: "unavailable", reason: "glasses_disconnected"},
      glasses_firmware: {...requested, state: "failed", reason: "incident_dispatch_failed"},
    }),
  )
  await expect(
    reports.waitForCollection("rep_test", {sources: ["phone", "glasses", "glasses_firmware"]}),
  ).resolves.toMatchObject({
    state: "complete",
    logCollection: {glasses: {state: "unavailable"}, glasses_firmware: {state: "failed"}},
  })
  expect(read).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})

it("bounds the whole wait and aborts an unanswered status request", async () => {
  let signal: AbortSignal | undefined
  read.mockImplementation((_reportId, currentSignal) => {
    signal = currentSignal
    return new Promise(() => {})
  })
  const pending = reports.waitForCollection("rep_test", {sources: ["glasses"], timeoutMs: 1000})
  await jest.advanceTimersByTimeAsync(1000)
  await expect(pending).resolves.toEqual({reportId: "rep_test", state: "timed-out", logCollection: {}})
  expect(signal?.aborted).toBe(true)
  expect(read).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})

it("retains last observed pending sources after timeout without inventing receipts", async () => {
  read.mockResolvedValue(snapshot({glasses: received("art_glasses"), glasses_firmware: requested}))
  const pending = reports.waitForCollection("rep_test", {sources: ["glasses", "glasses_firmware"], timeoutMs: 1000})
  await jest.advanceTimersByTimeAsync(1000)
  await expect(pending).resolves.toEqual({
    reportId: "rep_test",
    state: "timed-out",
    logCollection: {
      glasses: received("art_glasses"),
      glasses_firmware: requested,
    },
  })
  expect(jest.getTimerCount()).toBe(0)
})

it("does not accept a received state without an artifact ID", async () => {
  read.mockResolvedValue(snapshot({glasses: {...requested, state: "received"}}))
  const pending = reports.waitForCollection("rep_test", {sources: ["glasses"], timeoutMs: 1000})
  await jest.advanceTimersByTimeAsync(1000)
  await expect(pending).resolves.toMatchObject({state: "timed-out"})
})

it("keeps a missing requested source pending instead of treating it as unavailable", async () => {
  read.mockResolvedValue(snapshot({glasses: received("art_glasses")}))
  const pending = reports.waitForCollection("rep_test", {sources: ["glasses", "glasses_firmware"], timeoutMs: 1000})
  await jest.advanceTimersByTimeAsync(1000)
  await expect(pending).resolves.toEqual({
    reportId: "rep_test",
    state: "timed-out",
    logCollection: {glasses: received("art_glasses")},
  })
})

it("retains actual receipts when a later read fails", async () => {
  read
    .mockResolvedValueOnce(snapshot({glasses: received("art_glasses"), glasses_firmware: requested}))
    .mockRejectedValueOnce(new Error("read failed"))
  const pending = reports.waitForCollection("rep_test", {sources: ["glasses", "glasses_firmware"]})
  await jest.advanceTimersByTimeAsync(500)
  await expect(pending).resolves.toEqual({
    reportId: "rep_test",
    state: "unavailable",
    logCollection: {
      glasses: received("art_glasses"),
      glasses_firmware: requested,
    },
  })
  expect(jest.getTimerCount()).toBe(0)
})

it("respects a caller's longer collection deadline", async () => {
  read.mockImplementation(() => new Promise(() => {}))
  const pending = reports.waitForCollection("rep_test", {sources: ["glasses"], timeoutMs: 60_000})
  let settled = false
  void pending.then(() => {
    settled = true
  })
  await jest.advanceTimersByTimeAsync(20_000)
  expect(settled).toBe(false)
  await jest.advanceTimersByTimeAsync(40_000)
  await expect(pending).resolves.toMatchObject({state: "timed-out"})
  expect(jest.getTimerCount()).toBe(0)
})

it.each(["read-failure", "wrong-report"])(
  "returns unavailable after %s without exposing transport details",
  async (cause) => {
    if (cause === "read-failure") read.mockRejectedValue(new Error("Authorization: Bearer PRIVATE_TOKEN"))
    else read.mockResolvedValue({...snapshot({glasses: received("art_foreign")}), reportId: "rep_other"})
    const result = await reports.waitForCollection("rep_test", {sources: ["glasses"]})
    expect(result).toEqual({reportId: "rep_test", state: "unavailable", logCollection: {}})
    expect(JSON.stringify(result)).not.toContain("PRIVATE_TOKEN")
    expect(jest.getTimerCount()).toBe(0)
  },
)

it("does not query reports without Core or an exact report ID", async () => {
  jest.mocked(cloudClientService.hasCore).mockReturnValue(false)
  await expect(reports.waitForCollection("rep_test", {sources: ["glasses"]})).resolves.toMatchObject({
    state: "unavailable",
  })
  jest.mocked(cloudClientService.hasCore).mockReturnValue(true)
  await expect(reports.waitForCollection("../reports", {sources: ["glasses"]})).resolves.toMatchObject({
    state: "unavailable",
  })
  expect(read).not.toHaveBeenCalled()
})
