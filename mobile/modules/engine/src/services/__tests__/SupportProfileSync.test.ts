/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"

let subscriptionCallback: (() => void) | null = null
let nextTimerId = 1
const timeoutCallbacks = new Map<number, () => void>()
const intervalCallbacks = new Map<number, () => void>()
const updateMock = mock(async () => ({status: "accepted" as const}))
const glassesState = {
  connection: {state: "connected" as "connected" | "disconnected", fullyBooted: true},
  deviceModel: "Mentra Live",
  serialNumber: "SERIAL-123",
  firmwareVersion: "1.2.3",
  androidVersion: "14",
  mtkFirmwareVersion: "mtk-1",
  besFirmwareVersion: "bes-1",
  appVersion: "live-2",
  buildNumber: "200",
  bluetoothMacAddress: "AA:BB:CC:DD:EE:FF",
  leftMacAddress: "11:22:33:44:55:66",
  wifi: {state: "connected", ssid: "Private Wi-Fi", localIp: "192.0.2.10"},
  hotspot: {state: "enabled", ssid: "secret", password: "password", localIp: "192.0.2.1"},
}

mock.module("expo-constants", () => ({
  default: {
    nativeAppVersion: "2.4.0",
    nativeBuildVersion: "240",
    expoConfig: {version: "2.4.0"},
  },
}))
mock.module("expo-device", () => ({modelName: "iPhone 17 Pro"}))
mock.module("react-native", () => ({Platform: {OS: "ios", Version: "26.0"}}))
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {
    getState: () => glassesState,
    subscribe: mock((callback: () => void) => {
      subscriptionCallback = callback
      return () => {
        subscriptionCallback = null
      }
    }),
  },
}))
mock.module("../../utils/timers", () => ({
  BgTimer: {
    setInterval: mock((callback: () => void) => {
      const id = nextTimerId++
      intervalCallbacks.set(id, callback)
      return id
    }),
    clearInterval: mock((id: number) => intervalCallbacks.delete(id)),
    setTimeout: mock((callback: () => void) => {
      const id = nextTimerId++
      timeoutCallbacks.set(id, callback)
      return id
    }),
    clearTimeout: mock((id: number) => timeoutCallbacks.delete(id)),
  },
}))
mock.module("../CloudClientService", () => ({
  cloudClientService: {core: {supportProfile: {update: updateMock}}},
}))

const {
  buildSnapshot,
  recordSupportProfileConnectionFailure,
  retryDelayForSupportProfileResult,
  snapshotFingerprint,
  startSupportProfileSync,
  stopSupportProfileSync,
} = await import("../SupportProfileSync")

beforeEach(() => {
  stopSupportProfileSync()
  updateMock.mockClear()
  updateMock.mockImplementation(async () => ({status: "accepted"}))
  glassesState.firmwareVersion = "1.2.3"
  glassesState.connection.state = "connected"
  timeoutCallbacks.clear()
  intervalCallbacks.clear()
  subscriptionCallback = null
})

afterEach(() => stopSupportProfileSync())

describe("SupportProfileSync", () => {
  test("projects only the support allowlist and excludes network/device addresses", () => {
    const snapshot = buildSnapshot(new Date("2026-08-11T12:00:00.000Z"))
    const serialized = JSON.stringify(snapshot)

    expect(snapshot.device).toMatchObject({
      hardwareId: "SERIAL-123",
      model: "Mentra Live",
      firmwareVersion: "1.2.3",
    })
    expect(snapshot.host.phoneModel).toBe("iPhone 17 Pro")
    expect(serialized).not.toContain("AA:BB")
    expect(serialized).not.toContain("Private Wi-Fi")
    expect(serialized).not.toContain("192.0.2")
    expect(serialized).not.toContain("password")
  })

  test("only accepted writes are delivered and rate limits honor the server window", () => {
    expect(retryDelayForSupportProfileResult({status: "accepted"})).toBeNull()
    expect(retryDelayForSupportProfileResult({status: "deduplicated"})).toBeNull()
    expect(retryDelayForSupportProfileResult({status: "stale"})).toBe(30_000)
    expect(retryDelayForSupportProfileResult({status: "rate_limited", retryAfterMs: 42_000})).toBe(42_000)
  })

  test("does not treat observation time as a meaningful transition", () => {
    const first = buildSnapshot(new Date("2026-08-11T12:00:00.000Z"))
    const heartbeat = buildSnapshot(new Date("2026-08-11T18:00:00.000Z"))
    expect(snapshotFingerprint(heartbeat)).toBe(snapshotFingerprint(first))
  })

  test("keeps a failure until a real successful connection transition", async () => {
    startSupportProfileSync()
    await flushPromises()

    recordSupportProfileConnectionFailure(new Error("Bluetooth unavailable"), "connect_default")
    expect(buildSnapshot().host).toMatchObject({
      failureCode: "bluetooth_unavailable",
      failureStage: "connect_default",
    })

    glassesState.connection.state = "disconnected"
    subscriptionCallback?.()
    expect(buildSnapshot().host.failureCode).toBe("bluetooth_unavailable")
    glassesState.connection.state = "connected"
    subscriptionCallback?.()
    expect(buildSnapshot().host.failureCode).toBeUndefined()
  })

  test("starts immediately, debounces transitions, runs heartbeats, and tears down", async () => {
    startSupportProfileSync()
    await flushPromises()
    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(subscriptionCallback).not.toBeNull()
    expect(intervalCallbacks.size).toBe(1)

    glassesState.firmwareVersion = "1.2.4"
    subscriptionCallback?.()
    runOnlyTimeout()
    await flushPromises()
    expect(updateMock).toHaveBeenCalledTimes(2)
    ;[...intervalCallbacks.values()][0]?.()
    await flushPromises()
    expect(updateMock).toHaveBeenCalledTimes(3)

    stopSupportProfileSync()
    expect(subscriptionCallback).toBeNull()
    expect(timeoutCallbacks.size).toBe(0)
    expect(intervalCallbacks.size).toBe(0)
  })

  test("keeps a state change queued behind an in-flight send", async () => {
    let finishFirst: ((value: {status: "accepted"}) => void) | null = null
    updateMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        }),
    )
    startSupportProfileSync()
    glassesState.firmwareVersion = "1.2.5"
    subscriptionCallback?.()
    finishFirst?.({status: "accepted"})
    await flushPromises()

    expect(timeoutCallbacks.size).toBe(1)
    runOnlyTimeout()
    await flushPromises()
    expect(updateMock).toHaveBeenCalledTimes(2)
  })

  test("retries a rate-limited snapshot", async () => {
    updateMock.mockImplementationOnce(async () => ({
      status: "rate_limited" as const,
      observedAt: new Date().toISOString(),
      retryAfterMs: 5_000,
    }))
    startSupportProfileSync()
    await flushPromises()

    expect(timeoutCallbacks.size).toBe(1)
    runOnlyTimeout()
    await flushPromises()
    expect(updateMock).toHaveBeenCalledTimes(2)
  })

  test("does not schedule traffic when an old request finishes after stop", async () => {
    let finish: ((value: {status: "accepted"}) => void) | null = null
    updateMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    startSupportProfileSync()
    stopSupportProfileSync()
    finish?.({status: "accepted"})
    await flushPromises()

    expect(timeoutCallbacks.size).toBe(0)
    expect(intervalCallbacks.size).toBe(0)
  })
})

function runOnlyTimeout(): void {
  const [id, callback] = [...timeoutCallbacks.entries()][0] ?? []
  if (id === undefined || !callback) throw new Error("expected one pending timeout")
  timeoutCallbacks.delete(id)
  callback()
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
