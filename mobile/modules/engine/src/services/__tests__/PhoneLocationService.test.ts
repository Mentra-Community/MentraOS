/// <reference types="bun-types" />

import {afterEach, beforeEach, describe, expect, mock, test} from "bun:test"
import type {LocationTaskOptions} from "expo-location"

const platform = {OS: "android"}
const appStateListeners = new Set<(state: string) => void>()
const appState = {
  currentState: "active",
  addEventListener: mock((_event: string, listener: (state: string) => void) => {
    appStateListeners.add(listener)
    return {remove: () => appStateListeners.delete(listener)}
  }),
}
let nativeForeground = true
let registered = false
let startGate: Promise<void> | null = null
const started: LocationTaskOptions[] = []
const hasStartedLocationUpdatesAsync = mock(async () => registered)
const stopLocationUpdatesAsync = mock(async () => {
  registered = false
})
const startLocationUpdatesAsync = mock(async (_name: string, options: LocationTaskOptions) => {
  // Match both installed Expo gates, including a native/JS lifecycle race.
  if (platform.OS === "android") {
    if (!options.foregroundService) throw new Error("ERR_LOCATION_BACKGROUND_UNAUTHORIZED")
    if (!nativeForeground) throw new Error("ForegroundServiceStartNotAllowedException")
  }
  if (startGate) await startGate
  started.push(options)
  registered = true
})

mock.module("react-native", () => ({Platform: platform, AppState: appState}))
mock.module("expo-location", () => ({
  LocationAccuracy: {Lowest: 1, Low: 2, Balanced: 3, High: 4, BestForNavigation: 6},
  hasStartedLocationUpdatesAsync,
  stopLocationUpdatesAsync,
  startLocationUpdatesAsync,
}))
mock.module("expo-task-manager", () => ({defineTask: mock(() => {})}))
mock.module("../LocalMiniappRuntime", () => ({default: {forwardEvent: mock(() => {})}}))

const {setLocationTier, stopPhoneLocation} = await import("../PhoneLocationService")

function changeAppState(state: string): void {
  appState.currentState = state
  nativeForeground = state === "active"
  for (const listener of [...appStateListeners]) listener(state)
}

async function flushLocationWork(): Promise<void> {
  // Let the serialized native promise work finish without submitting demand.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  platform.OS = "android"
  appState.currentState = "active"
  nativeForeground = true
  registered = false
  startGate = null
  started.length = 0
  hasStartedLocationUpdatesAsync.mockClear()
  stopLocationUpdatesAsync.mockClear()
  startLocationUpdatesAsync.mockClear()
  appState.addEventListener.mockClear()
})

afterEach(async () => {
  startGate = null
  await setLocationTier("off")
  expect(appStateListeners.size).toBe(0)
})

describe("PhoneLocationService Android while-in-use location", () => {
  test("starts realtime updates without requesting disallowed background location permission", async () => {
    await setLocationTier("realtime")

    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      accuracy: 6,
      pausesUpdatesAutomatically: false,
      foregroundService: {notificationTitle: "Mentra", killServiceOnDestroy: true},
    })
  })

  test("keeps the existing iOS task options without an Android service", async () => {
    platform.OS = "ios"
    await setLocationTier("high")

    expect(started).toEqual([{accuracy: 4, pausesUpdatesAutomatically: false}])
  })

  test("stops updates when the last location subscriber leaves", async () => {
    registered = true
    await setLocationTier("off")

    expect(stopLocationUpdatesAsync).toHaveBeenCalledWith("handleLocationUpdates")
    expect(startLocationUpdatesAsync).not.toHaveBeenCalled()
  })

  test("updates an existing Android task without unregistering its service", async () => {
    registered = true
    await setLocationTier("low")

    expect(stopLocationUpdatesAsync).not.toHaveBeenCalled()
    expect(started).toHaveLength(1)
    expect(started[0]?.accuracy).toBe(2)
  })

  test("preserves existing iOS stop/start behavior even while backgrounded", async () => {
    platform.OS = "ios"
    registered = true
    changeAppState("background")
    await setLocationTier("low")

    expect(stopLocationUpdatesAsync).toHaveBeenCalledTimes(1)
    expect(started).toEqual([{accuracy: 2, pausesUpdatesAutomatically: false}])
    expect(appState.addEventListener).not.toHaveBeenCalled()
  })

  test("preserves iOS start-on-query-failure behavior", async () => {
    platform.OS = "ios"
    hasStartedLocationUpdatesAsync.mockRejectedValueOnce(new Error("registration query failed"))
    await setLocationTier("high")

    expect(started).toEqual([{accuracy: 4, pausesUpdatesAutomatically: false}])
    expect(stopLocationUpdatesAsync).not.toHaveBeenCalled()
  })

  test("recovers after a foreground listener cannot be registered", async () => {
    changeAppState("background")
    appState.addEventListener.mockImplementationOnce(() => {
      throw new Error("listener registration failed")
    })
    await setLocationTier("high")
    expect(startLocationUpdatesAsync).not.toHaveBeenCalled()

    await setLocationTier("low")
    expect(appStateListeners.size).toBe(1)
    changeAppState("active")
    await flushLocationWork()

    expect(started.map((options) => options.accuracy)).toEqual([2])
    expect(appStateListeners.size).toBe(0)
  })

  test("preserves running GPS for a background tier change and retries when active", async () => {
    await setLocationTier("realtime")
    changeAppState("background")
    await setLocationTier("low")

    expect(registered).toBe(true)
    expect(started.map((options) => options.accuracy)).toEqual([6])
    expect(stopLocationUpdatesAsync).not.toHaveBeenCalled()
    expect(appStateListeners.size).toBe(1)

    changeAppState("active")
    await flushLocationWork()
    expect(started.map((options) => options.accuracy)).toEqual([6, 2])
    expect(appStateListeners.size).toBe(0)
  })

  test("starts only the latest deferred tier when returning to the foreground", async () => {
    changeAppState("background")
    await setLocationTier("realtime")
    await setLocationTier("low")
    await setLocationTier("high")

    expect(startLocationUpdatesAsync).not.toHaveBeenCalled()
    expect(appStateListeners.size).toBe(1)
    changeAppState("active")
    await flushLocationWork()

    expect(started.map((options) => options.accuracy)).toEqual([4])
  })

  test("off cancels deferred demand and cannot restart on foreground", async () => {
    registered = true
    changeAppState("background")
    await setLocationTier("realtime")
    await setLocationTier("off")

    expect(registered).toBe(false)
    expect(stopLocationUpdatesAsync).toHaveBeenCalledTimes(1)
    expect(appStateListeners.size).toBe(0)
    changeAppState("active")
    await flushLocationWork()
    expect(startLocationUpdatesAsync).not.toHaveBeenCalled()
  })

  test("off wins over a start already in flight", async () => {
    let releaseStart!: () => void
    startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const starting = setLocationTier("realtime")
    await flushLocationWork()
    expect(startLocationUpdatesAsync).toHaveBeenCalledTimes(1)

    const stopping = setLocationTier("off")
    releaseStart()
    await Promise.all([starting, stopping])

    expect(registered).toBe(false)
    expect(stopLocationUpdatesAsync).toHaveBeenCalledTimes(1)
    expect(appStateListeners.size).toBe(0)
  })

  test("host cleanup cancels an in-flight start through the same queue", async () => {
    let releaseStart!: () => void
    startGate = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const starting = setLocationTier("realtime")
    await flushLocationWork()

    stopPhoneLocation()
    releaseStart()
    await starting
    await flushLocationWork()

    expect(registered).toBe(false)
    expect(stopLocationUpdatesAsync).toHaveBeenCalledTimes(1)
  })

  test("retains registration after a native foreground rejection and retries later", async () => {
    registered = true
    nativeForeground = false // Native moved to background before JS received the event.
    await setLocationTier("high")

    expect(registered).toBe(true)
    expect(stopLocationUpdatesAsync).not.toHaveBeenCalled()
    expect(startLocationUpdatesAsync).toHaveBeenCalledTimes(1)
    expect(started).toHaveLength(0)
    await flushLocationWork()
    expect(startLocationUpdatesAsync).toHaveBeenCalledTimes(1) // No retry loop.

    changeAppState("background")
    changeAppState("active")
    await flushLocationWork()
    expect(started.map((options) => options.accuracy)).toEqual([4])
    expect(appStateListeners.size).toBe(0)
  })

  test("off cancels a failed native start before any foreground retry", async () => {
    registered = true
    nativeForeground = false
    await setLocationTier("high")
    await setLocationTier("off")

    changeAppState("background")
    changeAppState("active")
    await flushLocationWork()

    expect(startLocationUpdatesAsync).toHaveBeenCalledTimes(1)
    expect(stopLocationUpdatesAsync).toHaveBeenCalledTimes(1)
    expect(registered).toBe(false)
    expect(appStateListeners.size).toBe(0)
  })

  test("removing an unused subscription does not attempt to stop an absent task", async () => {
    await setLocationTier("off")

    expect(stopLocationUpdatesAsync).not.toHaveBeenCalled()
    expect(startLocationUpdatesAsync).not.toHaveBeenCalled()
    expect(appStateListeners.size).toBe(0)
  })

  test("retries failed Android cleanup on the next active transition", async () => {
    registered = true
    stopLocationUpdatesAsync.mockRejectedValueOnce(new Error("native stop failed"))
    await setLocationTier("off")

    expect(registered).toBe(true)
    expect(appStateListeners.size).toBe(1)
    changeAppState("background")
    changeAppState("active")
    await flushLocationWork()

    expect(stopLocationUpdatesAsync).toHaveBeenCalledTimes(2)
    expect(registered).toBe(false)
    expect(appStateListeners.size).toBe(0)
  })

  test("retries an Android registration-query failure without restarting GPS", async () => {
    registered = true
    hasStartedLocationUpdatesAsync.mockRejectedValueOnce(new Error("native query failed"))
    await setLocationTier("off")

    expect(registered).toBe(true)
    expect(appStateListeners.size).toBe(1)
    changeAppState("background")
    changeAppState("active")
    await flushLocationWork()

    expect(stopLocationUpdatesAsync).toHaveBeenCalledTimes(1)
    expect(startLocationUpdatesAsync).not.toHaveBeenCalled()
    expect(registered).toBe(false)
    expect(appStateListeners.size).toBe(0)
  })

  test("coalesces demand submitted before native work starts", async () => {
    await Promise.all([setLocationTier("realtime"), setLocationTier("low"), setLocationTier("off")])

    expect(startLocationUpdatesAsync).not.toHaveBeenCalled()
    expect(registered).toBe(false)
  })
})
