import {MaterialCommunityIcons} from "@expo/vector-icons"
import {View, TouchableOpacity, ViewStyle} from "react-native"

import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export interface StarRatingProps {
  value: number | null
  onValueChange: (value: number) => void
  max?: number
  style?: ViewStyle
}

export function StarRating({value, onValueChange, max = 5, style}: StarRatingProps) {
  const {theme, themed} = useAppTheme()

  const stars = Array.from({length: max}, (_, i) => i + 1)

  return (
    <View style={[themed($container), style]}>
      {stars.map(star => (
        <TouchableOpacity key={star} onPress={() => onValueChange(star)} activeOpacity={0.7}>
          <MaterialCommunityIcons
            name={value && star <= value ? "star" : "star-outline"}
            size={44}
            color={value && star <= value ? theme.colors.primary : theme.colors.border}
          />
        </TouchableOpacity>
      ))}
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  gap: spacing.s2,
})
