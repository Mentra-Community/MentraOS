import {MaterialCommunityIcons} from "@expo/vector-icons"
import {View, TouchableOpacity, ViewStyle} from "react-native"

import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {ThemedStyle} from "@/theme"

export interface StarRatingProps {
  value: number | null
  onValueChange: (value: number) => void
  max?: number
  style?: ViewStyle
  /** Prefix for each star's stable test ID: `<testID>.<rating>`. */
  testID?: string
}

export function StarRating({value, onValueChange, max = 5, style, testID = "starRating"}: StarRatingProps) {
  const {theme, themed} = useAppTheme()

  const stars = Array.from({length: max}, (_, i) => i + 1)

  return (
    <View style={[themed($container), style]}>
      {stars.map((star) => {
        const filled = !!value && star <= value
        return (
          <TouchableOpacity
            key={star}
            testID={`${testID}.${star}`}
            accessibilityRole="button"
            accessibilityLabel={translate("common:starRatingValue", {rating: star, max})}
            accessibilityState={{selected: value === star}}
            onPress={() => onValueChange(star)}
            activeOpacity={0.7}>
            <MaterialCommunityIcons
              name={filled ? "star" : "star-outline"}
              size={44}
              color={filled ? theme.colors.primary : theme.colors.border}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          </TouchableOpacity>
        )
      })}
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  gap: spacing.s2,
})
