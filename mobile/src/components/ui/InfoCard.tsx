import {ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import GlassView from "@/components/ui/GlassView"
import {Group} from "@/components/ui/Group"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ThemedStyle} from "@/theme"

// Single card item
interface InfoCardProps {
  label: string
  value?: string | number | null
  style?: ViewStyle
}

const InfoCard: React.FC<InfoCardProps> = ({label, value, style}) => {
  const {themed} = useAppTheme()

  if (!label && (value === null || value === undefined || value === "")) {
    return null
  }

  return (
    <GlassView className="flex-row justify-between py-5 px-4 bg-primary-foreground" style={style}>
      <Text style={themed($infoCardTitle)} weight="semibold">
        {label}
      </Text>
      <Text style={themed($infoCardValue)}>{String(value)}</Text>
    </GlassView>
  )
}

// Section component
interface InfoCardSectionProps {
  items: Array<{label: string; value?: string | number | null}>
  style?: ViewStyle
}

const InfoCardSection: React.FC<InfoCardSectionProps> = ({items, style}) => {
  // Filter out empty items
  const validItems = items.filter((item) => item.value !== null && item.value !== undefined && item.value !== "")

  if (validItems.length === 0) {
    return null
  }

  return (
    <Group style={style}>
      {validItems.map((item, index) => (
        <InfoCard key={index} label={item.label} value={item.value} />
      ))}
    </Group>
  )
}

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
