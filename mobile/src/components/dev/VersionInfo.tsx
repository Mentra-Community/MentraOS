import * as Clipboard from "expo-clipboard"
import {useEffect, useRef, useState} from "react"
import {TextStyle, TouchableOpacity, View} from "react-native"
import Toast from "react-native-toast-message"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import udp from "@/services/UdpManager"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"

export const VersionInfo = () => {
  const {themed} = useAppTheme()
  const [devMode, setDevMode] = useSetting(SETTINGS.dev_mode.key)
  const [_superMode, setSuperMode] = useSetting(SETTINGS.super_mode.key)
  const [storeUrl] = useSetting(SETTINGS.store_url.key)
  const [backendUrl] = useSetting(SETTINGS.backend_url.key)
  const [audioTransport, setAudioTransport] = useState<string>("websocket")

  // Update audio transport info periodically (since it can change)
  useEffect(() => {
    if (!devMode) return

    const updateAudioTransport = () => {
      if (udp.enabledAndReady()) {
        const endpoint = udp.getEndpoint()
        setAudioTransport(endpoint ? `udp @ ${endpoint}` : "udp")
      } else {
        setAudioTransport("websocket")
      }
    }

    updateAudioTransport()
    const interval = setInterval(updateAudioTransport, 2000)
    return () => clearInterval(interval)
  }, [devMode])

  const pressCount = useRef(0)
  const lastPressTime = useRef(0)
  const pressTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleQuickPress = () => {
    const currentTime = Date.now()
    const timeDiff = currentTime - lastPressTime.current
    const maxTimeDiff = 2000
    const maxPressCount = 10
    const showAlertAtPressCount = 5

    // Reset counter if too much time has passed
    if (timeDiff > maxTimeDiff) {
      pressCount.current = 1
    } else {
      pressCount.current += 1
    }

    lastPressTime.current = currentTime

    copyVersionInfo()

    // Clear existing timeout
    if (pressTimeout.current) {
      clearTimeout(pressTimeout.current)
    }

    // Handle different press counts
    if (pressCount.current === maxPressCount) {
      showAlert(translate("dev:developerModeEnabled"), translate("dev:developerModeEnabled"), [
        {text: translate("common:ok")},
      ])
      setDevMode(true)
      pressCount.current = 0
    } else if (pressCount.current >= showAlertAtPressCount) {
      const remaining = maxPressCount - pressCount.current
      Toast.show({
        type: "info",
        text1: translate("dev:developerMode"),
        text2: translate("dev:developerModeMoreTaps", {number: remaining}),
        position: "bottom",
        topOffset: 80,
        visibilityTime: 1000,
      })
    }

    // Reset counter after 2 seconds of no activity
    pressTimeout.current = setTimeout(() => {
      pressCount.current = 0
    }, maxTimeDiff)
  }

  const copyVersionInfo = async () => {
    const res = await mentraAuth.getUser()
    let user = null
    if (res.is_ok()) {
      user = res.value
    }
    const info = [
      `version: ${process.env.EXPO_PUBLIC_MENTRAOS_VERSION}`,
      `branch: ${process.env.EXPO_PUBLIC_BUILD_BRANCH}`,
      `time: ${process.env.EXPO_PUBLIC_BUILD_TIME}`,
      `commit: ${process.env.EXPO_PUBLIC_BUILD_COMMIT}`,
      `store_url: ${storeUrl}`,
      `backend_url: ${backendUrl}`,
      `audio: ${audioTransport}`,
    ]

    if (user) {
      info.push(`id: ${user.id}`)
      info.push(`email: ${user.email}`)
    }

    await Clipboard.setStringAsync(info.join("\n"))
    if (devMode) {
      Toast.show({
        type: "info",
        text1: translate("dev:versionInfoCopied"),
        position: "bottom",
        topOffset: 80,
        visibilityTime: 1000,
      })
    }
  }

  const handlePressIn = () => {
    longPressTimer.current = setTimeout(() => {
      setSuperMode(true)
      // showAlert(translate("dev:superMode"), translate("dev:superModeActivated"), [{text: translate("common:ok")}])
      Toast.show({
        type: "success",
        text1: translate("dev:superModeActivated"),
        position: "bottom",
        topOffset: 80,
        visibilityTime: 2000,
      })
      longPressTimer.current = null
    }, 10000)
  }

  const handlePressOut = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
      copyVersionInfo()
    }
  }

  if (devMode) {
    return (
      <TouchableOpacity onPressIn={handlePressIn} onPressOut={handlePressOut}>
        <View className="items-center bottom-2 w-full py-2 rounded-xl mt-16">
          <View className="flex-row gap-2">
            <Text
              style={themed($buildInfo)}
              text={translate("common:version", {number: process.env.EXPO_PUBLIC_MENTRAOS_VERSION})}
            />
            <Text style={themed($buildInfo)} text={`${process.env.EXPO_PUBLIC_BUILD_BRANCH}`} />
          </View>
          <View className="flex-row gap-2">
            <Text style={themed($buildInfo)} text={`${process.env.EXPO_PUBLIC_BUILD_TIME}`} />
            <Text style={themed($buildInfo)} text={`${process.env.EXPO_PUBLIC_BUILD_COMMIT}`} />
          </View>
          <View className="flex-row gap-2">
            <Text style={themed($buildInfo)} text={storeUrl} />
          </View>
          <View className="flex-row gap-2">
            <Text style={themed($buildInfo)} text={`${backendUrl}`} />
          </View>
          <View className="flex-row gap-2">
            <Text style={themed($buildInfo)} text={`audio: ${audioTransport}`} />
          </View>
        </View>
      </TouchableOpacity>
    )
  }

  return (
    <TouchableOpacity onPress={handleQuickPress}>
      <View className="items-center bottom-2 w-full py-2 rounded-xl mt-16">
        <View className="flex-row gap-2">
          <Text
            style={themed($buildInfo)}
            text={translate("common:version", {number: process.env.EXPO_PUBLIC_MENTRAOS_VERSION})}
          />
        </View>
      </View>
    </TouchableOpacity>
  )
}

const $buildInfo: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.muted_foreground,
  fontSize: 13,
})
