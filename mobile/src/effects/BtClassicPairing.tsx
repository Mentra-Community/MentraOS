import {useEffect, useRef} from "react"

import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {SETTINGS, useSetting} from "@mentra/engine"
import {usePathname} from "expo-router"
import {DeviceTypes} from "@mentra/engine"
import showAlert, {dismissAlert} from "@/utils/AlertUtils"
import {translate} from "@/i18n"
import {BT_CLASSIC_ROUTE} from "@/utils/pairing/pairAudio"
import {useNavigationStore} from "@/stores/navigation"
import {engine} from "@mentra/engine"

/**
 * Home's "Glasses audio disconnected" prompt. The Bluetooth SDK decides when glasses audio needs the
 * user (`audioSetup.state === "needs_user"`, after its own reconnect grace); this only renders it.
 */
export function BtClassicPairing() {
  const {audioSetup} = useEngineSnapshot(engine.pairing.readiness, (onChange) => engine.pairing.onReadiness(onChange))
  const needsUser = audioSetup.state === "needs_user"
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const {push} = useNavigationStore.getState()

  const pathname = usePathname()
  const ignoreRef = useRef(false)
  const alertShownRef = useRef(false)

  useEffect(() => {
    // The prompt is only true while the SDK says audio needs the user. Audio can come up (or the
    // glasses can drop) while it is on screen, so take it down instead of leaving a stale message.
    if (alertShownRef.current && !needsUser) {
      alertShownRef.current = false
      dismissAlert(translate("pairing:btClassicDisconnected"))
    }

    if (ignoreRef.current || alertShownRef.current) return
    if (pathname !== "/home") return // only run on the home screen
    if (defaultWearable !== DeviceTypes.LIVE) return
    if (!needsUser) return

    alertShownRef.current = true
    showAlert(translate("pairing:btClassicDisconnected"), translate("pairing:btClassicDisconnectedMessage"), [
      {
        text: translate("common:ignore"),
        onPress: () => {
          alertShownRef.current = false
          ignoreRef.current = true
        },
      },
      {
        text: translate("common:connect"),
        onPress: () => {
          alertShownRef.current = false
          push(BT_CLASSIC_ROUTE)
        },
      },
    ])
  }, [pathname, defaultWearable, needsUser])

  return null
}
