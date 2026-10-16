import {useRef, useState} from "react"
import {View} from "react-native"

import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {DeviceTypes, engine, SETTINGS} from "@mentra/engine"

import {Text} from "@/components/ignite"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate} from "@/i18n"

import {SettingsCommandButton} from "./SettingsCommandButton"

/** Explicit Super Mode commands; SDK completion does not prove an ADB route. */
export function WifiAdbSetting({superMode}: {superMode: boolean}) {
  const info = useEngineSnapshot(engine.glasses.info, (onChange) => engine.glasses.onInfo(onChange))
  const status = useEngineSnapshot(engine.glasses.status, (onChange) => engine.glasses.onStatus(onChange))
  const inFlight = useRef(false)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<{peer: string; message: string} | null>(null)

  if (!superMode || info.model !== DeviceTypes.LIVE || !info.btMac || status.state !== "connected") return null

  const send = async (enabled: boolean) => {
    // Recheck the current selection at input time, not only the last render.
    const selected = engine.glasses.info()
    if (
      inFlight.current ||
      !engine.settings.get(SETTINGS.super_mode.key) ||
      selected.model !== DeviceTypes.LIVE ||
      !selected.btMac ||
      selected.btMac !== info.btMac ||
      engine.glasses.status().state !== "connected"
    )
      return
    inFlight.current = true
    setPending(true)
    setResult(null)
    try {
      await BluetoothSdk.setWifiAdbState(enabled)
      setResult({
        peer: selected.btMac,
        message: translate(enabled ? "deviceSettings:wifiAdbEnableSent" : "deviceSettings:wifiAdbDisableSent"),
      })
    } catch {
      setResult({peer: selected.btMac, message: translate("deviceSettings:wifiAdbSendFailed")})
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <View className="gap-2">
      <Text tx="deviceSettings:wifiAdbWarning" className="text-xs text-muted-foreground" />
      <SettingsCommandButton
        label={translate("deviceSettings:wifiAdbEnable")}
        disabled={pending}
        onPress={() => {
          void send(true)
        }}
      />
      <SettingsCommandButton
        label={translate("deviceSettings:wifiAdbDisable")}
        disabled={pending}
        onPress={() => {
          void send(false)
        }}
      />
      {result && result.peer === info.btMac && <Text text={result.message} className="text-sm text-foreground" />}
    </View>
  )
}
