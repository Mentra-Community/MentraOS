import {View, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

// Reusable component for displaying key-value pairs
interface InfoRowProps {
  label: string
  value?: string | number | null
}

const InfoRow: React.FC<InfoRowProps> = ({label, value}) => {
  const {theme} = useAppTheme()

  // Don't render if value is null, undefined, or empty string
  if (value === null || value === undefined || value === "") {
    return null
  }

  return (
    <View style={{flexDirection: "row", justifyContent: "space-between", paddingVertical: 4}}>
      <Text style={{color: theme.colors.text}}>{label}</Text>
      <Text style={{color: theme.colors.textDim}}>{String(value)}</Text>
    </View>
  )
}

// Component for an info section with multiple key-value pairs
interface InfoSectionProps {
  title: string
  items: Array<{label: string; value?: string | number | null}>
  style?: ViewStyle
}

const InfoSection: React.FC<InfoSectionProps> = ({title, items, style}) => {
  const {theme, themed} = useAppTheme()

  // Filter out items with no value
  const validItems = items.filter(item => item.value !== null && item.value !== undefined && item.value !== "")

  // Don't render the section if there are no valid items
  if (validItems.length === 0) {
    return null
  }

  return (
    <View style={[themed($infoSectionContainer), style]}>
      <Text style={[themed($infoSectionTitle), {marginBottom: theme.spacing.s2}]}>{title}</Text>
      {validItems.map((item, index) => (
        <InfoRow key={index} label={item.label} value={item.value} />
      ))}
    </View>
  )
}

const $infoSectionContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  paddingVertical: 12,
  paddingHorizontal: 16,
  borderRadius: spacing.s4,
  // borderWidth: 2,
  borderColor: colors.border,
})

const $infoSectionTitle: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  color: colors.textDim,
  fontSize: spacing.s3,
})

export default InfoSection
export {InfoRow}
