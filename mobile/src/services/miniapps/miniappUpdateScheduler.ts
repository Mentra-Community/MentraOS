import {BgTimer, engine} from "@mentra/engine"

import {defaultMiniapps} from "./defaultMiniapps"
import {subscribeAppForeground, subscribeCloudReconnect} from "./maintenanceTriggers"
import {MiniappUpdateSchedulerCore} from "./MiniappUpdateSchedulerCore"

const scheduler = new MiniappUpdateSchedulerCore({
  // A default that couldn't install yet (offline) tries again on every pass, before the updates.
  checkAll: async () => {
    await defaultMiniapps.sync()
    return engine.miniapps.checkForUpdates()
  },
  checkOpened: (packageName) => engine.miniapps.checkOpenedForUpdate(packageName),
  subscribeForeground: subscribeAppForeground,
  subscribeReconnect: subscribeCloudReconnect,
  subscribeDeferredUpdateReady: (handler) => engine.miniapps.onDeferredUpdateReady(() => handler()),
  subscribeOpened: (handler) => engine.miniapps.onOpened(handler),
  setInterval: (handler, intervalMs) => BgTimer.setInterval(handler, intervalMs),
  clearInterval: (handle) => BgTimer.clearInterval(handle as number),
  warn: (message, error) => console.warn(message, error),
})

/** Background installs of missing default miniapps, and updates of installed miniapps from their own URLs. */
export const miniappUpdateScheduler = {
  start: () => scheduler.start(),
  stop: () => scheduler.stop(),
  trigger: () => scheduler.trigger(),
}
