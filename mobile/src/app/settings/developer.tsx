import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {ScrollView, View, ViewStyle, TextStyle} from "react-native"

import BackendUrl from "@/components/dev/BackendUrl"
import StoreUrl from "@/components/dev/StoreUrl"
import {Header, Icon, Screen, Text} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Group} from "@/components/ui/Group"
import {RouteButton} from "@/components/ui/RouteButton"
import {Spacer} from "@/components/ui/Spacer"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {SETTINGS, useSetting} from "@/stores/settings"
import {$styles, ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export default function DeveloperSettingsScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack, push} = useNavigationHistory()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const [powerSavingMode, setPowerSavingMode] = useSetting(SETTINGS.power_saving_mode.key)
  const [reconnectOnAppForeground, setReconnectOnAppForeground] = useSetting(SETTINGS.reconnect_on_app_foreground.key)
  const [enableSquircles, setEnableSquircles] = useSetting(SETTINGS.enable_squircles.key)
  const [debugConsole, setDebugConsole] = useSetting(SETTINGS.debug_console.key)

  return (
    <Screen preset="fixed" style={themed($styles.screen)}>
      <Header title="Developer Settings" leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <View style={themed($warningContainer)}>
        <View style={themed($warningContent)}>
          <Icon name="alert" size={16} color={theme.colors.text} />
          <Text tx="warning:warning" style={themed($warningTitle)} />
        </View>
        <Text tx="warning:developerSettingsWarning" style={themed($warningSubtitle)} />
      </View>

      <Spacer height={theme.spacing.s4} />

      <ScrollView style={{flex: 1, marginHorizontal: -theme.spacing.s4, paddingHorizontal: theme.spacing.s4}}>
        <RouteButton
          label="Buffer Recording Debug"
          subtitle="Control 30-second video buffer on glasses"
          onPress={() => push("/settings/buffer-debug")}
        />

        <Spacer height={theme.spacing.s4} />

        <Group>
          <ToggleSetting
            label={translate("settings:reconnectOnAppForeground")}
            subtitle={translate("settings:reconnectOnAppForegroundSubtitle")}
            value={reconnectOnAppForeground}
            onValueChange={value => setReconnectOnAppForeground(value)}
          />

          <ToggleSetting
            label={translate("devSettings:debugConsole")}
            subtitle={translate("devSettings:debugConsoleSubtitle")}
            value={debugConsole}
            onValueChange={value => setDebugConsole(value)}
          />

          <ToggleSetting
            label="Enable Squircles"
            subtitle="Use iOS-style squircle app icons instead of circles"
            value={enableSquircles}
            onValueChange={value => setEnableSquircles(value)}
          />
        </Group>

        <Spacer height={theme.spacing.s4} />

        <RouteButton label="Test Mini App" subtitle="Test the Mini App" onPress={() => push("/test/mini-app")} />

        <Spacer height={theme.spacing.s4} />

        <RouteButton
          label="Sitemap"
          subtitle="view the app's route map"
          onPress={() => push("/_sitemap")}
        />

        <Spacer height={theme.spacing.s4} />

        <RouteButton
          label="Test Sentry"
          subtitle="Send a crash to Sentry"
          onPress={() => {
            throw new Error("Test Sentry crash")
          }}
        />

        <Spacer height={theme.spacing.s4} />

        {/* G1 Specific Settings - Only show when connected to Even Realities G1 */}
        {defaultWearable?.includes(DeviceTypes.G1) && (
          <Group title="G1 Specific Settings">
            <ToggleSetting
              label={translate("settings:powerSavingMode")}
              subtitle={translate("settings:powerSavingModeSubtitle")}
              value={powerSavingMode}
              onValueChange={async value => {
                await setPowerSavingMode(value)
              }}
            />
          </Group>
        )}

        <Spacer height={theme.spacing.s4} />

        <BackendUrl />

        <Spacer height={theme.spacing.s4} />

        <StoreUrl />

        <Spacer height={theme.spacing.s4} />
        <Spacer height={theme.spacing.s12} />
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
