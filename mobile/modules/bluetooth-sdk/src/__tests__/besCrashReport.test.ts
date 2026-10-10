import type {BesCrashDetectedEvent, BluetoothSdkEventMap} from "../BluetoothSdk.types"
import type {BluetoothSdkInternalModule} from "../_private/BluetoothSdkModule"

const mockNative: Record<string, jest.Mock | undefined> = {}

jest.mock("expo", () => ({
  NativeModule: class {},
  requireNativeModule: () => mockNative,
}))

function resetNative(): void {
  for (const key of Object.keys(mockNative)) delete mockNative[key]
  for (const name of [
    "getGlassesStatus",
    "getBluetoothStatus",
    "getDefaultDevice",
    "setMicState",
    "displayText",
    "connectDefault",
    "stopScan",
    "requestPhoto",
    "warmUpCamera",
  ]) {
    mockNative[name] = jest.fn()
  }
  mockNative.addListener = jest.fn(() => ({remove: jest.fn()}))
  mockNative.sendBesCrashReported = jest.fn(() => Promise.resolve())
}

function loadPrivateModule(): BluetoothSdkInternalModule {
  let loaded: BluetoothSdkInternalModule | undefined
  jest.isolateModules(() => {
    loaded = jest.requireActual<typeof import("../_private/BluetoothSdkModule")>("../_private/BluetoothSdkModule").default
  })
  return loaded!
}

function loadPublicSdk() {
  let loaded: typeof import("../index") | undefined
  jest.isolateModules(() => {
    loaded = jest.requireActual<typeof import("../index")>("../index")
  })
  return loaded!.BluetoothSdk
}

const detected: BesCrashDetectedEvent = {
  type: "bes_crash_detected",
  incidentKey: "ML395018B-dump-0000002a-1f2e3d4c",
  reason: "bes_crash",
  state: "STORED",
  reportId: null,
  summary: {
    attribution: "match",
    dumpId: "0000002a-1f2e3d4c",
    bootId: "9f3a0c1b2d4e5f60",
    resetHw: 0,
    resetSw: 0,
    crashUnixMs: 1760000000000,
    coveredFromMs: 1759998200000,
    coveredToMs: 1760000000000,
    traceGaps: 0,
    truncated: false,
    torn: false,
    tailCaptured: true,
    dumpGap: false,
    evictedCount: 0,
    recentEvictions: [],
  },
}

describe("bes_crash_detected event", () => {
  beforeEach(() => {
    resetNative()
    jest.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  it("is typed as the glasses message in the public event map", () => {
    const payload: BluetoothSdkEventMap["bes_crash_detected"] = detected
    expect(payload.summary.attribution).toBe("match")
  })

  it("is allowlisted for public addListener and passes the native payload through unchanged", () => {
    const BluetoothSdk = loadPublicSdk()
    const listener = jest.fn()
    BluetoothSdk.addListener("bes_crash_detected", listener)

    const call = mockNative.addListener!.mock.calls.find(([name]) => name === "bes_crash_detected")
    expect(call).toBeDefined()
    const nativeListener = call![1] as (event: BesCrashDetectedEvent) => void
    nativeListener(detected)
    expect(listener).toHaveBeenCalledWith(detected)
  })
})

describe("sendBesCrashReported", () => {
  beforeEach(() => {
    resetNative()
    jest.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => jest.restoreAllMocks())

  it("forwards incidentKey and reportId and resolves on the native ack", async () => {
    const nativeCall = mockNative.sendBesCrashReported!
    const sdk = loadPrivateModule()
    await expect(sdk.sendBesCrashReported("ML395018B-dump-0000002a-1f2e3d4c", "rep_1")).resolves.toBeUndefined()
    expect(nativeCall).toHaveBeenCalledWith("ML395018B-dump-0000002a-1f2e3d4c", "rep_1")
  })

  it("preserves a native rejection such as ok:false or timeout", async () => {
    const error = Object.assign(new Error("Glasses rejected bes_crash_reported for k: unknown_incident"), {
      code: "bes_crash_report_rejected",
    })
    mockNative.sendBesCrashReported!.mockRejectedValue(error)
    const sdk = loadPrivateModule()
    await expect(sdk.sendBesCrashReported("k", "rep_1")).rejects.toBe(error)
  })

  it("rejects clearly on a native build without the method", async () => {
    delete mockNative.sendBesCrashReported
    const sdk = loadPrivateModule()
    await expect(sdk.sendBesCrashReported("k", "rep_1")).rejects.toThrow(
      "BluetoothSdk.sendBesCrashReported is not available in this native build",
    )
  })

  it("is not part of the public SDK object", () => {
    const BluetoothSdk = loadPublicSdk() as unknown as Record<string, unknown>
    expect(BluetoothSdk.sendBesCrashReported).toBeUndefined()
  })
})
