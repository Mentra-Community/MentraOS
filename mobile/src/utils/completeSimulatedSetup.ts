import {DeviceTypes} from "@/../../cloud/packages/types/src"
import CoreModule from "core"

import {waitForGlassesState} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"

const SIMULATED_SETUP_TIMEOUT_MS = 400
const SIMULATED_SETUP_POLL_INTERVAL_MS = 50

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForSimulatedSettingsPersistence(): Promise<boolean> {
  const deadline = Date.now() + SIMULATED_SETUP_TIMEOUT_MS

  while (Date.now() < deadline) {
    const settingsStore = useSettingsStore.getState()
    const defaultWearable = settingsStore.getSetting(SETTINGS.default_wearable.key)
    const deviceName = settingsStore.getSetting(SETTINGS.device_name.key)

    if (defaultWearable === DeviceTypes.SIMULATED && deviceName === DeviceTypes.SIMULATED) {
      return true
    }

    await sleep(SIMULATED_SETUP_POLL_INTERVAL_MS)
  }

  return false
}

export async function completeSimulatedSetup() {
  await CoreModule.connectSimulated()

  const [glassesConnected, settingsPersisted] = await Promise.all([
    waitForGlassesState("connected", (connected) => connected === true, SIMULATED_SETUP_TIMEOUT_MS),
    waitForSimulatedSettingsPersistence(),
  ])

  if (glassesConnected && settingsPersisted) {
    return
  }

  // Fall back to an explicit JS-side write so home state can't race ahead of
  // the native save_setting bridge event.
  await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, DeviceTypes.SIMULATED)
  await useSettingsStore.getState().setSetting(SETTINGS.device_name.key, DeviceTypes.SIMULATED)
}
