import {SETTINGS, engine, useSetting} from "@mentra/engine"
import {useEffect, useRef} from "react"

import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate} from "@/i18n"
import showAlert, {dismissAlert} from "@/utils/AlertUtils"
import {markPairingModePopupShown, wasPairingModePopupShown} from "@/utils/pairing/pairingModePopup"

/**
 * Tells the user their connected glasses just entered pairing mode (S1).
 *
 * Shown once per pairing window: the SDK's `pairing_state_changed` can repeat, the app can remount,
 * and the stored record is reloaded after a restart, so the `(deviceId, windowId)` pair is persisted
 * until the window's `endsAtMs`. A new `windowId` shows it again.
 *
 * Only for glasses that were connected when the window opened. A first-time pairing flow is already
 * in pairing mode and has its own screens. The reconnecting card on Home stays underneath.
 * The popup closes itself when the glasses leave pairing mode.
 */
export function PairingModePopup() {
  const status = useEngineSnapshot(engine.glasses.status, (onChange) => engine.glasses.onStatus(onChange))
  const {pairingState} = status
  const connected = status.state === "connected"
  const [deviceAddress] = useSetting(SETTINGS.device_address.key)
  const [deviceName] = useSetting(SETTINGS.device_name.key)
  const deviceId = deviceAddress || deviceName || "unknown"

  // Whether the glasses were connected before the window opened. The link can drop right after, and a
  // unit that connects during the window is a fresh pairing, which must not trigger the popup.
  const wasConnectedRef = useRef(connected)

  useEffect(() => {
    if (pairingState.state !== "pairing_mode") {
      wasConnectedRef.current = connected
      dismissAlert(translate("pairing:pairingModeAlertTitle"))
      return
    }
    if (!wasConnectedRef.current) return

    const {windowId, endsAtMs} = pairingState
    const now = Date.now()
    if (endsAtMs <= now) return
    if (wasPairingModePopupShown(deviceId, windowId, now)) return

    markPairingModePopupShown(deviceId, windowId, endsAtMs, now)
    showAlert(translate("pairing:pairingModeAlertTitle"), translate("pairing:pairingModeAlertBody"), [
      {text: translate("common:ok")},
    ])
  }, [pairingState, connected, deviceId])

  return null
}
