import NetInfo from "@react-native-community/netinfo"
import Constants from "expo-constants"
import * as Location from "expo-location"
import {useState, useEffect} from "react"
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  TextStyle,
  View,
  ViewStyle,
  Linking,
  ActivityIndicator,
} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {RadioGroup, RatingButtons, StarRating} from "@/components/ui"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import restComms from "@/services/RestComms"
import {useAppletStatusStore} from "@/stores/applets"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"

export default function FeedbackPage() {
  const [email, setEmail] = useState("")
  const [feedbackType, setFeedbackType] = useState<"bug" | "feature">("bug")
  const [expectedBehavior, setExpectedBehavior] = useState("")
  const [actualBehavior, setActualBehavior] = useState("")
  const [severityRating, setSeverityRating] = useState<number | null>(null)
  const [feedbackText, setFeedbackText] = useState("")
  const [experienceRating, setExperienceRating] = useState<number | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const {goBack} = useNavigationHistory()
  const {theme, themed} = useAppTheme()
  const apps = useAppletStatusStore((state) => state.apps)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  // Glasses info for bug reports
  const glassesConnected = useGlassesStore((state) => state.connected)
  const glassesModelName = useGlassesStore((state) => state.modelName)
  const glassesBluetoothName = useGlassesStore((state) => state.bluetoothName)
  const glassesBuildNumber = useGlassesStore((state) => state.buildNumber)
  const glassesFwVersion = useGlassesStore((state) => state.fwVersion)
  const glassesAppVersion = useGlassesStore((state) => state.appVersion)
  const glassesSerialNumber = useGlassesStore((state) => state.serialNumber)
  const glassesAndroidVersion = useGlassesStore((state) => state.androidVersion)
  const glassesWifiConnected = useGlassesStore((state) => state.wifiConnected)
  const glassesWifiSsid = useGlassesStore((state) => state.wifiSsid)
  const glassesBatteryLevel = useGlassesStore((state) => state.batteryLevel)

  const [userEmail, setUserEmail] = useState("")

  useEffect(() => {
    const fetchUserEmail = async () => {
      const res = await mentraAuth.getUser()
      if (res.is_error()) {
        console.error("Error fetching user email:", res.error)
        return
      }
      const user = res.value
      if (user?.email) {
        setUserEmail(user.email)
      }
    }

    fetchUserEmail()
  }, [])

  const isApplePrivateRelay = userEmail.includes("@privaterelay.appleid.com") || userEmail.includes("@icloud.com")

  const handleSubmitFeedback = async () => {
    setIsSubmitting(true)

    // Check if user rated 4-5 stars on feature request
    const shouldPromptAppRating = feedbackType === "feature" && experienceRating !== null && experienceRating >= 4

    // Collect diagnostic information
    const customBackendUrl = process.env.EXPO_PUBLIC_BACKEND_URL_OVERRIDE
    const isBetaBuild = !!customBackendUrl
    const osVersion = `${Platform.OS} ${Platform.Version}`
    const deviceName = Constants.deviceName || "deviceName"
    const appVersion = process.env.EXPO_PUBLIC_MENTRAOS_VERSION || "version"
    const buildCommit = process.env.EXPO_PUBLIC_BUILD_COMMIT || "commit"
    const buildBranch = process.env.EXPO_PUBLIC_BUILD_BRANCH || "branch"
    const buildTime = process.env.EXPO_PUBLIC_BUILD_TIME || "time"
    const buildUser = process.env.EXPO_PUBLIC_BUILD_USER || "user"

    // Get offline mode status
    const offlineMode = await useSettingsStore.getState().getSetting(SETTINGS.offline_mode.key)

    // Get network connectivity info
    let networkInfo = {type: "unknown", isConnected: false, isInternetReachable: false}
    try {
      const netState = await NetInfo.fetch()
      networkInfo = {
        type: netState.type,
        isConnected: netState.isConnected ?? false,
        isInternetReachable: netState.isInternetReachable ?? false,
      }
    } catch (e) {
      console.log("Failed to get network info:", e)
    }

    // Get location if permission is granted
    let locationInfo: string | undefined
    let locationPlace: string | undefined
    try {
      const {status} = await Location.getForegroundPermissionsAsync()
      if (status === "granted") {
        const location = await Location.getLastKnownPositionAsync()
        if (location) {
          locationInfo = `${location.coords.latitude.toFixed(4)}, ${location.coords.longitude.toFixed(4)}`
          // Try to get human-readable location
          try {
            const [place] = await Location.reverseGeocodeAsync({
              latitude: location.coords.latitude,
              longitude: location.coords.longitude,
            })
            if (place) {
              const parts = [place.city, place.region, place.country].filter(Boolean)
              if (parts.length > 0) {
                locationPlace = parts.join(", ")
              }
            }
          } catch (e) {
            console.log("Failed to reverse geocode:", e)
          }
        }
      }
    } catch (e) {
      console.log("Failed to get location:", e)
    }

    // Running apps
    const runningApps = apps.filter((app) => app.running).map((app) => app.packageName)

    // Build glasses info (only if glasses are connected)
    const glassesBluetoothId = glassesBluetoothName?.split("_").pop() || glassesBluetoothName

    // Build structured feedback JSON
    const feedbackData = {
      type: feedbackType,
      // Bug report fields
      ...(feedbackType === "bug" && {
        expectedBehavior: expectedBehavior,
        actualBehavior: actualBehavior,
        severityRating: severityRating ?? undefined,
      }),
      // Feature request fields
      ...(feedbackType === "feature" && {
        feedbackText: feedbackText,
        experienceRating: experienceRating ?? undefined,
      }),
      // Contact email for Apple private relay users
      ...(isApplePrivateRelay && email && {contactEmail: email}),
      // System information
      systemInfo: {
        appVersion,
        deviceName,
        osVersion,
        platform: Platform.OS,
        glassesConnected,
        defaultWearable: defaultWearable as string,
        runningApps,
        offlineMode: !!offlineMode,
        networkType: networkInfo.type,
        networkConnected: networkInfo.isConnected,
        internetReachable: networkInfo.isInternetReachable,
        ...(locationInfo && {location: locationInfo}),
        ...(locationPlace && {locationPlace}),
        ...(isBetaBuild && {isBetaBuild: true}),
        ...(isBetaBuild && customBackendUrl && {backendUrl: customBackendUrl}),
        buildCommit,
        buildBranch,
        buildTime,
        buildUser,
      },
      // Glasses information (only if connected)
      ...(glassesConnected && {
        glassesInfo: {
          modelName: glassesModelName || undefined,
          bluetoothId: glassesBluetoothId || undefined,
          serialNumber: glassesSerialNumber || undefined,
          buildNumber: glassesBuildNumber || undefined,
          fwVersion: glassesFwVersion || undefined,
          appVersion: glassesAppVersion || undefined,
          androidVersion: glassesAndroidVersion || undefined,
          wifiConnected: glassesWifiConnected,
          ...(glassesWifiConnected && glassesWifiSsid && {wifiSsid: glassesWifiSsid}),
          ...(glassesBatteryLevel >= 0 && {batteryLevel: glassesBatteryLevel}),
        },
      }),
    }

    console.log("Feedback submitted:", JSON.stringify(feedbackData, null, 2))
    const res = await restComms.sendFeedback(feedbackData)
    setIsSubmitting(false)

    if (res.is_error()) {
      console.error("Error sending feedback:", res.error)
      showAlert(translate("common:error"), translate("feedback:errorSendingFeedback"), [
        {
          text: translate("common:ok"),
          onPress: () => {
            goBack()
          },
        },
      ])
      return
    }

    // Clear form
    setFeedbackText("")
    setExpectedBehavior("")
    setActualBehavior("")
    setSeverityRating(null)
    setExperienceRating(null)

    // Show thank you message
    showAlert(translate("feedback:thankYou"), translate("feedback:feedbackReceived"), [
      {
        text: translate("common:ok"),
        onPress: () => {
          goBack()

          // If user rated highly, prompt for app store rating after a delay
          if (shouldPromptAppRating) {
            setTimeout(() => {
              showAlert(translate("feedback:rateApp"), translate("feedback:rateAppMessage"), [
                {text: translate("feedback:notNow"), style: "cancel"},
                {
                  text: translate("feedback:rateNow"),
                  onPress: () => {
                    const appStoreUrl =
                      Platform.OS === "ios"
                        ? "https://apps.apple.com/app/id6747363193?action=write-review"
                        : "https://play.google.com/store/apps/details?id=com.mentra.mentra"
                    Linking.openURL(appStoreUrl)
                  },
                },
              ])
            }, 500)
          }
        },
      },
    ])
  }

  const isFormValid = (): boolean => {
    if (feedbackType === "bug") {
      return !!(expectedBehavior.trim() && actualBehavior.trim() && severityRating !== null)
    } else {
      return !!(feedbackText.trim() && experienceRating !== null)
    }
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("feedback:giveFeedback")} leftIcon="chevron-left" onLeftPress={goBack} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{flex: 1}}>
        <ScrollView
          className="pt-6"
          contentContainerStyle={themed($scrollContainer)}
          keyboardShouldPersistTaps="handled">
          <View style={themed($container)}>
            {isApplePrivateRelay && (
              <View>
                <Text style={themed($label)}>{translate("feedback:emailOptional")}</Text>
                <TextInput
                  style={themed($emailInput)}
                  value={email}
                  onChangeText={setEmail}
                  placeholder={translate("feedback:email")}
                  placeholderTextColor={theme.colors.textDim}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>
            )}

            <View>
              <Text style={themed($label)}>{translate("feedback:type")}</Text>
              <RadioGroup
                options={[
                  {value: "bug", label: translate("feedback:bugReport")},
                  {value: "feature", label: translate("feedback:featureRequest")},
                ]}
                value={feedbackType}
                onValueChange={(value) => setFeedbackType(value as "bug" | "feature")}
              />
            </View>

            {feedbackType === "bug" ? (
              <>
                <View>
                  <Text style={themed($label)}>{translate("feedback:expectedBehavior")}</Text>
                  <TextInput
                    style={themed($textInput)}
                    multiline
                    numberOfLines={4}
                    placeholder={translate("feedback:share")}
                    placeholderTextColor={theme.colors.textDim}
                    value={expectedBehavior}
                    onChangeText={setExpectedBehavior}
                    textAlignVertical="top"
                  />
                </View>

                <View>
                  <Text style={themed($label)}>{translate("feedback:actualBehavior")}</Text>
                  <TextInput
                    style={themed($textInput)}
                    multiline
                    numberOfLines={4}
                    placeholder={translate("feedback:actualShare")}
                    placeholderTextColor={theme.colors.textDim}
                    value={actualBehavior}
                    onChangeText={setActualBehavior}
                    textAlignVertical="top"
                  />
                </View>

                <View>
                  <Text style={themed($label)}>{translate("feedback:severityRating")}</Text>
                  <Text style={themed($subLabel)}>{translate("feedback:ratingScale")}</Text>
                  <RatingButtons value={severityRating} onValueChange={setSeverityRating} />
                </View>
              </>
            ) : (
              <>
                <View>
                  <Text style={themed($label)}>{translate("feedback:feedbackLabel")}</Text>
                  <TextInput
                    style={themed($textInput)}
                    multiline
                    numberOfLines={6}
                    placeholder={translate("feedback:shareThoughts")}
                    placeholderTextColor={theme.colors.textDim}
                    value={feedbackText}
                    onChangeText={setFeedbackText}
                    textAlignVertical="top"
                  />
                </View>

                <View>
                  <Text style={themed($label)}>{translate("feedback:experienceRating")}</Text>
                  <Text style={themed($subLabel)}>{translate("feedback:ratingScale")}</Text>
                  <StarRating value={experienceRating} onValueChange={setExperienceRating} />
                </View>
              </>
            )}

            <Button
              text={
                isSubmitting
                  ? ""
                  : feedbackType === "bug"
                    ? translate("feedback:continue")
                    : translate("feedback:submit")
              }
              onPress={handleSubmitFeedback}
              disabled={!isFormValid() || isSubmitting}
              preset="primary">
              {isSubmitting && <ActivityIndicator color={theme.colors.background} />}
            </Button>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  gap: spacing.s6,
})

const $scrollContainer: ThemedStyle<ViewStyle> = () => ({
  flexGrow: 1,
})

const $label: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  fontWeight: "600",
  color: colors.text,
  marginBottom: spacing.s2,
})

const $subLabel: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 12,
  color: colors.textDim,
  marginBottom: spacing.s3,
})

const $textInput: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: spacing.s3,
  padding: spacing.s4,
  fontSize: 16,
  color: colors.text,
  minHeight: 120,
})

const $emailInput: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: spacing.s3,
  padding: spacing.s4,
  fontSize: 16,
  color: colors.text,
})
