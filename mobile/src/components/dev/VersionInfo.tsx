import * as Clipboard from "expo-clipboard"
import {useRef} from "react"
import {Linking, TextStyle, TouchableOpacity, View} from "react-native"
import Toast from "react-native-toast-message"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useAuth} from "@/contexts/AuthContext"
import {useEngineSnapshot} from "@/hooks/useEngineSnapshot"
import {translate} from "@/i18n"
import {resolvedEndpoints} from "@/services/cloudClient"
import {engine, SETTINGS, useSetting, getAppBuildInfo} from "@mentra/engine"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"

export const VersionInfo = () => {
  const {themed} = useAppTheme()
  const buildInfo = getAppBuildInfo()
  const {user} = useAuth()
  const [debugMode, setDebugMode] = useSetting(SETTINGS.debug_mode.key)
  const [_superMode, setSuperMode] = useSetting(SETTINGS.super_mode.key)
  useSetting(SETTINGS.cloud_core_url.key)
  const coreUrl = resolvedEndpoints().core
  const audioTransport = useEngineSnapshot(engine.session.status, (onChange) =>
    engine.session.onStatus(onChange),
  ).audioTransport

  const pressCount = useRef(0)
  const lastPressTime = useRef(0)
  const pressTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleQuickPress = () => {
    const currentTime = Date.now()
    const timeDiff = currentTime - lastPressTime.current
    const maxTimeDiff = 2000
    const maxPressCount = 10

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

    // Enable debug mode once the version number has been tapped enough times.
    if (pressCount.current === maxPressCount) {
      showAlert(translate("debug:debugModeEnabled"), translate("debug:debugModeEnabled"), [
        {text: translate("common:ok")},
      ])
      setDebugMode(true)
      pressCount.current = 0
    }

    // Reset counter after 2 seconds of no activity
    pressTimeout.current = setTimeout(() => {
      pressCount.current = 0
    }, maxTimeDiff)
  }

  const copyVersionInfo = async () => {
    const info = [
      `version: ${buildInfo.appVersion}`,
      `branch: ${buildInfo.buildBranch}`,
      `time: ${buildInfo.buildTime}`,
      `commit: ${buildInfo.buildCommit}`,
      `cloud_core_url: ${resolvedEndpoints().core}`,
      `cloud_runtime_url: ${resolvedEndpoints().runtime}`,
      `audio: ${audioTransport}`,
    ]

    if (user) {
      info.push(`id: ${user.id}`)
      info.push(`email: ${user.email}`)
    }

    await Clipboard.setStringAsync(info.join("\n"))
    if (debugMode) {
      Toast.show({
        type: "info",
        text1: translate("debug:versionInfoCopied"),
        position: "bottom",
        topOffset: 80,
        visibilityTime: 1000,
      })
    }
  }

  const handlePressIn = () => {
    longPressTimer.current = setTimeout(() => {
      setSuperMode(true)
      // showAlert(translate("debug:superMode"), translate("debug:superModeActivated"), [{text: translate("common:ok")}])
      Toast.show({
        type: "success",
        text1: translate("debug:superModeActivated"),
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

  if (debugMode) {
    return (
      <TouchableOpacity onPressIn={handlePressIn} onPressOut={handlePressOut}>
        <View className="items-center bottom-2 w-full py-2 rounded-xl mt-16">
          <View className="flex-row gap-2">
            <Text style={themed($buildInfo)} text={translate("common:version", {number: buildInfo.appVersion})} />
            <Text style={themed($buildInfo)} text={`${buildInfo.buildBranch}`} />
          </View>
          <View className="flex-row gap-2">
            <Text style={themed($buildInfo)} text={`${buildInfo.buildTime}`} />
            <Text style={themed($buildInfo)} text={`${buildInfo.buildCommit}`} />
          </View>
          <View className="flex-row gap-2">
            <Text style={themed($buildInfo)} text={`${coreUrl || "(default cloud)"}`} />
          </View>
          <View className="flex-row gap-2">
            <Text style={themed($buildInfo)} text={`audio: ${audioTransport}`} />
          </View>
        </View>
      </TouchableOpacity>
    )
  }

  const isChina = process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china"

  return (
    <TouchableOpacity onPress={handleQuickPress}>
      <View className="items-center bottom-2 w-full py-2 rounded-xl mt-16">
        <View className="flex-row gap-2">
          <Text style={themed($buildInfo)} text={translate("common:version", {number: buildInfo.appVersion})} />
        </View>
        {isChina && (
          <TouchableOpacity onPress={() => Linking.openURL("https://beian.miit.gov.cn/")}>
            <Text style={themed($icpLink)} text="京ICP备04000001号-2" />
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  )
}

const $buildInfo: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.muted_foreground,
  fontSize: 13,
})

const $icpLink: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.muted_foreground,
  fontSize: 13,
  textDecorationLine: "underline",
})
