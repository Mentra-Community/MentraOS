// until https://github.com/tconns/react-native-nitro-bg-timer/issues/2 is resolved, we need to use this class to disable this package on iOS:

import {Platform} from "react-native"

type NitroTimerApi = {
  setInterval: (callback: () => void, delay: number) => number
  clearInterval: (intervalId: number) => void
  setTimeout: (callback: () => void, delay: number) => number
  clearTimeout: (timeoutId: number) => void
}

let nitroTimer: NitroTimerApi | null | undefined
let nitroDisabled = false
let warnedUnavailable = false

function warnUnavailable(reason: string) {
  if (warnedUnavailable) {
    return
  }
  warnedUnavailable = true
  console.warn(`BgTimer: ${reason}, using JS timers`)
}

function getNitroTimer(): NitroTimerApi | null {
  if (nitroDisabled || Platform.OS !== "android") {
    return null
  }

  // react-native-nitro-bg-timer calls createHybridObject() at require() time. On dev
  // builds with a stale native binary that throws NPE, React Native still surfaces a
  // red LogBox error even when the exception is caught. Skip nitro in __DEV__ unless
  // explicitly enabled after a native rebuild (bun android).
  if (__DEV__ && process.env.EXPO_PUBLIC_USE_NITRO_BG_TIMER !== "true") {
    warnUnavailable("nitro bg-timer disabled in dev (set EXPO_PUBLIC_USE_NITRO_BG_TIMER=true after native rebuild)")
    return null
  }

  if (nitroTimer !== undefined) {
    return nitroTimer
  }

  try {
    const {isRuntimeAlive} = require("react-native-nitro-modules") as {isRuntimeAlive?: () => boolean}
    if (typeof isRuntimeAlive === "function" && !isRuntimeAlive()) {
      nitroTimer = null
      warnUnavailable("nitro runtime is not alive")
      return nitroTimer
    }

    const {BackgroundTimer} = require("react-native-nitro-bg-timer") as {BackgroundTimer?: NitroTimerApi}
    nitroTimer =
      BackgroundTimer &&
      typeof BackgroundTimer.setTimeout === "function" &&
      typeof BackgroundTimer.setInterval === "function"
        ? BackgroundTimer
        : null
  } catch {
    nitroTimer = null
    nitroDisabled = true
  }

  if (!nitroTimer) {
    warnUnavailable("react-native-nitro-bg-timer unavailable")
  }
  return nitroTimer
}

function withNitro<T>(run: (api: NitroTimerApi) => T, fallback: () => T): T {
  const api = getNitroTimer()
  if (!api) {
    return fallback()
  }
  try {
    return run(api)
  } catch (error) {
    nitroDisabled = true
    nitroTimer = null
    console.warn("BgTimer: nitro timer failed, using JS timers", error)
    return fallback()
  }
}

export class BgTimer {
  static setInterval(callback: () => void, delay: number): number {
    return withNitro(
      (api) => api.setInterval(callback, delay),
      () => setInterval(callback, delay) as unknown as number,
    )
  }

  static clearInterval(intervalId: number): void {
    withNitro(
      (api) => api.clearInterval(intervalId),
      () => clearInterval(intervalId),
    )
  }

  static setTimeout(callback: () => void, delay: number): number {
    return withNitro(
      (api) => api.setTimeout(callback, delay),
      () => setTimeout(callback, delay) as unknown as number,
    )
  }

  static clearTimeout(timeoutId: number): void {
    withNitro(
      (api) => api.clearTimeout(timeoutId),
      () => clearTimeout(timeoutId),
    )
  }
}

export function throttle<T extends (...args: any[]) => any>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let lastCalled = 0

  return (...args: Parameters<T>) => {
    const now = Date.now()
    if (now - lastCalled >= ms) {
      lastCalled = now
      fn(...args)
    }
  }
}

export function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let timeoutId: number | null = null

  return (...args: Parameters<T>) => {
    if (timeoutId) {
      BgTimer.clearTimeout(timeoutId)
    }
    timeoutId = BgTimer.setTimeout(() => {
      fn(...args)
      timeoutId = null
    }, ms)
  }
}
