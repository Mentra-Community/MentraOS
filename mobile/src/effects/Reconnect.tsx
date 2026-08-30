import {useEffect} from "react"
import {AppState} from "react-native"

import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"
import {decideReconnect, engine, SETTINGS, useSetting} from "@mentra/engine"
import {DeviceTypes} from "@mentra/engine"

export async function attemptReconnectToDefaultWearable(): Promise<boolean> {
  const reconnectOnAppForeground = await engine.settings.get(SETTINGS.reconnect_on_app_foreground.key)
  const defaultWearable = await engine.settings.get<string>(SETTINGS.default_wearable.key)

  const decision = decideReconnect({
    reconnectOnForeground: !!reconnectOnAppForeground,
    defaultWearable,
    isSimulated: !!defaultWearable && defaultWearable.includes(DeviceTypes.SIMULATED),
    connected: engine.pairing.readiness().connected,
    nativeLinkBusy: engine.pairing.readiness().nativeLinkBusy,
    // Fail open on a bridge/hydration error: pass true so the flow proceeds to
    // connectDefault(), whose existing catch handles a genuinely missing
    // device (the pre-guard behavior) — a transient native failure must not
    // throw out of the app-foreground handler.
    hasDefaultDevice: await engine.glasses.hasDefaultDevice().catch(() => true),
    searching: engine.pairing.scanning(),
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
    // connectDefault() seeds the phone's device settings to native before the
    // connect handshake (the seed moved into the island facade).
    await engine.glasses.connectDefault()
  } catch (error) {
    console.warn("RECONNECT: failed to connect default wearable:", error)
    return false
  }
  return true
}

export function Reconnect() {
  const glassesConnected = useEngineSnapshot(engine.pairing.readiness, (onChange) =>
    engine.pairing.onReadiness(onChange),
  ).connected
  const isSearching = useEngineSnapshot(engine.pairing.scanning, (onChange) => engine.pairing.onScanning(onChange))
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

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
