import {useEffect, useRef} from "react"
import {Platform} from "react-native"

import {SETTINGS, useSetting} from "@/stores/settings"
import {useGlassesStore} from "@/stores/glasses"
import {usePathname} from "expo-router"
import {DeviceTypes} from "@/../../cloud/packages/types/src"
import showAlert from "@/utils/AlertUtils"
import {translate} from "@/i18n"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

export function BtClassicPairing() {
  const btcConnected = useGlassesStore((state) => state.btcConnected)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const {push} = useNavigationHistory()

  const pathname = usePathname()
  const ignoreRef = useRef(false)

  // iOS only
  useEffect(() => {
    if (Platform.OS !== "ios") {
      return
    }

    if (ignoreRef.current) {
      return
    }

    if (pathname !== "/home" && pathname !== "/(tabs)/home") {
      return
    }

    if (defaultWearable !== DeviceTypes.LIVE) {
      return
    }

    if (glassesConnected && btcConnected) {
      return
    }

    if (glassesConnected && !btcConnected) {
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
    }
  }, [ignoreRef.current, pathname, defaultWearable, glassesConnected, btcConnected])

  return null
}
