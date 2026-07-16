import {Platform} from "react-native"

type TimerHandle = ReturnType<typeof setTimeout> | number

type NitroTimerApi = {
  setTimeout: (callback: () => void, duration: number) => number
  clearTimeout: (id: number) => void
  setInterval: (callback: () => void, interval: number) => number
  clearInterval: (id: number) => void
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

/**
 * react-native-nitro-bg-timer calls NitroModules.createHybridObject() at require()
 * time. When the native hybrid is missing or throws NPE, bridgeless React Native
 * can still report a fatal host exception and kill the process even if JS catches
 * the error. Keep nitro opt-in only (EXPO_PUBLIC_USE_NITRO_BG_TIMER=true) after a
 * native rebuild that includes a working NitroBackgroundTimer.
 */
function getNitroTimer(): NitroTimerApi | null {
  if (nitroDisabled || Platform.OS !== "android") {
    return null
  }

  if (process.env.EXPO_PUBLIC_USE_NITRO_BG_TIMER !== "true") {
    return null
  }

  if (nitroTimer !== undefined) {
    return nitroTimer
  }

  try {
    const nitroModules = require("react-native-nitro-modules") as {
      isRuntimeAlive?: () => boolean
      NitroModules?: {hasHybridObject?: (name: string) => boolean}
    }
    if (typeof nitroModules.isRuntimeAlive === "function" && !nitroModules.isRuntimeAlive()) {
      nitroTimer = null
      nitroDisabled = true
      warnUnavailable("nitro runtime is not alive")
      return nitroTimer
    }
    if (
      typeof nitroModules.NitroModules?.hasHybridObject === "function" &&
      !nitroModules.NitroModules.hasHybridObject("NitroBackgroundTimer")
    ) {
      nitroTimer = null
      nitroDisabled = true
      warnUnavailable("NitroBackgroundTimer hybrid is not registered")
      return nitroTimer
    }

    const {BackgroundTimer} = require("react-native-nitro-bg-timer") as {BackgroundTimer?: NitroTimerApi}
    nitroTimer =
      BackgroundTimer &&
      typeof BackgroundTimer.setTimeout === "function" &&
      typeof BackgroundTimer.clearTimeout === "function" &&
      typeof BackgroundTimer.setInterval === "function" &&
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

function withNitro<T>(nitroFn: (api: NitroTimerApi) => T, fallback: () => T): T {
  const api = getNitroTimer()
  if (!api) {
    return fallback()
  }
  try {
    return nitroFn(api)
  } catch {
    nitroDisabled = true
    nitroTimer = null
    warnUnavailable("nitro timer call failed")
    return fallback()
  }
}

/**
 * Background-capable timer utilities.
 *
 * On Android, uses native nitro timers when EXPO_PUBLIC_USE_NITRO_BG_TIMER=true and
 * the hybrid is healthy; otherwise falls back to JS timers. On iOS, always uses JS
 * timers (react-native-nitro-bg-timer is currently broken on iOS —
 * https://github.com/tconns/react-native-nitro-bg-timer/issues/2).
 */
export const BgTimer = {
  setTimeout(callback: () => void, duration: number): TimerHandle {
    return withNitro(
      api => api.setTimeout(callback, duration),
      () => setTimeout(callback, duration),
    )
  },

  clearTimeout(id: TimerHandle | null | undefined) {
    if (id == null) {
      return
    }
    withNitro(
      api => {
        api.clearTimeout(id as number)
      },
      () => {
        clearTimeout(id as ReturnType<typeof setTimeout>)
      },
    )
  },

  setInterval(callback: () => void, interval: number): TimerHandle {
    return withNitro(
      api => api.setInterval(callback, interval),
      () => setInterval(callback, interval),
    )
  },

  clearInterval(id: TimerHandle | null | undefined) {
    if (id == null) {
      return
    }
    withNitro(
      api => {
        api.clearInterval(id as number)
      },
      () => {
        clearInterval(id as ReturnType<typeof setInterval>)
      },
    )
  },
}
