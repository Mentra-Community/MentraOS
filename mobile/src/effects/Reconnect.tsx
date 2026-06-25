import {useEffect} from "react"
import {AppState} from "react-native"

import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"
import {decideReconnect, BluetoothSdk} from "@mentra/island"
import {selectGlassesConnected, useGlassesStore} from "@/stores/glasses"
import {useCoreStore} from "@/stores/core"
import {DeviceTypes} from "@/../../cloud/packages/types/src"

export async function attemptReconnectToDefaultWearable(): Promise<boolean> {
  const reconnectOnAppForeground = await useSettingsStore
    .getState()
    .getSetting(SETTINGS.reconnect_on_app_foreground.key)
  const defaultWearable = await useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)

  const decision = decideReconnect({
    reconnectOnForeground: !!reconnectOnAppForeground,
    defaultWearable,
    isSimulated: !!defaultWearable && defaultWearable.includes(DeviceTypes.SIMULATED),
    connection: useGlassesStore.getState().connection,
    searching: useCoreStore.getState().searching,
  })
  if (decision.kind === "skip") {
    return decision.result
  }

  // check if we have bluetooth perms in case they got removed:
  const requirementsCheck = await checkConnectivityRequirementsUI()
  if (!requirementsCheck) {
    return true
  }
  try {
    // Seed native state before connectDefault() replays settings to glasses.
    await BluetoothSdk.updateBluetoothSettings(useSettingsStore.getState().getBluetoothSettings())
    await BluetoothSdk.connectDefault()
  } catch (error) {
    console.warn("RECONNECT: failed to connect default wearable:", error)
    return false
  }
  return true
}

export function Reconnect() {
  const glassesConnected = useGlassesStore(selectGlassesConnected)
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
