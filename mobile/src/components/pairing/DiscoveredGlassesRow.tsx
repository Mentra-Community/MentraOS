import {Pressable, StyleProp, View, ViewStyle} from "react-native"

import {Icon, Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"

export function DiscoveredGlassesRow({
  title,
  subtitle,
  onPress,
  style,
}: {
  title: string
  subtitle: string
  onPress: () => void
  style?: StyleProp<ViewStyle>
}) {
  const {theme} = useAppTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${subtitle}`}
      onPress={onPress}
      onAccessibilityTap={onPress}
      style={({pressed}) => [style, {opacity: pressed ? 0.2 : 1}]}
      className="flex-row items-center justify-between px-4 py-3 bg-primary-foreground rounded-2xl">
      <View className="flex-1 px-2.5 flex-col">
        <Text text={title} className="flex-wrap text-sm font-semibold" numberOfLines={2} />
        <Text text={subtitle} className="text-xs text-muted-foreground" numberOfLines={2} />
      </View>
      <View pointerEvents="none" accessible={false} testID="pairing-device-chevron">
        <Icon name="chevron-right" size={24} color={theme.colors.text} />
      </View>
    </Pressable>
  )
}
