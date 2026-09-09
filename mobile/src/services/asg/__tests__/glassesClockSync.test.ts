import BluetoothSdk from "@mentra/bluetooth-sdk"

// glassesClockSync + gallerySyncClock moved into island; this jest test imports by path.
import {detectClockSkew} from "../../../../modules/engine/src/services/gallerySyncClock"
import {
  fixGlassesClockIfSkewed,
  handleOtaClockSkewFromGlasses,
  maybeFixGlassesClockFromVersionInfo,
  resetOtaClockFixCooldownForTests,
} from "../../../../modules/engine/src/services/glassesClockSync"

jest.mock("@mentra/bluetooth-sdk", () => ({
  __esModule: true,
  default: {
    setSystemTime: jest.fn().mockResolvedValue(undefined),
    startOtaUpdate: jest.fn().mockResolvedValue({type: "ota_start_ack", timestamp: 1_700_000_000_000}),
  },
  sdkPinnedOtaManifestUrl: () =>
    "https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota/bluetooth-sdk-0.0.0-test-version.json",
}))

jest.mock("../../../../modules/engine/src/utils/timers", () => ({
  BgTimer: {
    setTimeout: (fn: () => void) => {
      fn()
      return 0
    },
  },
}))

const mockSetSystemTime = BluetoothSdk.setSystemTime as jest.Mock
const mockStartOta = BluetoothSdk.startOtaUpdate as jest.Mock

jest.mock("../../../../modules/engine/src/stores/glasses", () => ({
  useGlassesStore: {
    getState: jest.fn(() => ({
      buildNumber: "100000",
      otaVersionUrl: "https://example.com/live_version.json",
      wifi: {state: "connected"},
    })),
  },
}))

describe("glassesClockSync", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resetOtaClockFixCooldownForTests()
    jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("fixGlassesClockIfSkewed sets time when wall clock drifts", async () => {
    const glassesTime = Date.now() - 365 * 24 * 60 * 60 * 1000
    const fixed = await fixGlassesClockIfSkewed(glassesTime, 0)
    expect(fixed).toBe(true)
    expect(mockSetSystemTime).toHaveBeenCalledWith(Date.now())
  })

  it("fixGlassesClockIfSkewed is a no-op when clocks agree", async () => {
    const fixed = await fixGlassesClockIfSkewed(Date.now(), 0)
    expect(fixed).toBe(false)
    expect(mockSetSystemTime).not.toHaveBeenCalled()
  })

  it("handleOtaClockSkewFromGlasses fixes and retries on clock_skew", async () => {
    const glassesTime = Date.now() - 365 * 24 * 60 * 60 * 1000
    const fixed = await handleOtaClockSkewFromGlasses("clock_skew", glassesTime)
    expect(fixed).toBe(true)
    expect(mockSetSystemTime).toHaveBeenCalled()
    // The phone owns manifest selection: the retry drives the SDK-pinned manifest URL, not the
    // glasses-reported one (which is only a legacy fallback).
    expect(mockStartOta).toHaveBeenCalledWith(
      "https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota/bluetooth-sdk-0.0.0-test-version.json",
    )
  })

  it("handleOtaClockSkewFromGlasses maps ssl_error with drift to clock fix", async () => {
    const glassesTime = Date.now() - 365 * 24 * 60 * 60 * 1000
    expect(detectClockSkew(Date.now(), glassesTime, 0).skewed).toBe(true)
    const fixed = await handleOtaClockSkewFromGlasses("ssl_error", glassesTime)
    expect(fixed).toBe(true)
    expect(mockStartOta).toHaveBeenCalled()
  })

  it("handleOtaClockSkewFromGlasses ignores ssl_error without glasses time", async () => {
    const fixed = await handleOtaClockSkewFromGlasses("ssl_error")
    expect(fixed).toBe(false)
    expect(mockSetSystemTime).not.toHaveBeenCalled()
    expect(mockStartOta).not.toHaveBeenCalled()
  })

  it("maybeFixGlassesClockFromVersionInfo fixes time without starting OTA", async () => {
    const glassesTime = Date.now() - 365 * 24 * 60 * 60 * 1000
    const fixed = await maybeFixGlassesClockFromVersionInfo(glassesTime)
    expect(fixed).toBe(true)
    expect(mockStartOta).not.toHaveBeenCalled()
  })

  it("handleOtaClockSkewFromGlasses coalesces concurrent calls into one fix", async () => {
    // Regression for cubic P2: glasses can emit two clock_skew events back-to-back during BLE
    // handshake. Without coalescing, both calls would pass the cooldown guard and double-fix.
    const glassesTime = Date.now() - 365 * 24 * 60 * 60 * 1000
    const [a, b] = await Promise.all([
      handleOtaClockSkewFromGlasses("clock_skew", glassesTime),
      handleOtaClockSkewFromGlasses("clock_skew", glassesTime),
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(mockSetSystemTime).toHaveBeenCalledTimes(1)
    expect(mockStartOta).toHaveBeenCalledTimes(1)
  })
})
