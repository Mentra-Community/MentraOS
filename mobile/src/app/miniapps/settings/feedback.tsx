import {useLocalSearchParams} from "expo-router"
import * as ImagePicker from "expo-image-picker"
import Constants from "expo-constants"
import * as Location from "expo-location"
import NetInfo from "@react-native-community/netinfo"
import {useState, useEffect, useCallback, useRef} from "react"
import {Image, Platform, Pressable, ScrollView, TextInput, View, Linking, ActivityIndicator} from "react-native"

import {Button, Icon, Screen, Text} from "@/components/ignite"
import {RadioGroup, RatingButtons, StarRating} from "@/components/ui"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {buildBugReportFeedbackDataForBug, submitBugIncident} from "@/services/bugReport/bugReportIncident"
import {buildIncidentCategorization} from "@/services/bugReport/incidentCategorization"
import restComms from "@/services/RestComms"
import {useAppStatusStore} from "@mentra/island"

import {feedbackPackageName, settingsPackageName} from "@/constants/miniapps"
import {useGlassesStore} from "@/stores/glasses"
import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"
import mentraAuth from "@/utils/auth/authClient"
import {useNavigationStore} from "@/stores/navigation"
import { useRegisterCapsule } from "@/stores/capsule"

export default function FeedbackPage() {
  const params = useLocalSearchParams<{
    submissionMode?: string
    triggerArea?: string
    triggerReason?: string
    sourceAppletPackageName?: string
    sourceAppletName?: string
  }>()
  const [savedContactEmail, setSavedContactEmail] = useSetting(SETTINGS.contact_email.key)
  const [email, setEmail] = useState((savedContactEmail as string) || "")
  const [feedbackType, setFeedbackType] = useState<"bug" | "feature">("bug")
  const [expectedBehavior, setExpectedBehavior] = useState("")
  const [actualBehavior, setActualBehavior] = useState("")
  const [severityRating, setSeverityRating] = useState<number | null>(null)
  const [feedbackText, setFeedbackText] = useState("")
  const [experienceRating, setExperienceRating] = useState<number | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [screenshots, setScreenshots] = useState<ImagePicker.ImagePickerAsset[]>([])

  const MAX_SCREENSHOTS = 5

  const {theme} = useAppTheme()
  const apps = useAppStatusStore((state) => state.apps)
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const viewShotRef = useRef<View>(null)
  const {goBack} = useNavigationStore.getState()

  useRegisterCapsule({
    packageName: "com.mentra.settings",
    viewShotRef,
    visibleOnRoutes: ["/miniapps/settings/feedback"],
  })

  const resolveScreenshotPackageName = useCallback(() => {
    if (apps.some((app) => app.packageName === feedbackPackageName && app.running)) {
      return feedbackPackageName
    }
    if (apps.some((app) => app.packageName === settingsPackageName && app.running)) {
      return settingsPackageName
    }
    return null
  }, [apps])

  // Glasses info for bug reports
  const glassesConnected = useGlassesStore((state) => state.connected)
  const deviceModel = useGlassesStore((state) => state.deviceModel)
  const glassesBluetoothName = useGlassesStore((state) => state.bluetoothName)
  const buildNumber = useGlassesStore((state) => state.buildNumber)
  const glassesFwVersion = useGlassesStore((state) => state.fwVersion)
  const appVersion = useGlassesStore((state) => state.appVersion)
  const serialNumber = useGlassesStore((state) => state.serialNumber)
  const androidVersion = useGlassesStore((state) => state.androidVersion)
  const glassesWifi = useGlassesStore((state) => state.wifi)
  const glassesWifiInfo =
    glassesWifi.state === "connected"
      ? {wifiConnected: true, wifiSsid: glassesWifi.ssid}
      : {wifiConnected: false}
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

    // Persist the contact email for next time
    if (isApplePrivateRelay && email.trim()) {
      setSavedContactEmail(email.trim())
    }

    // Check if user rated 4-5 stars on feature request
    const shouldPromptAppRating = feedbackType === "feature" && experienceRating !== null && experienceRating >= 4

    // Bug reports use the incidents endpoint, feature requests use feedback endpoint
    if (feedbackType === "bug") {
      const feedbackData = await buildBugReportFeedbackDataForBug({
        expectedBehavior,
        actualBehavior,
        severityRating: severityRating!,
        contactEmail: isApplePrivateRelay && email.trim() ? email.trim() : undefined,
        extraFeedbackFields: buildIncidentCategorization({
          submissionMode: params.submissionMode === "AUTOMATIC" ? "AUTOMATIC" : "USER_INITIATED",
          triggerArea: typeof params.triggerArea === "string" ? params.triggerArea : "feedback_screen",
          triggerReason: typeof params.triggerReason === "string" ? params.triggerReason : "manual_bug_report",
          sourceAppletPackageName:
            typeof params.sourceAppletPackageName === "string" ? params.sourceAppletPackageName : undefined,
          sourceAppletName: typeof params.sourceAppletName === "string" ? params.sourceAppletName : undefined,
        }),
      })

      console.log("Feedback submitted:", JSON.stringify(feedbackData, null, 2))
      console.log("Phone backend URL (incident creation):", useSettingsStore.getState().getRestUrl())

      const submitRes = await submitBugIncident(feedbackData, {screenshots})

      if (!submitRes.ok) {
        setIsSubmitting(false)
        console.error("Error creating incident:", submitRes.error)
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
    } else {
      const customBackendUrl = process.env.EXPO_PUBLIC_BACKEND_URL_OVERRIDE
      const isBetaBuild = !!customBackendUrl
      const osVersion = `${Platform.OS} ${Platform.Version}`
      const deviceName = Constants.deviceName || "deviceName"
      const mobileAppVersion = process.env.EXPO_PUBLIC_MENTRAOS_VERSION || "version"
      const buildCommit = process.env.EXPO_PUBLIC_BUILD_COMMIT || "commit"
      const buildBranch = process.env.EXPO_PUBLIC_BUILD_BRANCH || "branch"
      const buildTime = process.env.EXPO_PUBLIC_BUILD_TIME || "time"
      const buildUser = process.env.EXPO_PUBLIC_BUILD_USER || "user"

      const offlineMode = await useSettingsStore.getState().getSetting(SETTINGS.offline_mode.key)

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

      let locationInfo: string | undefined
      let locationPlace: string | undefined
      try {
        const {status} = await Location.getForegroundPermissionsAsync()
        if (status === "granted") {
          const location = await Location.getLastKnownPositionAsync()
          if (location) {
            locationInfo = `${location.coords.latitude.toFixed(4)}, ${location.coords.longitude.toFixed(4)}`
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

      const runningApps = apps.filter((app) => app.running).map((app) => app.packageName)
      const glassesBluetoothId = glassesBluetoothName?.split("_").pop() || glassesBluetoothName

      const feedbackData = {
        type: feedbackType,
        feedbackText: feedbackText,
        experienceRating: experienceRating ?? undefined,
        ...(isApplePrivateRelay && email && {contactEmail: email}),
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
        ...(glassesConnected && {
          glassesInfo: {
            deviceModel: deviceModel || undefined,
            bluetoothId: glassesBluetoothId || undefined,
            serialNumber: serialNumber || undefined,
            buildNumber: buildNumber || undefined,
            fwVersion: glassesFwVersion || undefined,
            appVersion: appVersion || undefined,
            androidVersion: androidVersion || undefined,
            ...glassesWifiInfo,
            ...(glassesBatteryLevel >= 0 && {batteryLevel: glassesBatteryLevel}),
          },
        }),
      }

      console.log("Feedback submitted:", JSON.stringify(feedbackData, null, 2))
      // Feature request - use feedback endpoint
      const res = await restComms.sendFeedback(feedbackData)

      if (res.is_error()) {
        setIsSubmitting(false)
        console.error("Error sending feedback:", res.error)
        showAlert(translate("common:error"), translate("feedback:errorSendingFeedback"), [
          {
            text: translate("common:ok"),
            onPress: () => {
              void goBack()
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
          void goBack()

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
    // Require email for Apple private relay users
    if (isApplePrivateRelay && !email.trim().includes("@")) {
      return false
    }
    if (feedbackType === "bug") {
      return !!((expectedBehavior.trim() || actualBehavior.trim()) && severityRating !== null)
    } else {
      return !!(feedbackText.trim() && experienceRating !== null)
    }
  }

  return (
      <Screen preset="fixed" ref={viewShotRef} safeAreaEdges={["top", "bottom"]}>
        <View className="h-12 justify-center">
          <Text tx="feedback:giveFeedback" className="text-xl text-foreground" />
        </View>
        <ScrollView
          className="pt-6 -mx-6 px-6"
          contentContainerClassName="flex-grow pb-12"
          keyboardShouldPersistTaps="handled">
          <View className="gap-6">
            <View>
              <View className="flex-row items-center mb-2 gap-1.5">
                <Text className="text-sm font-semibold text-foreground">{translate("feedback:type")}</Text>
              </View>
              <RadioGroup
                options={[
                  {value: "bug", label: translate("feedback:bugReport")},
                  {value: "feature", label: translate("feedback:featureRequest")},
                ]}
                value={feedbackType}
                onValueChange={(value) => setFeedbackType(value as "bug" | "feature")}
              />
            </View>

            {isApplePrivateRelay && (
              <View>
                <View className="flex-row items-center mb-2 gap-1.5">
                  <Text className="text-sm font-semibold text-foreground">{translate("feedback:emailOptional")}</Text>
                  <Pressable
                    hitSlop={10}
                    onPress={() =>
                      showAlert(translate("feedback:emailOptional"), translate("feedback:emailInfoMessage"), [
                        {text: translate("common:ok")},
                      ])
                    }>
                    <Icon name="info-circle" size={16} color={theme.colors.muted_foreground} />
                  </Pressable>
                </View>
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
                  <Text className="text-sm font-semibold text-foreground mb-2">
                    {translate("feedback:screenshots")}
                  </Text>
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
                        {screenshots.length === 0
                          ? translate("feedback:addScreenshots")
                          : translate("feedback:addMore")}
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
