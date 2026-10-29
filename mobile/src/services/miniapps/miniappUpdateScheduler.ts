import {BgTimer, engine} from "@mentra/engine"

import {subscribeAppForeground, subscribeCloudReconnect} from "./maintenanceTriggers"
import {MiniappUpdateSchedulerCore} from "./MiniappUpdateSchedulerCore"

const scheduler = new MiniappUpdateSchedulerCore({
  checkAll: () => engine.miniapps.checkForUpdates(),
  checkOpened: (packageName) => engine.miniapps.checkOpenedForUpdate(packageName),
  subscribeForeground: subscribeAppForeground,
  subscribeReconnect: subscribeCloudReconnect,
  subscribeDeferredUpdateReady: (handler) => engine.miniapps.onDeferredUpdateReady(() => handler()),
  subscribeOpened: (handler) => engine.miniapps.onOpened(handler),
  setInterval: (handler, intervalMs) => BgTimer.setInterval(handler, intervalMs),
  clearInterval: (handle) => BgTimer.clearInterval(handle as number),
  warn: (message, error) => console.warn(message, error),
})

/** Background updates of installed miniapps from their own URLs. */
export const miniappUpdateScheduler = {
  start: () => scheduler.start(),
  stop: () => scheduler.stop(),
  trigger: () => scheduler.trigger(),
}
