// Mentra Live mic tuning. Reachable only via Super Settings, which is itself
// gated behind Super Mode — but expo-router routes are addressable, so the
// guard below is the one that actually holds.

import {useCallback, useEffect, useState} from "react"
import {ScrollView, View} from "react-native"
import {useFocusEffect} from "expo-router"

import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import type {MicRmsEvent, MicTuningStateEvent} from "@mentra/bluetooth-sdk-internal"
import {DeviceTypes, SETTINGS, useSetting} from "@mentra/engine"

import {MicrophoneTuningSettings} from "@/components/glasses/settings/MicrophoneTuningSettings"
import {Header, Screen, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"

export default function MicTuningScreen() {
  const {theme} = useAppTheme()
  const {goBack} = useNavigationStore.getState()
  const [superMode] = useSetting<boolean>(SETTINGS.super_mode.key)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [rms, setRms] = useState<MicRmsEvent | null>(null)
  const [applied, setApplied] = useState<MicTuningStateEvent | null>(null)

  const isMentraLive =
    defaultWearable === DeviceTypes.LIVE || String(defaultWearable || "").includes(DeviceTypes.LIVE)

  // Deep links bypass the Super Settings entry point entirely.
  useEffect(() => {
    if (!superMode) goBack()
  }, [superMode, goBack])

  useEffect(() => {
    const stateSub = BluetoothSdk.addListener("mic_tuning_state", (event: MicTuningStateEvent) => {
      setApplied(event)
    })
    const rmsSub = BluetoothSdk.addListener("mic_rms", (event: MicRmsEvent) => {
      setRms(event)
    })
    return () => {
      stateSub.remove()
      rmsSub.remove()
    }
  }, [])

  // Telemetry costs BLE traffic, so it lives exactly as long as this screen is
  // in front of the user. The state request covers the case where the
  // connect-time reply landed before anything was subscribed.
  useFocusEffect(
    useCallback(() => {
      if (!superMode || !isMentraLive) return
      void BluetoothSdk.requestMicTuningState()
      void BluetoothSdk.setMicRmsTelemetry(true)
      return () => {
        void BluetoothSdk.setMicRmsTelemetry(false)
      }
    }, [superMode, isMentraLive]),
  )

  if (!superMode) return null

  return (
    <Screen preset="fixed">
      <Header titleTx="microphoneSettings:tuningTitle" leftIcon="chevron-left" onLeftPress={() => goBack()} />
      <ScrollView style={{marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}>
        <View className="pt-6 pb-16">
          {isMentraLive ? (
            <MicrophoneTuningSettings rms={rms} applied={applied} />
          ) : (
            <Text
              tx="microphoneSettings:tuningDisconnected"
              style={{color: theme.colors.textDim}}
              className="text-sm"
            />
          )}
        </View>
      </ScrollView>
    </Screen>
  )
}
