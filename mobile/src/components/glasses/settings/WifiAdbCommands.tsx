import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {DeviceTypes, engine} from "@mentra/engine"
import {useRef, useState} from "react"
import {View} from "react-native"

import {Text} from "@/components/ignite"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate} from "@/i18n"

import {SettingsCommandButton} from "./SettingsCommandButton"

/** Explicit commands: the SDK has no readback for the persisted ADB preference. */
export function WifiAdbCommands() {
  const status = useEngineSnapshot(engine.glasses.status, engine.glasses.onStatus)
  const info = useEngineSnapshot(engine.glasses.info, engine.glasses.onInfo)
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState("")
  const expectedMac = info.btMac
  const available =
    status.state === "connected" &&
    info.model === DeviceTypes.LIVE &&
    /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(expectedMac ?? "")

  const send = async (enabled: boolean) => {
    if (inFlight.current) return
    // Recheck at the input boundary; a rendered button can outlive a disconnect.
    const current = engine.glasses.info()
    if (
      !available ||
      engine.glasses.status().state !== "connected" ||
      current.model !== DeviceTypes.LIVE ||
      current.btMac?.toUpperCase() !== expectedMac?.toUpperCase()
    )
      return
    inFlight.current = true
    setPending(true)
    setMessage("")
    try {
      await BluetoothSdk.setWifiAdbState(enabled, expectedMac)
      setMessage(translate("debugSettings:wifiAdbCommandSent"))
    } catch {
      setMessage(translate("debugSettings:wifiAdbCommandFailed"))
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  if (!available) return null
  return (
    <View className="gap-2">
      <SettingsCommandButton
        label={translate("debugSettings:wifiAdbEnable")}
        subtitle={translate("debugSettings:wifiAdbSubtitle")}
        disabled={pending}
        onPress={() => void send(true)}
      />
      <SettingsCommandButton
        label={translate("debugSettings:wifiAdbDisable")}
        disabled={pending}
        onPress={() => void send(false)}
      />
      {message ? (
        <Text text={message} accessibilityLiveRegion="polite" className="text-sm text-muted-foreground" />
      ) : null}
    </View>
  )
}
