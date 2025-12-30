// SensingDisabledWarning.tsx
import {MaterialCommunityIcons} from "@expo/vector-icons"
import {useEffect, useState} from "react"
import {TouchableOpacity, ViewStyle, Platform, Linking} from "react-native"

import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import {useAppTheme} from "@/contexts/ThemeContext"

export default function NonProdWarning() {
  const {theme, themed} = useAppTheme()
  const [isProdBackend, setIsProdBackend] = useState(true)
  const {push} = useNavigationHistory()
  const [backendUrl, _setBackendUrl] = useSetting(SETTINGS.backend_url.key)

  const checkNonProdBackend = async () => {
    let isProd = false
    if (
      backendUrl.includes("prod.augmentos.cloud") ||
      backendUrl.includes("global.augmentos.cloud") ||
      backendUrl.includes("api.mentra.glass") ||
      backendUrl.includes("api.mentraglass.cn")
    ) {
      isProd = true
    }

    if (backendUrl.includes("devapi")) {
      isProd = false
    }

    setIsProdBackend(isProd)
  }

  useEffect(() => {
    checkNonProdBackend()
  }, [backendUrl])

  if (isProdBackend) {
    return null
  }

  // return (
  //   <View style={[styles.sensingWarningContainer, {backgroundColor: "#FFF3E0", borderColor: "#FFB74D"}]}>
  //     <View style={styles.warningContent}>
  //       <Icon name="alert" size={22} color="#FF9800" />
  //       <Text style={themed($warningText)} tx="warning:nonProdBackend" />
  //     </View>
  //     <TouchableOpacity
  //       style={styles.settingsButton}
  //       onPress={() => {
  //         push("/settings/developer")
  //       }}>
  //       <Text style={styles.settingsButtonTextBlue}>Settings</Text>
  //     </TouchableOpacity>
  //   </View>
  // )

  const nonProdWarning = () => {
    const isBetaBuild = !!process.env.EXPO_PUBLIC_BACKEND_URL_OVERRIDE

    if (isBetaBuild) {
      // Beta build warning
      if (Platform.OS === "ios") {
        // iOS TestFlight build
        showAlert(translate("warning:testFlightBuild"), "", [
          {
            text: translate("settings:feedback"),
            onPress: () => {
              push("/settings/feedback")
            },
          },
          {text: translate("common:ok"), onPress: () => {}},
        ])
      } else {
        // Android Beta build - show opt-out first, then feedback
        showAlert(translate("warning:betaBuild"), "", [
          {
            text: translate("warning:optOutOfBeta"),
            onPress: () => {
              Linking.openURL("https://play.google.com/apps/testing/com.mentra.mentra")
            },
          },
          {
            text: translate("common:ok"),
            onPress: () => {
              // After dismissing, offer feedback option
              showAlert(translate("warning:betaBuild"), "", [
                {
                  text: translate("settings:feedback"),
                  onPress: () => {
                    push("/settings/feedback")
                  },
                },
                {text: translate("common:ok"), onPress: () => {}},
              ])
            },
          },
        ])
      }
    } else {
      // Developer/non-production backend warning
      showAlert(translate("warning:nonProdBackend"), "", [
        {
          text: translate("settings:developerSettings"),
          onPress: () => {
            push("/settings/developer")
          },
        },
        {text: translate("common:ok"), onPress: () => {}},
      ])
    }
  }

  return (
    <TouchableOpacity style={themed($settingsButton)} onPress={nonProdWarning}>
      <MaterialCommunityIcons name="alert" size={theme.spacing.s6} color={theme.colors.text} />
    </TouchableOpacity>
  )
}

const $settingsButton: ThemedStyle<ViewStyle> = ({spacing}) => ({
  padding: spacing.s3,
})
