// until https://github.com/tconns/react-native-nitro-bg-timer/issues/2 is resolved, we need to use this class to disable this package on iOS:

import {Platform} from "react-native"
import {BackgroundTimer as NitroTimer} from "react-native-nitro-bg-timer"

export class BackgroundTimer {
  static setInterval(callback: () => void, delay: number): number {
    if (Platform.OS === "android") {
      return NitroTimer.setInterval(callback, delay)
    }
    return setInterval(callback, delay) as unknown as number
  }

  static clearInterval(intervalId: number): void {
    if (Platform.OS === "android") {
      NitroTimer.clearInterval(intervalId)
    } else {
      clearInterval(intervalId)
    }
  }

  static setTimeout(callback: () => void, delay: number): number {
    if (Platform.OS === "android") {
      return NitroTimer.setTimeout(callback, delay)
    }
    return setTimeout(callback, delay) as unknown as number
  }

  static clearTimeout(timeoutId: number): void {
    if (Platform.OS === "android") {
      NitroTimer.clearTimeout(timeoutId)
    } else {
      clearTimeout(timeoutId)
    }
  }
}
