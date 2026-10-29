/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"
import type {SupportStateInput} from "@mentra/cloud-client"

let subscriptionCallback: (() => void) | null = null
let nextTimerId = 1
let clockMs = 0
const timeoutCallbacks = new Map<number, {callback: () => void; dueAt: number}>()
const intervalCallbacks = new Map<number, () => void>()
const updateMock = mock(async (_snapshot: unknown) => ({status: "accepted" as const}))
type ConnectionState = "disconnected" | "scanning" | "connecting" | "bonding" | "connected"
const glassesState = {
  connection: {state: "connected" as ConnectionState, fullyBooted: true},
  deviceModel: "Mentra Live",
  serialNumber: "SERIAL-123",
  firmwareVersion: "1.2.3",
  androidVersion: "14",
  mtkFirmwareVersion: "mtk-1",
  besFirmwareVersion: "bes-1",
  appVersion: "live-2",
  buildNumber: "200",
  bluetoothMacAddress: "AA:BB:CC:DD:EE:FF",
  wifiMacAddress: "12:34:56:78:9A:BC",
  leftMacAddress: "11:22:33:44:55:66",
  wifi: {state: "connected", ssid: "Private Wi-Fi", localIp: "192.0.2.10"},
  hotspot: {state: "enabled", ssid: "secret", password: "password", localIp: "192.0.2.1"},
}

// expo-constants 55 has no native version or build: only the config's version, which is the family's base version.
mock.module("expo-constants", () => ({default: {expoConfig: {version: "2.4.0"}}}))
mock.module("expo-application", () => ({nativeApplicationVersion: "2.4.1", nativeBuildVersion: "240"}))
mock.module("expo-device", () => ({modelName: "iPhone 17 Pro"}))
import {reactNative} from "./reactNativeTestMock"

reactNative.Platform = {OS: "ios", Version: "26.0"}
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
    setTimeout: mock((callback: () => void, delayMs: number) => {
      const id = nextTimerId++
      timeoutCallbacks.set(id, {callback, dueAt: clockMs + delayMs})
      return id
    }),
    clearTimeout: mock((id: number) => timeoutCallbacks.delete(id)),
  },
}))
import {cloudClientService} from "./cloudClientServiceTestMock"

cloudClientService.core = {supportProfile: {update: updateMock}}

const {
  buildSnapshot,
  recordSupportProfileConnectionFailure,
  retryDelayForSendFailure,
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
  glassesState.deviceModel = "Mentra Live"
  glassesState.serialNumber = "SERIAL-123"
  clockMs = 0
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
    expect(serialized).not.toContain("12:34")
    expect(serialized).not.toContain("Private Wi-Fi")
    expect(serialized).not.toContain("192.0.2")
    expect(serialized).not.toContain("password")
  })

  test("reports the native application's version and build number", () => {
    expect(buildSnapshot().host).toMatchObject({appVersion: "2.4.1", appBuild: "240"})
  })

  test("only stale results schedule a retry", () => {
    expect(retryDelayForSupportProfileResult({status: "accepted"})).toBeNull()
    expect(retryDelayForSupportProfileResult({status: "deduplicated"})).toBeNull()
    expect(retryDelayForSupportProfileResult({status: "stale"})).toBe(30_000)
  })

  test("backs failed sends off exponentially toward the heartbeat cadence", () => {
    expect(retryDelayForSendFailure(1)).toBe(30_000)
    expect(retryDelayForSendFailure(2)).toBe(60_000)
    expect(retryDelayForSendFailure(5)).toBe(480_000)
    expect(retryDelayForSendFailure(50)).toBe(6 * 60 * 60_000)
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

  test("retries a stale snapshot with a fresh observation time", async () => {
    updateMock.mockImplementationOnce(async () => ({
      status: "stale" as const,
      observedAt: new Date().toISOString(),
    }))
    startSupportProfileSync()
    await flushPromises()

    expect(timeoutCallbacks.size).toBe(1)
    runOnlyTimeout()
    await flushPromises()
    expect(updateMock).toHaveBeenCalledTimes(2)
  })

  test("an hour of reconnect attempts with the glasses away sends only the disconnect", async () => {
    startSupportProfileSync()
    await flushPromises()
    updateMock.mockClear()

    disconnectGlasses()
    await advance(500)
    await retryGlassesThatAreAway(60)

    // The disconnect, sent once the first attempt is under way.
    expect(sentSnapshots()).toHaveLength(1)
    expect(sentSnapshots()[0]?.host.connectionState).toBe("scanning")
    expect(sentSnapshots()[0]?.device).toBeUndefined()
  })

  test("a phone that starts with its glasses away sends one profile for an hour of attempts", async () => {
    glassesState.connection.state = "scanning"
    glassesState.serialNumber = ""
    startSupportProfileSync()
    await flushPromises()
    await retryGlassesThatAreAway(60)

    expect(updateMock).toHaveBeenCalledTimes(1)
  })

  test("the glasses coming back is an update, and leaving again another", async () => {
    startSupportProfileSync()
    await flushPromises()
    disconnectGlasses()
    await retryGlassesThatAreAway(10)
    updateMock.mockClear()

    connectGlasses()
    await advance(5_000)
    disconnectGlasses()
    await advance(5_000)

    const [back, left] = sentSnapshots()
    expect(sentSnapshots()).toHaveLength(2)
    expect(back?.host.connectionState).toBe("connected")
    expect(back?.device).toMatchObject({hardwareId: "SERIAL-123", model: "Mentra Live", firmwareVersion: "1.2.3"})
    expect(left?.host.connectionState).toBe("disconnected")
    expect(left?.device).toBeUndefined()
  })

  test("describes glasses only while they are connected", () => {
    glassesState.connection.state = "connecting"
    glassesState.serialNumber = ""
    expect(buildSnapshot().device).toBeUndefined()
    glassesState.connection.state = "disconnected"
    glassesState.deviceModel = ""
    expect(buildSnapshot().device).toBeUndefined()
  })

  test("a connection failure while the glasses are away is still sent, once", async () => {
    glassesState.connection.state = "disconnected"
    startSupportProfileSync()
    await flushPromises()
    updateMock.mockClear()

    recordSupportProfileConnectionFailure(new Error("Bluetooth unavailable"), "reconnect")
    await retryGlassesThatAreAway(5)
    recordSupportProfileConnectionFailure(new Error("Bluetooth unavailable"), "reconnect")
    await retryGlassesThatAreAway(5)

    expect(sentSnapshots().map((snapshot) => snapshot.host.failureCode)).toEqual(["bluetooth_unavailable"])
  })

  test("a Core that keeps failing is retried on its backoff, not with every reconnect attempt", async () => {
    startSupportProfileSync()
    await flushPromises()
    updateMock.mockClear()
    updateMock.mockImplementation(async () => {
      throw new Error("observedAt is outside the accepted window")
    })

    disconnectGlasses()
    await retryGlassesThatAreAway(60)

    // The disconnect, then retries 30 s, 1, 2, 4, 8, 16 and 32 minutes after each failure (the next is at 63.5 min).
    expect(updateMock).toHaveBeenCalledTimes(7)

    // Something new still goes out without waiting for the next retry: the glasses back, updated.
    connectGlasses()
    setGlasses({firmwareVersion: "1.2.4"})
    await advance(5_000)
    expect(updateMock).toHaveBeenCalledTimes(8)
    expect(sentSnapshots().at(-1)?.device?.firmwareVersion).toBe("1.2.4")
  })

  test("a reconnect attempt during a send that then fails does not skip the backoff", async () => {
    startSupportProfileSync()
    await flushPromises()
    updateMock.mockClear()
    let fail: ((error: Error) => void) | null = null
    updateMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )

    disconnectGlasses()
    await advance(2_000)
    expect(updateMock).toHaveBeenCalledTimes(1)
    setGlasses({connection: {state: "connecting", fullyBooted: false}, deviceModel: "Mentra Live"})
    updateMock.mockImplementation(async () => {
      throw new Error("observedAt is outside the accepted window")
    })
    fail?.(new Error("observedAt is outside the accepted window"))
    await flushPromises()
    await advance(29_000)

    expect(updateMock).toHaveBeenCalledTimes(1)
    await advance(1_000)
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
  const [id, timeout] = [...timeoutCallbacks.entries()][0] ?? []
  if (id === undefined || !timeout) throw new Error("expected one pending timeout")
  timeoutCallbacks.delete(id)
  timeout.callback()
}

/** Run the timeouts that fall due in the next `ms`, in order, letting each send settle. */
async function advance(ms: number): Promise<void> {
  const target = clockMs + ms
  for (;;) {
    const due = [...timeoutCallbacks.entries()]
      .filter(([, timeout]) => timeout.dueAt <= target)
      .sort((a, b) => a[1].dueAt - b[1].dueAt)[0]
    if (!due) break
    const [id, timeout] = due
    timeoutCallbacks.delete(id)
    clockMs = timeout.dueAt
    timeout.callback()
    await flushPromises()
  }
  clockMs = target
}

/** One store update, as the store's subscribers see it. */
function setGlasses(update: Partial<typeof glassesState>): void {
  Object.assign(glassesState, update)
  subscriptionCallback?.()
}

/**
 * What `DeviceManager.disconnect()` does: it clears the glasses' identity field by field while the connection still
 * says connected, and only then sets it to disconnected. Their versions stay in the store.
 */
function disconnectGlasses(): void {
  setGlasses({deviceModel: ""})
  setGlasses({serialNumber: ""})
  setGlasses({connection: {state: "disconnected", fullyBooted: false}})
}

function connectGlasses(): void {
  setGlasses({
    connection: {state: "connected", fullyBooted: true},
    deviceModel: "Mentra Live",
    serialNumber: "SERIAL-123",
  })
}

/**
 * What a phone does all day while its paired glasses are away (the Fleet suite's model of it): it scans for them,
 * tries to connect, gives up and tries again, every 30 s. While it tries the native layer names the glasses it is
 * looking for, and clears them when it gives up.
 */
async function retryGlassesThatAreAway(minutes: number): Promise<void> {
  const end = clockMs + minutes * 60_000
  while (clockMs < end) {
    setGlasses({connection: {state: "scanning", fullyBooted: false}})
    setGlasses({deviceModel: "Mentra Live"})
    await advance(3_000)
    setGlasses({connection: {state: "connecting", fullyBooted: false}})
    await advance(26_000)
    setGlasses({connection: {state: "disconnected", fullyBooted: false}, deviceModel: "", serialNumber: ""})
    await advance(1_000)
  }
}

function sentSnapshots(): SupportStateInput[] {
  return updateMock.mock.calls.map(([snapshot]) => snapshot as SupportStateInput)
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
