import {View, TouchableOpacity, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export interface RatingButtonsProps {
  value: number | null
  onValueChange: (value: number) => void
  min?: number
  max?: number
  style?: ViewStyle
}

export function RatingButtons({value, onValueChange, min = 1, max = 5, style}: RatingButtonsProps) {
  const {themed} = useAppTheme()

  const ratings = Array.from({length: max - min + 1}, (_, i) => i + min)

  return (
    <View style={[themed($container), style]}>
      {ratings.map(rating => (
        <TouchableOpacity
          key={rating}
          style={themed($button(value === rating))}
          onPress={() => onValueChange(rating)}
          activeOpacity={0.7}>
          <Text style={themed($buttonText(value === rating))} weight="semiBold" text={rating.toString()} />
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

const $button: (selected: boolean) => ThemedStyle<ViewStyle> =
  selected =>
  ({colors}) => ({
    flex: 1,
    aspectRatio: 1,
    minWidth: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: selected ? colors.primary : colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  })

const $buttonText: (selected: boolean) => ThemedStyle<TextStyle> =
  selected =>
  ({colors}) => ({
    fontSize: 16,
    color: selected ? colors.background : colors.text,
  })
