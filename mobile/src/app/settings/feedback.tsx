import Constants from "expo-constants"
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
import {translate} from "@/i18n"
import restComms from "@/services/RestComms"
import {useAppletStatusStore} from "@/stores/applets"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting} from "@/stores/settings"
import {$styles, ThemedStyle} from "@/theme"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"
import {useAppTheme} from "@/utils/useAppTheme"

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
  const apps = useAppletStatusStore(state => state.apps)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  // Glasses info for bug reports
  const glassesConnected = useGlassesStore(state => state.connected)
  const glassesModelName = useGlassesStore(state => state.modelName)
  const glassesBluetoothName = useGlassesStore(state => state.bluetoothName)
  const glassesBuildNumber = useGlassesStore(state => state.buildNumber)
  const glassesFwVersion = useGlassesStore(state => state.fwVersion)
  const glassesAppVersion = useGlassesStore(state => state.appVersion)
  const glassesSerialNumber = useGlassesStore(state => state.serialNumber)
  const glassesAndroidVersion = useGlassesStore(state => state.androidVersion)
  const glassesWifiConnected = useGlassesStore(state => state.wifiConnected)
  const glassesWifiSsid = useGlassesStore(state => state.wifiSsid)
  const glassesBatteryLevel = useGlassesStore(state => state.batteryLevel)

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

    let feedbackBody = ""

    if (feedbackType === "bug") {
      feedbackBody = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    h2 { color: #d32f2f; border-bottom: 2px solid #d32f2f; padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #f5f5f5; padding: 12px; text-align: left; font-weight: 600; border: 1px solid #ddd; }
    td { padding: 12px; border: 1px solid #ddd; }
    .severity { font-weight: bold; color: ${severityRating && severityRating >= 4 ? "#d32f2f" : severityRating && severityRating >= 3 ? "#ff9800" : "#4caf50"}; }
  </style>
</head>
<body>
  <div class="container">
    <h2>🐛 Bug Report</h2>
    <table>
      <tr>
        <th width="30%">Expected Behavior</th>
        <td>${expectedBehavior}</td>
      </tr>
      <tr>
        <th>Actual Behavior</th>
        <td>${actualBehavior}</td>
      </tr>
      <tr>
        <th>Severity Rating</th>
        <td class="severity">${severityRating}/5</td>
      </tr>
    </table>
  </div>
</body>
</html>`
    } else {
      feedbackBody = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    h2 { color: #00b869; border-bottom: 2px solid #00b869; padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #f5f5f5; padding: 12px; text-align: left; font-weight: 600; border: 1px solid #ddd; }
    td { padding: 12px; border: 1px solid #ddd; }
    .rating { color: #00b869; font-size: 1.2em; }
  </style>
</head>
<body>
  <div class="container">
    <h2>💡 Feature Request</h2>
    <table>
      <tr>
        <th width="30%">Feedback</th>
        <td>${feedbackText}</td>
      </tr>
      <tr>
        <th>Experience Rating</th>
        <td class="rating">${"⭐".repeat(experienceRating || 0)} ${experienceRating}/5</td>
      </tr>
    </table>
  </div>
</body>
</html>`
    }

    console.log("Feedback submitted:", feedbackBody)

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

    // Running apps
    const runningApps = apps.filter(app => app.running).map(app => app.packageName)
    const runningAppsText = runningApps.length > 0 ? runningApps.join(", ") : "None"

    // Build glasses info section (only if glasses are connected and have info)
    const glassesBluetoothId = glassesBluetoothName?.split("_").pop() || glassesBluetoothName
    const glassesInfoHtml = glassesConnected
      ? `
    <h3 style="color: #666; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px;">🕶️ Glasses Information</h3>
    <table>
      <tr><th>Model</th><td>${glassesModelName || "Unknown"}</td></tr>
      ${glassesBluetoothId ? `<tr><th>Device ID</th><td>${glassesBluetoothId}</td></tr>` : ""}
      ${glassesSerialNumber ? `<tr><th>Serial Number</th><td>${glassesSerialNumber}</td></tr>` : ""}
      ${glassesBuildNumber ? `<tr><th>Build Number</th><td>${glassesBuildNumber}</td></tr>` : ""}
      ${glassesFwVersion ? `<tr><th>Firmware Version</th><td>${glassesFwVersion}</td></tr>` : ""}
      ${glassesAppVersion ? `<tr><th>Glasses App Version</th><td>${glassesAppVersion}</td></tr>` : ""}
      ${glassesAndroidVersion ? `<tr><th>Android Version</th><td>${glassesAndroidVersion}</td></tr>` : ""}
      <tr><th>WiFi Connected</th><td>${glassesWifiConnected ? "Yes" : "No"}</td></tr>
      ${glassesWifiConnected && glassesWifiSsid ? `<tr><th>WiFi Network</th><td>${glassesWifiSsid}</td></tr>` : ""}
      ${glassesBatteryLevel >= 0 ? `<tr><th>Battery Level</th><td>${glassesBatteryLevel}%</td></tr>` : ""}
    </table>`
      : ""

    // Add diagnostic info to HTML
    const diagnosticInfoHtml = `
    <h3 style="color: #666; margin-top: 30px; border-top: 1px solid #ddd; padding-top: 20px;">📱 System Information</h3>
    <table>
      ${isApplePrivateRelay && email ? `<tr><th>Contact Email</th><td>${email}</td></tr>` : ""}
      <tr><th>App Version</th><td>${appVersion}</td></tr>
      <tr><th>Device</th><td>${deviceName}</td></tr>
      <tr><th>OS</th><td>${osVersion}</td></tr>
      <tr><th>Platform</th><td>${Platform.OS}</td></tr>
      <tr><th>Glasses Connected</th><td>${glassesConnected ? "Yes" : "No"}</td></tr>
      <tr><th>Default Wearable</th><td>${defaultWearable}</td></tr>
      <tr><th>Running Apps</th><td>${runningAppsText}</td></tr>
      ${isBetaBuild ? `<tr><th>Beta Build</th><td>Yes</td></tr>` : ""}
      ${isBetaBuild ? `<tr><th>Backend URL</th><td>${customBackendUrl}</td></tr>` : ""}
      <tr><th>Build Commit</th><td>${buildCommit}</td></tr>
      <tr><th>Build Branch</th><td>${buildBranch}</td></tr>
      <tr><th>Build Time</th><td>${buildTime}</td></tr>
      <tr><th>Build User</th><td>${buildUser}</td></tr>
    </table>
    ${glassesInfoHtml}
  </div>
</body>
</html>`

    // Combine feedback with diagnostic info
    const fullFeedback = feedbackBody.replace("</div>\n</body>\n</html>", diagnosticInfoHtml)
    console.log("Full Feedback submitted:", fullFeedback)
    const res = await restComms.sendFeedback(fullFeedback)
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
    <Screen preset="fixed" style={themed($styles.screen)}>
      <Header title={translate("feedback:giveFeedback")} leftIcon="chevron-left" onLeftPress={goBack} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{flex: 1}}>
        <ScrollView contentContainerStyle={themed($scrollContainer)} keyboardShouldPersistTaps="handled">
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
                onValueChange={value => setFeedbackType(value as "bug" | "feature")}
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

const $scrollContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexGrow: 1,
  paddingVertical: spacing.s4,
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
