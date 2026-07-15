import {useEffect, useRef} from "react"
import {Platform} from "react-native"

import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {SETTINGS, useSetting} from "@mentra/engine"
import {usePathname} from "expo-router"
import {DeviceTypes} from "@/../../cloud/packages/types/src"
import showAlert from "@/utils/AlertUtils"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {engine} from "@mentra/engine"

export function BtClassicPairing() {
  const readiness = useEngineSnapshot(engine.pairing.readiness, (onChange) => engine.pairing.onReadiness(onChange))
  const bluetoothClassicConnected = readiness.bluetoothClassicConnected
  const glassesConnected = readiness.connected
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const {push} = useNavigationStore.getState()

  const pathname = usePathname()
  const ignoreRef = useRef(false)

  // iOS only
  useEffect(() => {
    if (Platform.OS !== "ios") return
    if (ignoreRef.current) return
    if (pathname !== "/home") return // only run on the home screen
    if (defaultWearable !== DeviceTypes.LIVE) return
    if (!glassesConnected || bluetoothClassicConnected) return

    const timeout = setTimeout(() => {
      // re-check the glasses state after 2 seconds to see if it's still in this state:
      const latestReadiness = engine.pairing.readiness()
      if (ignoreRef.current || !latestReadiness.connected || latestReadiness.bluetoothClassicConnected) return

      showAlert(translate("pairing:btClassicDisconnected"), translate("pairing:btClassicDisconnectedMessage"), [
        {
          text: translate("common:ignore"),
          onPress: () => {
            ignoreRef.current = true
          },
        },
        {
          text: translate("common:connect"),
          onPress: () => {
            push("/pairing/btclassic")
          },
        },
      ])
    }, 2000)

    return () => clearTimeout(timeout)
  }, [pathname, defaultWearable, glassesConnected, bluetoothClassicConnected])

  return null
}
