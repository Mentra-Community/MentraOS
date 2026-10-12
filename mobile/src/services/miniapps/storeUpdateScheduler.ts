import {AppState} from "react-native"

import {BgTimer, engine} from "@mentra/engine"

import {cloudClient} from "@/services/cloudClient"

import {StoreUpdateSchedulerCore} from "./StoreUpdateSchedulerCore"

/** The Store's manifest declares this host-only, transient action. */
const STORE_RECONCILE_ACTION = "reconcile_updates"
const STORE_RECONCILE_TIMEOUT_MS = 10 * 60_000

const scheduler = new StoreUpdateSchedulerCore({
  invoke: (packageName) =>
    engine.miniapps.invokeAction(packageName, STORE_RECONCILE_ACTION, {}, STORE_RECONCILE_TIMEOUT_MS),
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
  subscribeDeferredUpdateReady: (handler) => engine.miniapps.onDeferredUpdateReady(() => handler()),
  setInterval: (handler, intervalMs) => BgTimer.setInterval(handler, intervalMs),
  clearInterval: (handle) => BgTimer.clearInterval(handle as number),
  warn: (message, error) => console.warn(message, error),
})

/** Background update maintenance for the bundled Stores, without any Store screen. */
export const storeUpdateScheduler = {
  start: (storePackages: readonly string[]) => scheduler.start(storePackages),
  stop: () => scheduler.stop(),
  trigger: () => scheduler.trigger(),
}
