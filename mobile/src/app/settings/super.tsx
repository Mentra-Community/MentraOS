import {ScrollView, View, ViewStyle, TextStyle} from "react-native"

import {Header, Icon, Screen, Text} from "@/components/ignite"
import ToggleSetting from "@/components/settings/ToggleSetting"
import {Group} from "@/components/ui/Group"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {ThemedStyle} from "@/theme"

export default function SuperSettingsScreen() {
  const {theme, themed} = useAppTheme()
  const {goBack} = useNavigationHistory()
  const [superMode, setSuperMode] = useSetting(SETTINGS.super_mode.key)
  const [debugNavigationHistoryEnabled, setDebugNavigationHistoryEnabled] = useSetting(
    SETTINGS.debug_navigation_history.key,
  )
  const [debugCoreStatusBarEnabled, setDebugCoreStatusBarEnabled] = useSetting(SETTINGS.debug_core_status_bar.key)

  return (
    <Screen preset="fixed">
      <Header title="Super Settings" leftIcon="chevron-left" onLeftPress={() => goBack()} />

      <ScrollView className="flex px-4 -mx-4">
        <View className="flex gap-6 mt-6">
          <Group title="Settings">
            <ToggleSetting
              label="Super Mode"
              subtitle="Enable super mode"
              value={superMode}
              onValueChange={(value) => setSuperMode(value)}
            />

            <ToggleSetting
              label="Debug Navigation History"
              value={debugNavigationHistoryEnabled}
              onValueChange={(value) => setDebugNavigationHistoryEnabled(value)}
            />

            <ToggleSetting
              label="Debug Core Status Bar"
              value={debugCoreStatusBarEnabled}
              onValueChange={(value) => setDebugCoreStatusBarEnabled(value)}
            />
          </Group>
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
