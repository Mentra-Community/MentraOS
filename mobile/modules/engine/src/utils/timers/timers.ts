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
//   - Android, dev AND release: always attempted — dev must match production
//     background behavior. There is no opt-in/opt-out env var. If the native
//     module is unavailable (a dev client whose binary predates it, or a
//     broken release binary), the failure is LOUD: a console.error with the
//     remediation, plus a blocking dev alert. The JS-timer fallback still
//     engages so foreground behavior keeps working, but backgrounded
//     behavior is broken until the native rebuild — the error says exactly
//     that. (A silent dev fallback previously cost a full debugging day of
//     phantom "zombie miniapp" bugs; see OS-1790.)
//   - iOS: never, dev or prod — the package is disabled pending
//     https://github.com/tconns/react-native-nitro-bg-timer/issues/2. iOS
//     suspends the whole process in background anyway, so background timing
//     there is handled by native per-device queues, not JS timers.

import {Alert, Platform} from "react-native"

type NitroTimerApi = {
  setInterval: (callback: () => void, delay: number) => number
  clearInterval: (intervalId: number) => void
  setTimeout: (callback: () => void, delay: number) => number
  clearTimeout: (timeoutId: number) => void
}

let nitroTimer: NitroTimerApi | null | undefined
let nitroDisabled = false
let failedLoud = false

/**
 * The native background timer is unavailable — say so ONCE, loudly, with the
 * remediation. The JS-timer fallback keeps foreground behavior working, but
 * everything timing-driven freezes while the app is backgrounded, which
 * presents as phantom miniapp bugs (frozen captions, missed wake words,
 * watchdog kills on resume). A quiet warning here has already cost a full
 * debugging day; never downgrade this to console.warn.
 */
function failUnavailable(reason: string) {
  if (failedLoud) {
    return
  }
  failedLoud = true
  const message =
    `BgTimer: native background timer unavailable (${reason}). ` +
    "Backgrounded behavior IS BROKEN until you rebuild the Android app: run `bun android`. " +
    "Engine timers and local miniapps (captions, wake words) freeze whenever the app is not foregrounded."
  console.error(message)
  if (__DEV__) {
    // A stale dev client may ALSO show the library's own require-time red box
    // (bridgeless LogBox surfaces it even though we catch below) — this alert
    // is the actionable one: it names the fix.
    try {
      Alert.alert("Background timers unavailable", message)
    } catch {
      /* Alert not available (tests / headless) — the console.error stands. */
    }
  }
}

function getNitroTimer(): NitroTimerApi | null {
  if (nitroDisabled || Platform.OS !== "android") {
    return null
  }

  if (nitroTimer !== undefined) {
    return nitroTimer
  }

  try {
    const {isRuntimeAlive} = require("react-native-nitro-modules") as {isRuntimeAlive?: () => boolean}
    if (typeof isRuntimeAlive === "function" && !isRuntimeAlive()) {
      nitroTimer = null
      failUnavailable("nitro runtime is not alive")
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
    failUnavailable("react-native-nitro-bg-timer failed to load")
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
    failedLoud = false // a mid-session failure is new information — re-announce
    failUnavailable(`nitro timer call threw: ${String(error)}`)
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
