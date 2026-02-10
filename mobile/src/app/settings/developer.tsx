import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {ScrollView, View, ViewStyle, TextStyle} from "react-native"

import BackendUrl from "@/components/dev/BackendUrl"
import StoreUrl from "@/components/dev/StoreUrl"
import {Header, Icon, Screen, Text} from "@/components/ignite"
import SelectSetting from "@/components/settings/SelectSetting"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"
import ws from "@/services/WebSocketManager"
import socketComms from "@/services/SocketComms"

// LC3 frame size options - maps to bitrates
// Frame size = bytes per 10ms frame, bitrate = frameSize * 800 bps
const LC3_FRAME_SIZE_OPTIONS = [
  {label: "16 kbps", value: "20"},
  {label: "32 kbps", value: "40"},
  {label: "48 kbps", value: "60"},
]

export default function DeveloperSettingsScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack, push, replaceAll, clearHistoryAndGoHome} = useNavigationHistory()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [devMode, setDevMode] = useSetting(SETTINGS.dev_mode.key)
  const [powerSavingMode, setPowerSavingMode] = useSetting(SETTINGS.power_saving_mode.key)
  const [reconnectOnAppForeground, setReconnectOnAppForeground] = useSetting(SETTINGS.reconnect_on_app_foreground.key)
  const [enableSquircles, setEnableSquircles] = useSetting(SETTINGS.enable_squircles.key)
  const [debugConsole, setDebugConsole] = useSetting(SETTINGS.debug_console.key)
  const [debugNavigationHistoryEnabled, setDebugNavigationHistoryEnabled] = useSetting(SETTINGS.debug_navigation_history.key)
  const [_onboardingOsCompleted, setOnboardingOsCompleted] = useSetting(SETTINGS.onboarding_os_completed.key)
  const [_onboardingLiveCompleted, setOnboardingLiveCompleted] = useSetting(SETTINGS.onboarding_live_completed.key)
  const [lc3FrameSize, setLc3FrameSize] = useSetting(SETTINGS.lc3_frame_size.key)

  return (
    <Screen preset="fixed">
      <Header title="Developer Settings" leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView
        style={{
          flex: 1,
          marginHorizontal: -theme.spacing.s4,
          paddingHorizontal: theme.spacing.s4,
        }}>
        <View className="flex gap-6">
          <View style={themed($warningContainer)}>
            <View style={themed($warningContent)}>
              <Icon name="alert" size={16} color={theme.colors.text} />
              <Text tx="warning:warning" style={themed($warningTitle)} />
            </View>
            <Text tx="warning:developerSettingsWarning" style={themed($warningSubtitle)} />
          </View>

          <Group title="Settings">
            <ToggleSetting
              label="Developer Mode"
              subtitle="Enable developer mode"
              value={devMode}
              onValueChange={(value) => setDevMode(value)}
            />
            <ToggleSetting
              label={translate("settings:reconnectOnAppForeground")}
              subtitle={translate("settings:reconnectOnAppForegroundSubtitle")}
              value={reconnectOnAppForeground}
              onValueChange={(value) => setReconnectOnAppForeground(value)}
            />

            <ToggleSetting
              label={translate("devSettings:debugConsole")}
              subtitle={translate("devSettings:debugConsoleSubtitle")}
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
              label="Debug Navigation History"
              value={debugNavigationHistoryEnabled}
              onValueChange={(value) => setDebugNavigationHistoryEnabled(value)}
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
              label="Mentra OS Onboarding"
              subtitle="Start the Mentra Live onboarding"
              onPress={() => {
                clearHistoryAndGoHome()
                push("/onboarding/os")
              }}
            />
          </Group>

          <Group title="Misc">
            <RouteButton label="Test Mini App" subtitle="Test the Mini App" onPress={() => push("/test/mini-app")} />

            <RouteButton
              label="Buffer Recording Debug"
              subtitle="Control 30-second video buffer on glasses"
              onPress={() => push("/settings/buffer-debug")}
            />

            <RouteButton
              label="Clear Websocket"
              subtitle="Clear the Websocket"
              onPress={async () => {
                ws.cleanup()
                socketComms.cleanup()
                console.log("SOCKET: CLEANED")
                await new Promise((resolve) => setTimeout(resolve, 3000))
                socketComms.restartConnection()
                console.log("SOCKET: RESTARTED")
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

          {/* G1 Specific Settings - Only show when connected to Even Realities G1 */}
          {defaultWearable?.includes(DeviceTypes.G1) && (
            <Group title="G1 Specific Settings">
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
              value={String(lc3FrameSize || 20)}
              options={LC3_FRAME_SIZE_OPTIONS}
              defaultValue="20"
              onValueChange={async (value) => {
                const frameSize = parseInt(value, 10)
                setLc3FrameSize(frameSize)
                // Apply immediately to native encoder and cloud
                try {
                  await socketComms.reconfigureAudioFormat()
                } catch (err) {
                  console.error("Failed to apply LC3 frame size:", err)
                }
              }}
              description="Higher bitrates improve transcription quality but use more bandwidth."
            />
          </Group>

          <BackendUrl />

          <StoreUrl />

          <Spacer height={theme.spacing.s12} />
        </View>
      </ScrollView>
    </Screen>
  )
}

const $warningContainer: ThemedStyle<ViewStyle> = ({colors, spacing, isDark}) => ({
  borderRadius: spacing.s3,
  paddingHorizontal: spacing.s4,
  paddingVertical: spacing.s3,
  borderWidth: spacing.s0_5,
  borderColor: colors.destructive,
  backgroundColor: isDark ? "#2B1E1A" : "#FEEBE7",
})

const $warningContent: ThemedStyle<ViewStyle> = () => ({
  alignItems: "center",
  flexDirection: "row",
  marginBottom: 4,
})

const $warningTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  fontWeight: "bold",
  marginLeft: 6,
  color: colors.text,
})

const $warningSubtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  marginLeft: 22,
  color: colors.text,
})
