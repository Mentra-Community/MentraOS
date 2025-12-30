import {TouchableOpacity, View, ViewStyle} from "react-native"
import {Icon, Text} from "@/components/ignite"
import AppIcon from "@/components/misc/AppIcon"
import {Badge} from "@/components/ui"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {translate} from "@/i18n"
import {useBackgroundApps} from "@/stores/applets"
import {useAppTheme} from "@/contexts/ThemeContext"

export const BackgroundAppsLink = ({style}: {style?: ViewStyle}) => {
  const {theme} = useAppTheme()
  const {push} = useNavigationHistory()
  const {active} = useBackgroundApps()
  const activeCount = active.length

  const handlePress = () => {
    push("/home/background-apps")
  }

  return (
    <TouchableOpacity
      onPress={handlePress}
      style={style}
      className="bg-primary-foreground py-3 px-2 rounded-2xl flex-row justify-between items-center min-h-[72px]">
      <View className="flex-row items-center gap-3 flex-1 px-2">
        {/* Stacked app icons */}
        <View className="flex-row items-center">
          {active.slice(0, 3).map((app, index) => (
            <View
              key={app.packageName}
              style={{
                zIndex: 3 - index,
                marginLeft: index > 0 ? -theme.spacing.s8 : 0,
              }}>
              <AppIcon app={app} className="w-12 h-12" />
            </View>
          ))}
        </View>

        {/* Text and badge */}
        <View className="flex-col gap-1 flex-1">
          <Text className="font-semibold text-secondary-foreground text-sm">{translate("home:backgroundApps")}</Text>
          {activeCount > 0 && <Badge text={translate("home:backgroundAppsActiveCount", {count: activeCount})} />}
        </View>
      </View>

      {/* Arrow */}
      <View className="bg-background p-3 w-12 h-12 rounded-full items-center justify-center">
        <Icon name="arrow-right" size={24} color={theme.colors.foreground} />
      </View>
    </TouchableOpacity>
  )
}
