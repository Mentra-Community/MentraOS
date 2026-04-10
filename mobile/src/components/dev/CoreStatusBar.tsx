import {ScrollView, View} from "react-native"
import {useRef, useEffect, useState} from "react"

import {Icon, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useConnectionStore} from "@/stores/connection"
import {useCoreStore} from "@/stores/core"
import {useDebugStore} from "@/stores/debug"
import {useGlassesStore} from "@/stores/glasses"
import GlassView from "@/components/ui/GlassView"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import CoreModule, {TouchEvent} from "core"
import {BackgroundTimer} from "@/utils/timers"

function Tag({icon, label, bg}: {icon: string; label: string; bg: string}) {
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

export default function CoreStatusBar() {
  const searching = useCoreStore((state) => state.searching)
  const micRanking = useCoreStore((state) => state.micRanking)
  const currentMic = useCoreStore((state) => state.currentMic)
  const systemMicUnavailable = useCoreStore((state) => state.systemMicUnavailable)
  const micDataRecvd = useDebugStore((state) => state.micDataRecvd)
  const btcConnected = useGlassesStore((state) => state.btcConnected)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const glassesFullyBooted = useGlassesStore((state) => state.fullyBooted)
  const cloudStatus = useConnectionStore((state) => state.status)
  const insets = useSaferAreaInsets()
  const [touchEvent, setTouchEvent] = useState<TouchEvent | null>(null)

  const touchEventTimer = useRef<number | null>(null)
  useEffect(() => {
    let sub = CoreModule.addListener("touch_event", (event: TouchEvent) => {
      setTouchEvent(event)
      BackgroundTimer.clearTimeout(touchEventTimer.current ?? 0)
      touchEventTimer.current = BackgroundTimer.setTimeout(() => {
        setTouchEvent(null)
      }, 1000)
      // console.log("touch_event", event)
    })
    return () => {
      sub.remove()
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
            <Tag icon="bluetooth" label={glassesFullyBooted ? "Booted" : "Not booted"} bg="bg-primary" />
            <Tag
              icon="bluetooth"
              label={btcConnected ? "BTC" : "BTC Off"}
              bg={btcConnected ? "bg-primary" : "bg-destructive"}
            />
            <Tag icon="bluetooth" label={glassesConnected ? "Connected" : "Disconnected"} bg="bg-primary" />
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
            <Tag icon="bluetooth" label={searching ? "Searching" : "Not searching"} bg="bg-chart-4" />
            <Tag icon="microphone" label={currentMic || "None"} bg="bg-chart-3" />
            <Tag icon="microphone" label={micRanking.join(", ")} bg="bg-primary" />
            {systemMicUnavailable && <Tag icon="unplug" label="SMIC unavailable!" bg="bg-destructive" />}
          </View>
          <View className="flex-row flex-wrap items-center justify-center justify-end">
            <Tag
              icon="wifi"
              label={cloudStatus === "connected" ? "Cloud" : cloudStatus === "connecting" ? "Connecting" : cloudStatus === "error" ? "Cloud Err" : "Cloud Off"}
              bg={cloudStatus === "connected" ? "bg-primary" : cloudStatus === "connecting" ? "bg-chart-3" : "bg-destructive"}
            />
            <Tag icon="pointer" label={touchEvent ? (touchEvent.gesture_name ?? "None") : "None"} bg="bg-primary" />
            <Tag icon="bluetooth" label={glassesFullyBooted ? "Booted" : "Not booted"} bg="bg-primary" />
            <Tag
              icon="bluetooth"
              label={btcConnected ? "BTC" : "BTC Off"}
              bg={btcConnected ? "bg-primary" : "bg-destructive"}
            />
            <Tag icon="bluetooth" label={glassesConnected ? "Connected" : "Disconnected"} bg="bg-primary" />
            <Tag
              icon={micDataRecvd ? "microphone" : "unplug"}
              label={micDataRecvd ? "PCM" : "No PCM"}
              bg={micDataRecvd ? "bg-primary" : "bg-destructive"}
            />
          </View>
        </View>
      </View>
    </>
  )
}
