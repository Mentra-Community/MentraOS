import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useAppTheme} from "@/utils/useAppTheme"
import {TextStyle, TouchableOpacity, View, ViewStyle} from "react-native"
import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import * as Clipboard from "expo-clipboard"
import Toast from "react-native-toast-message"
import showAlert from "@/utils/AlertUtils"
import {useRef} from "react"
import mentraAuth from "@/utils/auth/authClient"

export const VersionInfo = () => {
  const {theme, themed} = useAppTheme()
  const [devMode, setDevMode] = useSetting(SETTINGS.dev_mode.key)
  const [storeUrl] = useSetting(SETTINGS.store_url.key)
  const [backendUrl] = useSetting(SETTINGS.backend_url.key)

  const pressCount = useRef(0)
  const lastPressTime = useRef(0)
  const pressTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

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

    // Clear existing timeout
    if (pressTimeout.current) {
      clearTimeout(pressTimeout.current)
    }

    // Handle different press counts
    if (pressCount.current === maxPressCount) {
      showAlert("Developer Mode", "Developer mode enabled!", [{text: translate("common:ok")}])
      setDevMode(true)
      pressCount.current = 0
    } else if (pressCount.current >= showAlertAtPressCount) {
      const remaining = maxPressCount - pressCount.current
      Toast.show({
        type: "info",
        text1: "Developer Mode",
        text2: `${remaining} more taps to enable developer mode`,
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

  const handlePress = async () => {
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
    ]

    if (user) {
      info.push(`id: ${user.id}`)
      info.push(`email: ${user.email}`)
    }

    await Clipboard.setStringAsync(info.join("\n"))
    Toast.show({
      type: "info",
      text1: "Version info copied to clipboard",
      position: "bottom",
      topOffset: 80,
      visibilityTime: 1000,
    })
  }

  if (devMode) {
    return (
      <TouchableOpacity onPress={handlePress}>
        <View style={themed($versionContainer)}>
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
        </View>
      </TouchableOpacity>
    )
  }

  return (
    <TouchableOpacity onPress={handleQuickPress}>
      <View style={themed($versionContainer)}>
        <View style={{flexDirection: "row", gap: theme.spacing.s2}}>
          <Text
            style={themed($buildInfo)}
            text={translate("common:version", {number: process.env.EXPO_PUBLIC_MENTRAOS_VERSION})}
          />
        </View>
      </View>
    </TouchableOpacity>
  )
}

const $versionContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  alignItems: "center",
  bottom: spacing.s2,
  width: "100%",
  paddingVertical: spacing.s2,
  borderRadius: spacing.s4,
  marginTop: spacing.s16,
})

const $buildInfo: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  fontSize: 13,
})
