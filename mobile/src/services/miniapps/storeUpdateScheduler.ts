import {AppState} from "react-native"

import {BgTimer, engine} from "@mentra/engine"

import {cloudClient} from "@/services/cloudClient"

import {StoreUpdateSchedulerCore} from "./StoreUpdateSchedulerCore"

const scheduler = new StoreUpdateSchedulerCore({
  invoke: (packageName) => engine.miniapps.invokeAction(packageName, "reconcile_updates", {}, 10 * 60_000),
  subscribeForeground: (handler) => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") handler()
    })
    return () => subscription.remove()
  },
  subscribeReconnect: (handler) => {
    let wasConnected = cloudClient.isConnected()
    return cloudClient.onConnectionChange((connected) => {
      if (connected && !wasConnected) handler()
      wasConnected = connected
    })
  },
  setInterval: (handler, intervalMs) => BgTimer.setInterval(handler, intervalMs),
  clearInterval: (handle) => BgTimer.clearInterval(handle as number),
  warn: (message, error) => console.warn(message, error),
})

export const storeUpdateScheduler = {
  start: (storePackages: readonly string[]) => scheduler.start(storePackages),
  stop: () => scheduler.stop(),
  trigger: () => scheduler.trigger(),
}
