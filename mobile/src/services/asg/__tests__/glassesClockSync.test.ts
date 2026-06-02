import BluetoothSdk from "@mentra/bluetooth-sdk-internal"

import {detectClockSkew} from "@/services/asg/gallerySyncClock"
import {
  fixGlassesClockIfSkewed,
  handleOtaClockSkewFromGlasses,
  maybeFixGlassesClockFromVersionInfo,
  resetOtaClockFixCooldownForTests,
} from "@/services/asg/glassesClockSync"

jest.mock("@mentra/bluetooth-sdk-internal", () => ({
  __esModule: true,
  default: {
    setSystemTime: jest.fn().mockResolvedValue(undefined),
    retryOtaVersionCheck: jest.fn().mockResolvedValue(undefined),
  },
}))

jest.mock("@mentra/island", () => ({
  BgTimer: {
    setTimeout: (fn: () => void) => {
      fn()
      return 0
    },
  },
}))

const mockSetSystemTime = BluetoothSdk.setSystemTime as jest.Mock
const mockRetryOta = BluetoothSdk.retryOtaVersionCheck as jest.Mock

jest.mock("@/stores/glasses", () => ({
  useGlassesStore: {
    getState: jest.fn(() => ({
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
    expect(mockRetryOta).toHaveBeenCalled()
  })

  it("handleOtaClockSkewFromGlasses maps ssl_error with drift to clock fix", async () => {
    const glassesTime = Date.now() - 365 * 24 * 60 * 60 * 1000
    expect(detectClockSkew(Date.now(), glassesTime, 0).skewed).toBe(true)
    const fixed = await handleOtaClockSkewFromGlasses("ssl_error", glassesTime)
    expect(fixed).toBe(true)
    expect(mockRetryOta).toHaveBeenCalled()
  })

  it("handleOtaClockSkewFromGlasses ignores ssl_error without glasses time", async () => {
    const fixed = await handleOtaClockSkewFromGlasses("ssl_error")
    expect(fixed).toBe(false)
    expect(mockSetSystemTime).not.toHaveBeenCalled()
    expect(mockRetryOta).not.toHaveBeenCalled()
  })

  it("maybeFixGlassesClockFromVersionInfo retries OTA when WiFi connected", async () => {
    const glassesTime = Date.now() - 365 * 24 * 60 * 60 * 1000
    const fixed = await maybeFixGlassesClockFromVersionInfo(glassesTime)
    expect(fixed).toBe(true)
    expect(mockRetryOta).toHaveBeenCalled()
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
    expect(mockRetryOta).toHaveBeenCalledTimes(1)
  })
})
