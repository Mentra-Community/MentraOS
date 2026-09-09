import {DeviceTypes} from "@mentra/engine"
import {useEffect, useRef, useState} from "react"
import {Platform, ScrollView, View} from "react-native"

import CloudUrl from "@/components/dev/CloudUrl"
import OtaVersionUrl from "@/components/dev/OtaVersionUrl"
import {Header, Icon, Screen, Text} from "@/components/ignite"
import SelectSetting from "@/components/settings/SelectSetting"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@mentra/engine"
import {navigationService} from "@mentra/engine-host-internal"
import showAlert from "@/utils/AlertUtils"

// Hardcoded test destination for the nav POC. SF Ferry Building.
const TEST_NAV_DESTINATION = {lat: 37.7956, lng: -122.3933}

// LC3 frame size options - maps to bitrates
// Frame size = bytes per 10ms frame, bitrate = frameSize * 800 bps
const LC3_FRAME_SIZE_OPTIONS = [
  {label: "16 kbps", value: "20"},
  {label: "32 kbps", value: "40"},
  {label: "48 kbps", value: "60"},
]

export default function DebugSettingsScreen() {
  const {theme} = useAppTheme()
  const {goBack, push, replaceAll, clearHistoryAndGoHome} = useNavigationStore.getState()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [debugMode, setDebugMode] = useSetting(SETTINGS.debug_mode.key)
  const [androidNotificationListenerEnabled, setAndroidNotificationListenerEnabled] = useSetting(
    SETTINGS.android_notification_listener_enabled.key,
  )
  const [superMode] = useSetting(SETTINGS.super_mode.key)
  const [powerSavingMode, setPowerSavingMode] = useSetting(SETTINGS.power_saving_mode.key)
  const [reconnectOnAppForeground, setReconnectOnAppForeground] = useSetting(SETTINGS.reconnect_on_app_foreground.key)
  const [enableSquircles, setEnableSquircles] = useSetting(SETTINGS.enable_squircles.key)
  const [appearanceMenuEnabled, setAppearanceMenuEnabled] = useSetting(SETTINGS.appearance_menu_enabled.key)
  const [appBootExtraInfo, setAppBootExtraInfo] = useSetting(SETTINGS.app_boot_extra_info.key)
  const [debugConsole, setDebugConsole] = useSetting(SETTINGS.debug_console.key)
  const [_onboardingOsCompleted, setOnboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)
  const [_onboardingLiveCompleted, setOnboardingLiveCompleted] = useSetting(SETTINGS.onboarding_live_completed.key)
  const [lc3FrameSize, setLc3FrameSize] = useSetting(SETTINGS.lc3_frame_size.key)
  const [navRunning, setNavRunning] = useState(false)
  const navUnsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      navUnsubRef.current?.()
      navUnsubRef.current = null
    }
  }, [])

  return (
    <Screen preset="fixed">
      <Header title="Debug Settings" leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-6 -mx-6">
        <View className="flex gap-6">
          <View className="mt-6 border-destructive border-2 bg-destructive/10 rounded-lg px-4 py-3">
            <View className="flex flex-row items-center gap-2">
              <Icon name="alert-triangle" size={16} color={theme.colors.destructive} />
              <Text tx="warning:warning" className="text-lg font-bold" />
            </View>
            <Text tx="warning:debugSettingsWarning" className="text-sm font-medium" />
          </View>

          <Group title="Settings">
            <ToggleSetting
              label="Debug Mode"
              subtitle="Enable debug mode"
              value={debugMode}
              onValueChange={(value) => setDebugMode(value)}
            />
            {Platform.OS === "android" && (
              <ToggleSetting
                label="Android Notification Listener"
                subtitle="Emergency kill switch for Android notification capture"
                value={androidNotificationListenerEnabled}
                onValueChange={(value) => setAndroidNotificationListenerEnabled(value)}
              />
            )}
            <ToggleSetting
              label={translate("settings:reconnectOnAppForeground")}
              subtitle={translate("settings:reconnectOnAppForegroundSubtitle")}
              value={reconnectOnAppForeground}
              onValueChange={(value) => setReconnectOnAppForeground(value)}
            />

            <ToggleSetting
              label={translate("debugSettings:debugConsole")}
              subtitle={translate("debugSettings:debugConsoleSubtitle")}
              value={debugConsole}
              onValueChange={(value) => setDebugConsole(value)}
            />

            <ToggleSetting
              label="Enable Squircles"
              subtitle="Use iOS-style squircle app icons instead of circles"
              value={enableSquircles}
              onValueChange={(value) => setEnableSquircles(value)}
            />

            <ToggleSetting
              label="Appearance Menu"
              subtitle="Show the Appearance settings menu"
              value={appearanceMenuEnabled}
              onValueChange={(value) => setAppearanceMenuEnabled(value)}
            />

            <ToggleSetting
              label="App Boot Extra Info"
              subtitle="Show the current boot state under the logo on the loading screen"
              value={appBootExtraInfo}
              onValueChange={(value) => setAppBootExtraInfo(value)}
            />
          </Group>

          <Group title="Quick Links">
            <RouteButton label="Sitemap" subtitle="View the app's route map" onPress={() => push("/_sitemap")} />

            <RouteButton
              label="Reset onboarding flags"
              onPress={() => {
                setOnboardingLiveCompleted(false)
                setOnboardingOsCompleted(false)
              }}
            />

            <RouteButton
              label="Pairing Success"
              subtitle="Open the pairing success screen"
              onPress={() => {
                setOnboardingLiveCompleted(false)
                setOnboardingOsCompleted(false)
                replaceAll("/pairing/success")
              }}
            />

            <RouteButton
              label="OTA Check for Updates"
              subtitle="Open the OTA check for updates screen"
              onPress={() => {
                push("/ota/check-for-updates")
              }}
            />

            <RouteButton
              label="Mentra Live Onboarding"
              subtitle="Start the Mentra Live onboarding"
              onPress={() => {
                setOnboardingLiveCompleted(false)
                clearHistoryAndGoHome()
                push("/onboarding/live")
              }}
            />

            <RouteButton
              label="MentraOS Onboarding"
              subtitle="Reset and start the MentraOS onboarding"
              onPress={() => {
                setOnboardingOsCompleted(false)
                clearHistoryAndGoHome()
                push("/onboarding/os")
              }}
            />
          </Group>

          <Group title="Misc">
            <RouteButton label="Test Mini App" subtitle="Test the Mini App" onPress={() => push("/test/mini-app")} />

            <RouteButton
              label={navRunning ? "Stop Test Nav" : "Start Test Nav"}
              subtitle={
                navRunning
                  ? "Logging nav events to console — tap to stop"
                  : `Navigate to SF Ferry Building (${TEST_NAV_DESTINATION.lat}, ${TEST_NAV_DESTINATION.lng})`
              }
              onPress={async () => {
                if (navRunning) {
                  navUnsubRef.current?.()
                  navUnsubRef.current = null
                  const result = await navigationService.stop()
                  setNavRunning(false)
                  console.log("NAV_TEST: stopped", result)
                  return
                }
                navUnsubRef.current = navigationService.addListener((update) => {
                  console.log("NAV_TEST:", JSON.stringify(update))
                })
                const result = await navigationService.start(TEST_NAV_DESTINATION)
                console.log("NAV_TEST: start result", result)
                if (!result.ok) {
                  navUnsubRef.current?.()
                  navUnsubRef.current = null
                  showAlert("Nav", `Start failed: ${result.error ?? "unknown"}`)
                  return
                }
                setNavRunning(true)
              }}
            />

            <RouteButton
              label="Reset Nav T&C Dialog"
              subtitle="Clear cached acceptance so Google's T&C dialog shows again next start (Android only)"
              onPress={async () => {
                const result = await navigationService.resetPermission()
                console.log("NAV_TEST: reset T&C", result)
                if (!result.ok) {
                  showAlert("Nav", `Reset failed: ${result.error ?? "unknown"}`)
                  return
                }
                showAlert("Nav", "T&C cache cleared. Start Test Nav to see the dialog again.")
              }}
            />
          </Group>

          <Group title="Test Errors">
            <RouteButton
              label="Throw test error"
              subtitle="Throw a test error (crashes in prod builds)"
              onPress={() => {
                throw new Error("test_throw_error")
              }}
            />

            <RouteButton
              label="Test console error"
              subtitle="Send a console error"
              onPress={() => {
                console.error("test_console_error")
              }}
            />
          </Group>

          {/* Even Realities Specific Settings - Only show when connected to G1 or G2 */}
          {(defaultWearable?.includes(DeviceTypes.G1) || defaultWearable?.includes(DeviceTypes.G2)) && (
            <Group title="Even Realities Settings">
              <ToggleSetting
                label={translate("settings:powerSavingMode")}
                subtitle={translate("settings:powerSavingModeSubtitle")}
                value={powerSavingMode}
                onValueChange={async (value) => {
                  await setPowerSavingMode(value)
                }}
              />
            </Group>
          )}

          <Group title="Audio Settings">
            <SelectSetting
              label="LC3 Bitrate"
              value={String(lc3FrameSize)}
              options={LC3_FRAME_SIZE_OPTIONS}
              defaultValue="20"
              onValueChange={async (value) => {
                const frameSize = parseInt(value, 10)
                setLc3FrameSize(frameSize)
              }}
              description="Higher bitrates improve transcription quality but use more bandwidth."
            />
          </Group>

          <Group title="Cloud V2 (core + runtime)">
            <CloudUrl />
          </Group>

          {/* Super mode only: a wrong OTA manifest can brick glasses */}
          {superMode && <OtaVersionUrl />}

          {superMode && <RouteButton label="Super Settings" onPress={() => push("/miniapps/settings/super")} />}

          <Spacer height={theme.spacing.s12} />
        </View>
      </ScrollView>
    </Screen>
  )
}
