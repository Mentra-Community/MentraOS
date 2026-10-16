import {useEffect, useRef} from "react"
import {Platform} from "react-native"

import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {SETTINGS, useSetting} from "@mentra/engine"
import {usePathname} from "expo-router"
import {DeviceTypes} from "@mentra/engine"
import showAlert, {dismissAlert} from "@/utils/AlertUtils"
import {translate} from "@/i18n"
import {AUDIO_RECONNECT_GRACE_MS, isClassicAudioUp} from "@/utils/pairing/pairAudio"
import {useNavigationStore} from "@/stores/navigation"
import {engine} from "@mentra/engine"

export function BtClassicPairing() {
  const readiness = useEngineSnapshot(engine.pairing.readiness, (onChange) => engine.pairing.onReadiness(onChange))
  // Same definition of "audio is up" as the pairing flow: bond, connected profiles, or audio route.
  const bluetoothClassicConnected = isClassicAudioUp(readiness)
  const glassesConnected = readiness.connected
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const {push} = useNavigationStore.getState()

  const pathname = usePathname()
  const ignoreRef = useRef(false)
  const alertShownRef = useRef(false)

  // iOS only
  useEffect(() => {
    if (Platform.OS !== "ios") return

    // The prompt is only true while audio is down. Audio can come up (or the glasses can drop) while
    // it is on screen, so take it down instead of leaving a stale "disconnected" message.
    if (alertShownRef.current && (bluetoothClassicConnected || !glassesConnected)) {
      alertShownRef.current = false
      dismissAlert(translate("pairing:btClassicDisconnected"))
    }

    if (ignoreRef.current) return
    if (pathname !== "/home") return // only run on the home screen
    if (defaultWearable !== DeviceTypes.LIVE) return
    if (!glassesConnected || bluetoothClassicConnected) return

    const timeout = setTimeout(() => {
      // The effect restarts on every readiness change, so this runs only after the link has been up
      // with audio still down for the whole grace period (iOS reattaches the audio route late).
      const latestReadiness = engine.pairing.readiness()
      if (ignoreRef.current || !latestReadiness.connected || isClassicAudioUp(latestReadiness)) return

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
            push("/pairing/btclassic")
          },
        },
      ])
    }, AUDIO_RECONNECT_GRACE_MS)

    return () => clearTimeout(timeout)
  }, [pathname, defaultWearable, glassesConnected, bluetoothClassicConnected])

  return null
}
