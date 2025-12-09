import {TouchableOpacity, View, ViewStyle, TextStyle} from "react-native"

import {Icon, Text} from "@/components/ignite"
import AppIcon from "@/components/misc/AppIcon"
import {Badge} from "@/components/ui"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {useBackgroundApps} from "@/stores/applets"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export const BackgroundAppsLink = ({style}: {style?: ViewStyle}) => {
  const {themed, theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const {active} = useBackgroundApps()
  const activeCount = active.length

  const handlePress = () => {
    push("/home/background-apps")
  }

  return (
    <TouchableOpacity onPress={handlePress} style={[themed($container), style]}>
      <View style={themed($content)}>
        {/* Stacked app icons */}
        <View style={themed($iconStack)}>
          {active.slice(0, 3).map((app, index) => (
            <View
              key={app.packageName}
              style={[
                {
                  zIndex: 3 - index,
                  marginLeft: index > 0 ? -theme.spacing.s8 : 0,
                },
              ]}>
              <AppIcon app={app} style={themed($appIcon)} />
            </View>
          ))}
        </View>

        {/* Text and badge */}
        <View style={themed($textContainer)}>
          <Text style={themed($label)}>{translate("home:backgroundApps")}</Text>
          {activeCount > 0 && <Badge text={`${activeCount} ${translate("home:backgroundAppsActive")}`} />}
        </View>
      </View>

      {/* Arrow */}
      <View style={themed($iconContainer)}>
        <Icon name="arrow-right" size={24} color={theme.colors.foreground} />
      </View>
    </TouchableOpacity>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.backgroundAlt,
  paddingVertical: spacing.s3,
  paddingHorizontal: spacing.s2,
  borderRadius: spacing.s4,
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  minHeight: 72,
})

const $content: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.s3,
  flex: 1,
  paddingHorizontal: spacing.s2,
})

const $iconStack: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "row",
  alignItems: "center",
})

const $appIcon: ThemedStyle<ViewStyle> = () => ({
  width: 56,
  height: 56,
})

const $textContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "column",
  gap: spacing.s1,
  flex: 1,
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  fontWeight: 600,
  color: colors.secondary_foreground,
  fontSize: 14,
})

const $iconContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.background,
  padding: spacing.s3,
  width: spacing.s12,
  height: spacing.s12,
  borderRadius: spacing.s12,
  alignItems: "center",
  justifyContent: "center",
})
