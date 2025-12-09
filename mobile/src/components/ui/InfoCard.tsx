import {View, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

// Single card item
interface InfoCardProps {
  label: string
  value?: string | number | null
  isFirst?: boolean
  isLast?: boolean
}

const InfoCard: React.FC<InfoCardProps> = ({label, value, isFirst, isLast}) => {
  const {theme, themed} = useAppTheme()

  if (!label && (value === null || value === undefined || value === "")) {
    return null
  }

  return (
    <View
      style={[
        themed($infoCardContainer),
        {
          borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
          borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
          borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
          borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
          marginBottom: isLast ? 0 : theme.spacing.s2,
        },
      ]}>
      <Text style={themed($infoCardTitle)} weight="semiBold">{label}</Text>
      <Text style={themed($infoCardValue)}>{String(value)}</Text>
    </View>
  )
}

// Section component
interface InfoCardSectionProps {
  items: Array<{label: string; value?: string | number | null}>
  style?: ViewStyle
}

const InfoCardSection: React.FC<InfoCardSectionProps> = ({items, style}) => {
  const {themed} = useAppTheme()

  // Filter out empty items
  const validItems = items.filter(item => item.value !== null && item.value !== undefined && item.value !== "")

  if (validItems.length === 0) {
    return null
  }

  return (
    <View style={themed(style)}>
      {validItems.map((item, index) => (
        <InfoCard
          key={index}
          label={item.label}
          value={item.value}
          isFirst={index === 0}
          isLast={index === validItems.length - 1}
        />
      ))}
    </View>
  )
}

const $infoCardContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  backgroundColor: colors.backgroundAlt,
  paddingVertical: 18.5,
  paddingHorizontal: 16,
  marginBottom: spacing.s2,
})

const $infoCardTitle: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
  fontSize: 14,
})

const $infoCardValue: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
  fontSize: 14,
  lineHeight: 20,
})

export default InfoCardSection
export {InfoCard}
