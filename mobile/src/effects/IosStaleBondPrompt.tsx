import {useEffect} from "react"
import {Platform} from "react-native"

import {useNavigationStore} from "@/stores/navigation"
import {IOS_FORGET_GLASSES_BLUETOOTH_ERROR, iosBluetoothDeviceLabel} from "@/utils/pairing/iosStaleBond"
import {engine} from "@mentra/engine"

const PAIRING_ROUTES = new Set(["/pairing/loading", "/pairing/failure", "/pairing/replace-owner"])

/**
 * Shows the forget-in-Bluetooth prompt when iOS rejects a Mentra Live connection
 * because the glasses removed their bond. The pairing loading screen handles the
 * same event itself, so this stays out of the way while that screen is up.
 */
export function IosStaleBondPrompt() {
  useEffect(() => {
    if (Platform.OS !== "ios") return
    return engine.pairing.onPairFailure((event) => {
      if (event.error !== IOS_FORGET_GLASSES_BLUETOOTH_ERROR) return
      const nav = useNavigationStore.getState()
      const route = nav.getCurrentRoute()
      if (route && PAIRING_ROUTES.has(route)) return
      const identity = engine.pairing.identity()
      const deviceModel = identity.kind === "none" ? "Mentra Live" : identity.model
      const deviceName = iosBluetoothDeviceLabel(
        identity.kind === "paired" ? identity.name : undefined,
        deviceModel,
      )
      console.log(`PAIRFLOW: stale_ios_bond route=${route ?? "-"} model=${deviceModel} name=${deviceName}`)
      void engine.pairing.abandonAttempt().catch((cleanupError) => {
        console.warn("Stale iOS bond cleanup failed:", cleanupError)
      })
      nav.replace("/pairing/failure", {error: event.error, deviceModel, deviceName})
    })
  }, [])

  return null
}
