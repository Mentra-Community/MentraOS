import {useEffect, useState} from "react"
import {View} from "react-native"

import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import type {WearStateEvent} from "@mentra/bluetooth-sdk-internal"
import {SETTINGS, useSetting} from "@mentra/engine"

import {Text} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n/translate"

const POLL_MS = 10_000

function formatRemaining(elapsedMs: number, timeoutMs: number): string {
  const remainingSec = Math.max(0, Math.ceil((timeoutMs - elapsedMs) / 1000))
  const minutes = Math.floor(remainingSec / 60)
  const seconds = remainingSec % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function statusLine(status: WearStateEvent | null): {worn: string; timer: string} {
  if (!status) return {worn: "Unknown", timer: "Waiting for the glasses…"}
  const worn = status.worn ? "Worn" : "Not worn"
  if (status.elapsedMs == null || status.timeoutMs == null) {
    return {worn, timer: "Timer unavailable on this firmware"}
  }
  if (status.enabled === false) return {worn, timer: "Auto-off is off"}
  if (!status.armed || status.worn) return {worn, timer: "Timer idle"}
  const remaining = formatRemaining(status.elapsedMs, status.timeoutMs)
  return {worn, timer: status.inhibited ? `Powers off in ${remaining} (held)` : `Powers off in ${remaining}`}
}

/** Super Mode control for the 20-minute unworn shutdown, plus a live readout. */
export function UnwornPowerOffSetting() {
  const {theme} = useAppTheme()
  const [enabled, setEnabled] = useSetting<boolean>(SETTINGS.auto_power_off_enabled.key)
  const [status, setStatus] = useState<WearStateEvent | null>(null)
  const line = statusLine(status)

  useEffect(() => {
    const sub = BluetoothSdk.addListener("wear_state", (event: WearStateEvent) => {
      setStatus(event)
    })
    const poll = () => {
      void BluetoothSdk.queryWearState().catch(() => undefined)
    }
    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => {
      sub.remove()
      clearInterval(timer)
    }
  }, [])

  return (
    <View className="gap-2">
      <ToggleSetting
        label={translate("deviceSettings:autoPowerOff")}
        subtitle={translate("deviceSettings:autoPowerOffSubtitle")}
        value={!!enabled}
        onValueChange={(value) => {
          void setEnabled(value)
        }}
      />
      <Text text={line.worn} className="text-text text-sm" />
      <Text text={line.timer} style={{color: theme.colors.textDim}} className="text-sm" />
      <Text
        text="The timer does not update quickly. It refreshes about every 10 seconds."
        style={{color: theme.colors.textDim}}
        className="text-xs"
      />
    </View>
  )
}
