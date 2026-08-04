import {View} from "react-native"
import {useRef, useEffect, useState} from "react"

import {Icon, IconTypes, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useDebugStore} from "@/stores/debug"
import {SETTINGS, useSetting} from "@mentra/engine"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {TouchEvent} from "@mentra/bluetooth-sdk"
import {BgTimer, engine} from "@mentra/engine"

function Tag({icon, label, bg}: {icon: IconTypes; label: string; bg: string}) {
  const {theme} = useAppTheme()
  return (
    <View className={`flex-row items-center px-1.5 rounded-full ${bg} mx-0.5`}>
      <Icon name={icon} size={10} color={theme.colors.secondary_foreground} />
      <Text className="text-secondary-foreground font-medium ml-0.5" style={{fontSize: 9, lineHeight: 12}}>
        {label}
      </Text>
    </View>
  )
}

function cloudClientTransportLabel(audioTransport: string, localFallbackActive: boolean): string {
  if (localFallbackActive) return "Offline"
  if (audioTransport === "udp") return "UDP"
  if (audioTransport === "ws") return "WS"
  return "None"
}

function cloudClientStatusBg(status: string): string {
  if (status === "connected") return "bg-primary"
  if (status === "connecting" || status === "reconnecting") return "bg-chart-3"
  return "bg-destructive"
}

export default function CoreStatusBar() {
  const [runtimeStatus, setRuntimeStatus] = useState(() => engine.dev.runtimeStatus())
  const micDataRecvd = useDebugStore((state) => state.micDataRecvd)
  const [localFallbackActive] = useSetting<boolean>(SETTINGS.local_stt_fallback_active.key)
  const insets = useSaferAreaInsets()
  const [touchEvent, setTouchEvent] = useState<TouchEvent | null>(null)
  const cloudClientTransport = cloudClientTransportLabel(runtimeStatus.cloudClientAudioTransport, localFallbackActive)

  useEffect(() => {
    setRuntimeStatus(engine.dev.runtimeStatus())
    return engine.dev.onRuntimeStatus(setRuntimeStatus)
  }, [])

  const touchEventTimer = useRef<number | null>(null)
  useEffect(() => {
    let unsub = engine.glasses.onTouchGesture((event: TouchEvent) => {
      setTouchEvent(event)
      BgTimer.clearTimeout(touchEventTimer.current ?? 0)
      touchEventTimer.current = BgTimer.setTimeout(() => {
        setTouchEvent(null)
      }, 1000)
      // console.log("touch_event", event)
    })
    return () => {
      unsub()
    }
  }, [])

  return (
    <>
      {/* <View
        style={{top: insets.top - 24}}
        className="absolute z-11 bg-primary-transparent rounded-lg items-center self-center w-full px-1.5">
        <View className="flex-row justify-between">
          <View className="flex-row flex-wrap items-center justify-center w-1/2 justify-start">
            <Tag icon="bluetooth" label={searching ? "Searching" : "Not searching"} bg="bg-chart-4" />
            <Tag icon="microphone" label={currentMic || "None"} bg="bg-chart-3" />
            <Tag icon="microphone" label={micRanking.join(", ")} bg="bg-primary" />
            {systemMicUnavailable && <Tag icon="unplug" label="SMIC unavailable!" bg="bg-destructive" />}
          </View>
          <View className="flex-row flex-wrap items-center justify-center w-1/2 justify-end">
            <Tag icon="bluetooth" label={runtimeStatus.glassesFullyBooted ? "Booted" : "Not booted"} bg="bg-primary" />
            <Tag
              icon="bluetooth"
              label={runtimeStatus.bluetoothClassicConnected ? "BTC" : "BTC Off"}
              bg={runtimeStatus.bluetoothClassicConnected ? "bg-primary" : "bg-destructive"}
            />
            <Tag icon="bluetooth" label={runtimeStatus.glassesConnected ? "Connected" : "Disconnected"} bg="bg-primary" />
            <Tag
              icon={micDataRecvd ? "microphone" : "unplug"}
              label={micDataRecvd ? "PCM" : "No PCM"}
              bg={micDataRecvd ? "bg-primary" : "bg-destructive"}
            />
          </View>
        </View>
      </View> */}
      <View
        style={{top: 0, height: insets.top}}
        className="absolute z-11 bg-transparent rounded-lg items-center self-center w-full px-1.5">
        <View className="flex-col justify-between gap-10">
          <View className="flex-row flex-wrap items-center justify-center justify-start">
            <Tag icon="bluetooth" label={runtimeStatus.searching ? "Searching" : "Not searching"} bg="bg-chart-4" />
            <Tag icon="microphone" label={runtimeStatus.currentMic || "None"} bg="bg-chart-3" />
            <Tag icon="microphone" label={runtimeStatus.micRanking.join(", ")} bg="bg-primary" />
            {runtimeStatus.systemMicUnavailable && <Tag icon="unplug" label="SMIC unavailable!" bg="bg-destructive" />}
          </View>
          <View className="flex-row flex-wrap items-center justify-center justify-end">
            <Tag icon="pointer" label={touchEvent ? touchEvent.gestureName ?? "None" : "None"} bg="bg-primary" />
            <Tag icon="bluetooth" label={runtimeStatus.glassesFullyBooted ? "Booted" : "Not booted"} bg="bg-primary" />
            <Tag
              icon="bluetooth"
              label={runtimeStatus.bluetoothClassicConnected ? "BTC" : "BTC Off"}
              bg={runtimeStatus.bluetoothClassicConnected ? "bg-primary" : "bg-destructive"}
            />
            <Tag
              icon="bluetooth"
              label={runtimeStatus.glassesConnected ? "Connected" : "Disconnected"}
              bg="bg-primary"
            />
            <Tag
              icon={micDataRecvd ? "microphone" : "unplug"}
              label={micDataRecvd ? "PCM" : "No PCM"}
              bg={micDataRecvd ? "bg-primary" : "bg-destructive"}
            />
          </View>
          <View className="flex-row flex-wrap items-center justify-center justify-start -mt-10">
            <Tag
              icon="wifi"
              label={
                runtimeStatus.coreStatus === "connected"
                  ? "Core"
                  : runtimeStatus.coreStatus === "connecting"
                  ? "Core Conn"
                  : runtimeStatus.coreStatus === "error"
                  ? "Core Err"
                  : "Core Off"
              }
              bg={
                runtimeStatus.coreStatus === "connected"
                  ? "bg-primary"
                  : runtimeStatus.coreStatus === "connecting"
                  ? "bg-chart-3"
                  : "bg-destructive"
              }
            />
            <Tag
              icon="wifi"
              label={`Cloud V2: ${cloudClientTransport}`}
              bg={cloudClientStatusBg(runtimeStatus.cloudClientStatus)}
            />
          </View>
        </View>
      </View>
    </>
  )
}
