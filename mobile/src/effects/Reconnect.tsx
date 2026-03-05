import {useEffect} from "react"
import {AppState} from "react-native"

import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"
import CoreModule from "core"
import {useGlassesStore} from "@/stores/glasses"
import {useCoreStore} from "@/stores/core"
import {DeviceTypes} from "@/../../cloud/packages/types/src"

export async function attemptReconnectToDefaultWearable(): Promise<boolean> {
  const reconnectOnAppForeground = await useSettingsStore
    .getState()
    .getSetting(SETTINGS.reconnect_on_app_foreground.key)
  if (!reconnectOnAppForeground) {
    return true
  }

  const defaultWearable = await useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
  const glassesConnected = await useGlassesStore.getState().connected
  const isSearching = await useCoreStore.getState().searching

  // Don't try to reconnect if no glasses have been paired yet (skip simulated glasses)
  if (!defaultWearable || defaultWearable.includes(DeviceTypes.SIMULATED)) {
    return false
  }

  if (glassesConnected || isSearching) {
    return true
  }

  // check if we have bluetooth perms in case they got removed:
  const requirementsCheck = await checkConnectivityRequirementsUI()
  if (!requirementsCheck) {
    return true
  }
  await CoreModule.connectDefault()
  return true
}

export function Reconnect() {
  const glassesConnected = useGlassesStore((state) => state.connected)
  const isSearching = useCoreStore((state) => state.searching)
  const defaultWearable = useSetting(SETTINGS.default_wearable.key)

  // Add a listener for app state changes to detect when the app comes back from background
  useEffect(() => {
    const handleAppStateChange = async (nextAppState: any) => {
      console.log("RECONNECT: App state changed to:", nextAppState)
      // If app comes back to foreground, attempt to reconnect
      if (nextAppState === "active") {
        await attemptReconnectToDefaultWearable()
      }
    }

    // Subscribe to app state changes
    const appStateSubscription = AppState.addEventListener("change", handleAppStateChange)

    return () => {
      appStateSubscription.remove()
    }
  }, [glassesConnected, isSearching, defaultWearable])

  return null
}
