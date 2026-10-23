import {Platform} from "react-native"
import type {NetworkDiagnostics, NetworkObservation} from "@mentra/bluetooth-sdk/ota-transport"
// Exercise the real Engine service; Jest replaces the public Engine facade.
// eslint-disable-next-line no-restricted-imports
import {waitForOtaInternet} from "../../modules/engine/src/services/OtaInternetRecovery"
import {mentraLocalNetworkMock} from "@/test-utils/mockBluetoothSdk"

const absent: NetworkObservation = {present: false, capabilities: null}
const internet: NetworkObservation = {
  present: true,
  capabilities: {
    wifi: true,
    cellular: false,
    ethernet: false,
    vpn: false,
    internet: true,
    validated: true,
    captivePortal: false,
  },
}
const observation = (overrides: Partial<NetworkDiagnostics> = {}): NetworkDiagnostics => ({
  sampledAtMs: Date.now(),
  processBound: absent,
  activeNetwork: absent,
  glassesLocal: absent,
  processBoundMatchesActive: false,
  processBoundMatchesGlassesLocal: false,
  activeNetworkMatchesGlassesLocal: false,
  ...overrides,
})
const originalPlatform = Platform.OS
beforeEach(() => {
  jest.useFakeTimers()
  Platform.OS = "android"
  mentraLocalNetworkMock.getNetworkDiagnostics.mockReset().mockReturnValue(observation())
})
afterEach(() => {
  Platform.OS = originalPlatform
  mentraLocalNetworkMock.getNetworkDiagnostics.mockReset().mockReturnValue(null)
  jest.useRealTimers()
})

it("holds the final check across the observed ten-second gap, until the returned route validates", async () => {
  const finalCheck = jest.fn()
  const completion = waitForOtaInternet(() => true).then(finalCheck)
  await jest.advanceTimersByTimeAsync(9_750)
  expect(finalCheck).not.toHaveBeenCalled()
  mentraLocalNetworkMock.getNetworkDiagnostics.mockReturnValue(
    observation({
      activeNetwork: {...internet, capabilities: {...internet.capabilities!, validated: false}},
    }),
  )
  await jest.advanceTimersByTimeAsync(250)
  expect(finalCheck).not.toHaveBeenCalled()
  mentraLocalNetworkMock.getNetworkDiagnostics.mockReturnValue(observation({activeNetwork: internet}))
  await jest.advanceTimersByTimeAsync(250)
  await completion
  expect(finalCheck).toHaveBeenCalledWith("ready")
  expect(jest.getTimerCount()).toBe(0)
})

it("does not accept a local hotspot binding even when the default has Internet", async () => {
  const finalCheck = jest.fn()
  mentraLocalNetworkMock.getNetworkDiagnostics.mockReturnValue(
    observation({
      activeNetwork: internet,
      processBound: {...internet, capabilities: {...internet.capabilities!, internet: false, validated: false}},
      glassesLocal: internet,
      processBoundMatchesGlassesLocal: true,
    }),
  )
  const completion = waitForOtaInternet(() => true).then(finalCheck)
  await jest.advanceTimersByTimeAsync(1_000)
  expect(finalCheck).not.toHaveBeenCalled()
  mentraLocalNetworkMock.getNetworkDiagnostics.mockReturnValue(observation({activeNetwork: internet}))
  await jest.advanceTimersByTimeAsync(250)
  await completion
  expect(finalCheck).toHaveBeenCalledWith("ready")
})

it("does not add a delay when the phone retained validated cellular Internet", async () => {
  mentraLocalNetworkMock.getNetworkDiagnostics.mockReturnValue(
    observation({
      activeNetwork: {...internet, capabilities: {...internet.capabilities!, wifi: false, cellular: true}},
    }),
  )
  await expect(waitForOtaInternet(() => true)).resolves.toBe("ready")
  expect(jest.getTimerCount()).toBe(0)
})

it("bounds permanent disconnection so the ordinary check can report its real failure", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  try {
    const finalCheck = jest.fn()
    const completion = waitForOtaInternet(() => true).then(finalCheck)
    await jest.advanceTimersByTimeAsync(29_999)
    expect(finalCheck).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await completion
    expect(finalCheck).toHaveBeenCalledWith("timed-out")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    warn.mockRestore()
  }
})

it("ends a stale device's wait without observing or changing the replacement device", async () => {
  let current = true
  const completion = waitForOtaInternet(() => current)
  expect(mentraLocalNetworkMock.getNetworkDiagnostics).toHaveBeenCalledTimes(1)
  current = false
  await jest.advanceTimersByTimeAsync(250)
  await expect(completion).resolves.toBe("cancelled")
  expect(mentraLocalNetworkMock.getNetworkDiagnostics).toHaveBeenCalledTimes(1)
  expect(jest.getTimerCount()).toBe(0)
})

it("reports unavailable required diagnostics as an observation error, not readiness", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
  try {
    mentraLocalNetworkMock.getNetworkDiagnostics.mockReturnValue(null)
    await expect(waitForOtaInternet(() => true)).resolves.toBe("unavailable")
    mentraLocalNetworkMock.getNetworkDiagnostics.mockImplementationOnce(() => {
      throw new Error("native read failed")
    })
    await expect(waitForOtaInternet(() => true)).resolves.toBe("unavailable")
    expect(warn).toHaveBeenCalledTimes(2)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    warn.mockRestore()
  }
})
