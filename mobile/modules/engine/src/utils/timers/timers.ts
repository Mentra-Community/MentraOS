// BgTimer — background-safe timers for the engine.
//
// Everything timing-critical in the engine runs through this class: the
// miniapp liveness watchdog, display durationMs expiries, boot windows,
// auth-token refresh. On Android, React Native PAUSES plain JS timers while
// the app is backgrounded, so those features only keep working in the
// background when the native implementation (react-native-nitro-bg-timer)
// is active.
//
// Who actually gets native timers:
//   - Android release builds: always (silent fallback to JS timers only if
//     the require() fails — which also silently breaks background behavior,
//     so treat that warning seriously if it ever shows in prod logs).
//   - Android dev builds: OPT-IN via EXPO_PUBLIC_USE_NITRO_BG_TIMER=true.
//     Without it, a backgrounded dev build freezes every engine timer AND
//     local miniapps stop working (captions stop rendering, wake words are
//     missed, the watchdog respawns contexts on foreground) — dev behavior
//     silently diverges from production in exactly the backgrounded
//     scenarios that matter on glasses. Set the var in mobile/.env after a
//     native rebuild (bun android); see .env.example.
//   - iOS: never, dev or prod — the package is disabled pending
//     https://github.com/tconns/react-native-nitro-bg-timer/issues/2. iOS
//     suspends the whole process in background anyway, so background timing
//     there is handled by native per-device queues, not JS timers.

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

  // Dev default is OFF because react-native-nitro-bg-timer calls
  // createHybridObject() at require() time, and on a dev client whose native
  // binary predates the module that throws an NPE which LogBox red-boxes even
  // when caught (bridgeless RN). The cost of this guard is severe though:
  // with it active, a BACKGROUNDED dev build loses all engine timers and
  // local miniapps freeze (see header). If your dev client was built after
  // the module landed, opt in via EXPO_PUBLIC_USE_NITRO_BG_TIMER=true in
  // mobile/.env so dev matches production background behavior.
  if (__DEV__ && process.env.EXPO_PUBLIC_USE_NITRO_BG_TIMER !== "true") {
    warnUnavailable(
      "nitro bg-timer disabled in dev — BACKGROUNDED apps will freeze engine timers and miniapps. " +
        "Set EXPO_PUBLIC_USE_NITRO_BG_TIMER=true in mobile/.env (after a native rebuild: bun android)",
    )
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
      typeof BackgroundTimer.setInterval === "function" &&
      typeof BackgroundTimer.clearTimeout === "function" &&
      typeof BackgroundTimer.clearInterval === "function"
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
