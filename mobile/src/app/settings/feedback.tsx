import CoreModule from "core"
import NetInfo from "@react-native-community/netinfo"
import Constants from "expo-constants"
import * as ImagePicker from "expo-image-picker"
import * as Location from "expo-location"
import {useState, useEffect} from "react"
import {Image, Platform, Pressable, ScrollView, TextInput, View, Linking, ActivityIndicator} from "react-native"

import {Button, Header, Screen, Text} from "@/components/ignite"
import {RadioGroup, RatingButtons, StarRating} from "@/components/ui"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {logBuffer} from "@/services/LogRingBuffer"
import restComms from "@/services/RestComms"
import {useAppletStatusStore} from "@/stores/applets"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
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
  const [screenshots, setScreenshots] = useState<ImagePicker.ImagePickerAsset[]>([])

  const MAX_SCREENSHOTS = 5

  const {goBack} = useNavigationHistory()
  const {theme} = useAppTheme()
  const apps = useAppletStatusStore((state) => state.apps)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  // Glasses info for bug reports
  const glassesConnected = useGlassesStore((state) => state.connected)
  const deviceModel = useGlassesStore((state) => state.deviceModel)
  const glassesBluetoothName = useGlassesStore((state) => state.bluetoothName)
  const buildNumber = useGlassesStore((state) => state.buildNumber)
  const glassesFwVersion = useGlassesStore((state) => state.fwVersion)
  const appVersion = useGlassesStore((state) => state.appVersion)
  const serialNumber = useGlassesStore((state) => state.serialNumber)
  const androidVersion = useGlassesStore((state) => state.androidVersion)
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

  const pickScreenshots = async () => {
    // Request permission
    const {status} = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (status !== "granted") {
      showAlert(translate("common:error"), translate("feedback:photoPermissionRequired"), [
        {text: translate("common:ok")},
      ])
      return
    }

    // Launch image picker
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: MAX_SCREENSHOTS - screenshots.length,
      quality: 0.8,
    })

    if (!result.canceled && result.assets.length > 0) {
      setScreenshots((prev) => [...prev, ...result.assets].slice(0, MAX_SCREENSHOTS))
    }
  }

  const removeScreenshot = (index: number) => {
    setScreenshots((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmitFeedback = async () => {
    setIsSubmitting(true)

    // Check if user rated 4-5 stars on feature request
    const shouldPromptAppRating = feedbackType === "feature" && experienceRating !== null && experienceRating >= 4

    // Collect diagnostic information
    const customBackendUrl = process.env.EXPO_PUBLIC_BACKEND_URL_OVERRIDE
    const isBetaBuild = !!customBackendUrl
    const osVersion = `${Platform.OS} ${Platform.Version}`
    const deviceName = Constants.deviceName || "deviceName"
    const mobileAppVersion = process.env.EXPO_PUBLIC_MENTRAOS_VERSION || "version"
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
        appVersion: mobileAppVersion,
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
          deviceModel: deviceModel || undefined,
          bluetoothId: glassesBluetoothId || undefined,
          serialNumber: serialNumber || undefined,
          buildNumber: buildNumber || undefined,
          fwVersion: glassesFwVersion || undefined,
          appVersion: appVersion || undefined,
          androidVersion: androidVersion || undefined,
          wifiConnected: glassesWifiConnected,
          ...(glassesWifiConnected && glassesWifiSsid && {wifiSsid: glassesWifiSsid}),
          ...(glassesBatteryLevel >= 0 && {batteryLevel: glassesBatteryLevel}),
        },
      }),
    }

    console.log("Feedback submitted:", JSON.stringify(feedbackData, null, 2))

    // Bug reports use the incidents endpoint, feature requests use feedback endpoint
    if (feedbackType === "bug") {
      // Collect phone state snapshot from stores
      // Only send installed package names for applets (not full details - that's public info we can query)
      const appletState = useAppletStatusStore.getState()

      // Get settings but filter out sensitive keys (tokens, credentials)
      const settingsState = useSettingsStore.getState()
      const SENSITIVE_KEYS = ["core_token", "auth_token", "auth_email"]
      const filteredSettings = Object.fromEntries(
        Object.entries(settingsState.settings || {}).filter(([key]) => !SENSITIVE_KEYS.includes(key)),
      )

      const phoneState = {
        glasses: useGlassesStore.getState(),
        installedApplets: appletState.apps.map((app) => app.packageName),
        settings: filteredSettings,
      }

      const phoneBackendUrl = useSettingsStore.getState().getRestUrl()
      console.log("Phone backend URL (incident creation):", phoneBackendUrl)

      // Create incident for bug report
      const res = await restComms.createIncident(feedbackData, phoneState)

      if (res.is_error()) {
        setIsSubmitting(false)
        console.error("Error creating incident:", res.error)
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

      const {incidentId} = res.value

      // Upload phone logs from ring buffer
      const phoneLogs = logBuffer.getRecentLogs()
      if (phoneLogs.length > 0) {
        console.log(`Uploading ${phoneLogs.length} phone logs to incident ${incidentId}`)
        const logsRes = await restComms.uploadIncidentLogs(incidentId, phoneLogs)
        if (logsRes.is_error()) {
          console.error("Error uploading phone logs:", logsRes.error)
          // Don't block - incident already created successfully
        }
      }

      // Trigger glasses to upload their own logs directly over WiFi (fire-and-forget)
      if (glassesConnected) {
        CoreModule.sendIncidentId(incidentId).catch(() => {})
      }

      // Upload screenshots if any
      if (screenshots.length > 0) {
        console.log(`Uploading ${screenshots.length} screenshots to incident ${incidentId}`)
        const uploadRes = await restComms.uploadIncidentAttachments(incidentId, screenshots)
        if (uploadRes.is_error()) {
          console.error("Error uploading screenshots:", uploadRes.error)
          // Don't block - incident already created successfully
        }
      }
    } else {
      // Feature request - use feedback endpoint
      const res = await restComms.sendFeedback(feedbackData)

      if (res.is_error()) {
        setIsSubmitting(false)
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
    }

    setIsSubmitting(false)

    // Clear form
    setFeedbackText("")
    setExpectedBehavior("")
    setActualBehavior("")
    setSeverityRating(null)
    setExperienceRating(null)
    setScreenshots([])

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
      return !!((expectedBehavior.trim() || actualBehavior.trim()) && severityRating !== null)
    } else {
      return !!(feedbackText.trim() && experienceRating !== null)
    }
  }

  return (
    <Screen preset="fixed">
      <Header title={translate("feedback:giveFeedback")} leftIcon="chevron-left" onLeftPress={goBack} />
      <ScrollView
        className="pt-6 -mx-6 px-6"
        contentContainerClassName="flex-grow pb-12"
        keyboardShouldPersistTaps="handled">
        <View className="gap-6">
          {isApplePrivateRelay && (
            <View>
              <Text className="text-sm font-semibold text-foreground mb-2">{translate("feedback:emailOptional")}</Text>
              <TextInput
                className="bg-background border border-border rounded-xl p-4 text-base text-foreground"
                value={email}
                onChangeText={setEmail}
                placeholder={translate("feedback:email")}
                placeholderTextColor={theme.colors.muted_foreground}
                keyboardType="email-address"
                autoCapitalize="none"
              />
            </View>
          )}

          <View>
            <Text className="text-sm font-semibold text-foreground mb-2">{translate("feedback:type")}</Text>
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
                <Text className="text-sm font-semibold text-foreground mb-2">
                  {translate("feedback:expectedBehavior")}
                </Text>
                <TextInput
                  className="bg-background border border-border rounded-xl p-4 text-base text-foreground min-h-[120px]"
                  multiline
                  numberOfLines={4}
                  placeholder={translate("feedback:share")}
                  placeholderTextColor={theme.colors.muted_foreground}
                  value={expectedBehavior}
                  onChangeText={setExpectedBehavior}
                  textAlignVertical="top"
                />
              </View>

              <View>
                <Text className="text-sm font-semibold text-foreground mb-2">
                  {translate("feedback:actualBehavior")}
                </Text>
                <TextInput
                  className="bg-background border border-border rounded-xl p-4 text-base text-foreground min-h-[120px]"
                  multiline
                  numberOfLines={4}
                  placeholder={translate("feedback:actualShare")}
                  placeholderTextColor={theme.colors.muted_foreground}
                  value={actualBehavior}
                  onChangeText={setActualBehavior}
                  textAlignVertical="top"
                />
              </View>

              <View>
                <Text className="text-sm font-semibold text-foreground mb-2">
                  {translate("feedback:severityRating")}
                </Text>
                <Text className="text-xs text-muted-foreground mb-3">{translate("feedback:ratingScale")}</Text>
                <RatingButtons value={severityRating} onValueChange={setSeverityRating} />
              </View>

              {/* Screenshots Section */}
              <View>
                <Text className="text-sm font-semibold text-foreground mb-2">{translate("feedback:screenshots")}</Text>
                <Text className="text-xs text-muted-foreground mb-3">{translate("feedback:screenshotsHint")}</Text>

                {/* Screenshot Thumbnails */}
                {screenshots.length > 0 && (
                  <View className="flex-row flex-wrap gap-2 mb-3">
                    {screenshots.map((image, index) => (
                      <View key={image.uri} className="relative">
                        <Image source={{uri: image.uri}} className="w-20 h-20 rounded-lg" resizeMode="cover" />
                        <Pressable
                          onPress={() => removeScreenshot(index)}
                          className="absolute -top-2 -right-2 bg-destructive rounded-full w-6 h-6 items-center justify-center">
                          <Text className="text-white text-xs font-bold">X</Text>
                        </Pressable>
                      </View>
                    ))}
                  </View>
                )}

                {/* Add Screenshot Button */}
                {screenshots.length < MAX_SCREENSHOTS && (
                  <Pressable
                    onPress={pickScreenshots}
                    className="border-2 border-dashed border-border rounded-xl p-4 items-center justify-center">
                    <Text className="text-muted-foreground">
                      {screenshots.length === 0 ? translate("feedback:addScreenshots") : translate("feedback:addMore")}
                    </Text>
                    <Text className="text-xs text-muted-foreground mt-1">
                      {screenshots.length}/{MAX_SCREENSHOTS}
                    </Text>
                  </Pressable>
                )}
              </View>
            </>
          ) : (
            <>
              <View>
                <Text className="text-sm font-semibold text-foreground mb-2">
                  {translate("feedback:feedbackLabel")}
                </Text>
                <TextInput
                  className="bg-background border border-border rounded-xl p-4 text-base text-foreground min-h-[120px]"
                  multiline
                  numberOfLines={6}
                  placeholder={translate("feedback:shareThoughts")}
                  placeholderTextColor={theme.colors.muted_foreground}
                  value={feedbackText}
                  onChangeText={setFeedbackText}
                  textAlignVertical="top"
                />
              </View>

              <View>
                <Text className="text-sm font-semibold text-foreground mb-2">
                  {translate("feedback:experienceRating")}
                </Text>
                <Text className="text-xs text-muted-foreground mb-3">{translate("feedback:ratingScale")}</Text>
                <StarRating value={experienceRating} onValueChange={setExperienceRating} />
              </View>
            </>
          )}
        </View>
        <View className="flex-1 min-h-6" />
        <Button
          text={
            isSubmitting ? "" : feedbackType === "bug" ? translate("feedback:continue") : translate("feedback:submit")
          }
          onPress={handleSubmitFeedback}
          disabled={!isFormValid() || isSubmitting}
          preset="primary">
          {isSubmitting && <ActivityIndicator color={theme.colors.background} />}
        </Button>
      </ScrollView>
    </Screen>
  )
}
