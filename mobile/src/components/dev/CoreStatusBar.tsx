import {ScrollView, View} from "react-native"
import {useRef, useEffect} from "react"

import {Icon, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useCoreStore} from "@/stores/core"
import {useDebugStore} from "@/stores/debug"
import {useGlassesStore} from "@/stores/glasses"

export default function CoreStatusBar() {
  const searching = useCoreStore((state) => state.searching)
  const micRanking = useCoreStore((state) => state.micRanking)
  const currentMic = useCoreStore((state) => state.currentMic)
  const systemMicUnavailable = useCoreStore((state) => state.systemMicUnavailable)
  const lastLog = useCoreStore((state) => state.lastLog)
  const micDataRecvd = useDebugStore((state) => state.micDataRecvd)
  const btcConnected = useGlassesStore((state) => state.btcConnected)
  const {theme} = useAppTheme()

  const scrollViewRef = useRef<ScrollView>(null)

  useEffect(() => {
    scrollViewRef.current?.scrollToEnd({animated: true})
  }, [lastLog])

  const glassesConnected = useGlassesStore((state) => state.connected)
  const glassesFullyBooted = useGlassesStore((state) => state.fullyBooted)

  return (
    <View className="flex-col bg-primary-foreground p-2 bottom-2 rounded-xl items-center self-center align-middle justify-center gap-2 w-full">
      {/* <ScrollView ref={scrollViewRef} className="h-24">
        {lastLog.slice(-10).map((log, index) => (
          <Text key={index} className="text-secondary-foreground text-xs font-medium font-mono ml-2">
            {log}
          </Text>
        ))}
      </ScrollView> */}
      <View className="flex-row gap-2">
        <View
          className={`flex-row items-center self-center align-middle justify-center py-1 px-2 rounded-full bg-chart-4`}>
          <Icon name="bluetooth" size={14} color={theme.colors.secondary_foreground} />
          <Text className="text-secondary-foreground text-sm font-medium ml-2">
            {searching ? "Searching" : "Not searching"}
          </Text>
        </View>
        <View
          className={`flex-row items-center self-center align-middle justify-center py-1 px-2 rounded-full bg-chart-3`}>
          <Icon name="microphone" size={14} color={theme.colors.secondary_foreground} />
          <Text className="text-secondary-foreground text-sm font-medium ml-2">{currentMic || "None"}</Text>
        </View>
      </View>
      <View className="flex-row gap-2">
        <View
          className={`flex-row items-center self-center align-middle justify-center py-1 px-2 rounded-full bg-primary`}>
          <Icon name="microphone" size={14} color={theme.colors.secondary_foreground} />
          <Text className="text-secondary-foreground text-sm font-medium ml-2">{micRanking.join(", ")}</Text>
        </View>
        {/* getting mic data? */}
        <View
          className={`flex-row items-center self-center align-middle justify-center py-1 px-2 rounded-full ${
            micDataRecvd ? "bg-primary" : "bg-destructive"
          }`}>
          <Icon name={micDataRecvd ? "microphone" : "unplug"} size={14} color={theme.colors.secondary_foreground} />
          <Text
            text={micDataRecvd ? "Getting PCM" : "No PCM"}
            className="text-secondary-foreground text-sm font-medium ml-2"
          />
        </View>
      </View>
      {systemMicUnavailable && (
        <View className="flex-row gap-2">
          {/* system mic unavailable */}
          <View
            className={`flex-row items-center self-center align-middle justify-center py-1 px-2 rounded-full bg-destructive`}>
            <Icon name="unplug" size={14} color={theme.colors.secondary_foreground} />
            <Text text="System mic is unavailable!" className="text-secondary-foreground text-sm font-medium ml-2" />
          </View>
        </View>
      )}

      <View className="flex-row gap-2">
        <View className="flex-row items-center self-center align-middle justify-center py-1 px-2 rounded-full bg-primary">
          <Icon name="bluetooth" size={14} color={theme.colors.secondary_foreground} />
          <Text className="text-secondary-foreground text-sm font-medium ml-2">
            {glassesConnected ? "Connected" : "Disconnected"}
          </Text>
        </View>
        <View className="flex-row items-center self-center align-middle justify-center py-1 px-2 rounded-full bg-primary">
          <Icon name="bluetooth" size={14} color={theme.colors.secondary_foreground} />
          <Text className="text-secondary-foreground text-sm font-medium ml-2">
            {glassesFullyBooted ? "Fully Booted" : "Not fully booted"}
          </Text>
        </View>
      </View>
      <View className="flex-row gap-2">
        <View className="flex-row items-center self-center align-middle justify-center py-1 px-2 rounded-full bg-primary">
          <Icon name="bluetooth" size={14} color={theme.colors.secondary_foreground} />
          <Text className="text-secondary-foreground text-sm font-medium ml-2">
            {btcConnected ? "BT Classic Connected" : "BT Classic Disconnected"}
          </Text>
        </View>
      </View>
    </View>
  )
}
