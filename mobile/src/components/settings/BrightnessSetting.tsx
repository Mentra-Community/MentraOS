import {View, ViewStyle, TextStyle} from "react-native"

import {Switch, Text} from "@/components/ignite"
import {ThemedSlider} from "@/components/misc/ThemedSlider"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

type BrightnessSettingProps = {
  label: string
  subtitle?: string
  autoBrightnessValue: boolean
  brightnessValue: number
  onAutoBrightnessChange: (newValue: boolean) => void
  onBrightnessChange: (value: number) => void
  onBrightnessSet: (value: number) => void
  min?: number
  max?: number
  disabled?: boolean
  style?: ViewStyle
  icon?: React.ReactNode
  compact?: boolean
}

const BrightnessSetting: React.FC<BrightnessSettingProps> = ({
  label,
  subtitle,
  autoBrightnessValue,
  brightnessValue,
  onAutoBrightnessChange,
  onBrightnessChange,
  onBrightnessSet,
  min = 0,
  max = 100,
  disabled = false,
  style,
  icon,
  compact = false,
}) => {
  const {theme, themed} = useAppTheme()

  const handleBrightnessChange = (val: number) => {
    const roundedValue = Math.round(val)
    onBrightnessChange(roundedValue)
  }

  const handleBrightnessSet = (val: number) => {
    const roundedValue = Math.round(val)
    onBrightnessSet(roundedValue)
  }

  return (
    <View style={[themed($outerContainer), style]}>
      {/* Toggle Section */}
      <View
        style={[
          themed($toggleContainer),
          disabled && {opacity: 0.5},
          compact && {paddingVertical: theme.spacing.s3},
          !autoBrightnessValue && themed($toggleContainerWithSlider),
        ]}>
        <View style={themed($textContainer)}>
          <View style={{flexDirection: "row", alignItems: "center", gap: theme.spacing.s4, justifyContent: "center"}}>
            {icon && icon}
            <Text text={label} style={[themed($label), compact && {fontSize: 12}]} />
          </View>
          {subtitle && <Text text={subtitle} style={themed($subtitle)} />}
        </View>
        <Switch value={autoBrightnessValue} onValueChange={onAutoBrightnessChange} disabled={disabled} />
      </View>

      {/* Slider Section - Only show when auto-brightness is OFF */}
      {!autoBrightnessValue && (
        <View style={themed($sliderContainer)}>
          <ThemedSlider
            value={brightnessValue}
            min={min}
            max={max}
            onValueChange={handleBrightnessChange}
            onSlidingComplete={handleBrightnessSet}
            icon={icon}
            suffix="%"
          />
        </View>
      )}
    </View>
  )
}

const $outerContainer: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  width: "100%",
  backgroundColor: colors.backgroundAlt,
  borderRadius: spacing.s4,
  overflow: "hidden",
})

const $toggleContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  width: "100%",
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
})

const $toggleContainerWithSlider: ThemedStyle<ViewStyle> = () => ({
  borderBottomLeftRadius: 0,
  borderBottomRightRadius: 0,
})

const $textContainer: ThemedStyle<ViewStyle> = () => ({
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "flex-start",
  gap: 4,
  flex: 1,
  marginRight: 16,
})

const $label: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 14,
  fontWeight: 600,
  color: colors.text,
})

const $subtitle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 12,
  color: colors.textDim,
})

const $sliderContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "column",
  paddingHorizontal: spacing.s4,
  paddingTop: 0,
  paddingBottom: spacing.s4,
})

export default BrightnessSetting
