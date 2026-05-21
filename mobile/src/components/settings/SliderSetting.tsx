import {Platform, View, ViewStyle} from "react-native"
import {Host as IosHost, Slider as IosSlider} from "@expo/ui/swift-ui"
import {Host as AndroidHost, Slider as AndroidSlider} from "@expo/ui/jetpack-compose"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useEffect, useState} from "react"

type SliderSettingProps = {
  label: string
  subtitle?: string
  value: number | undefined
  min: number
  max: number
  onValueChange: (value: number) => void
  onValueSet: (value: number) => void
  style?: ViewStyle
  disableBorder?: boolean
  isFirst?: boolean
  isLast?: boolean
}

const SliderSetting: React.FC<SliderSettingProps> = ({
  label,
  subtitle,
  value = 0,
  min,
  max,
  onValueChange,
  onValueSet,
  style,
  disableBorder = false,
  isFirst,
  isLast,
}) => {
  const {theme} = useAppTheme()
  const safeValue = value || 0
  const [localValue, setLocalValue] = useState<number>(safeValue)

  // Keep the displayed readout + slider position in sync with external prop
  // updates (e.g. settings synced from cloud after mount).
  useEffect(() => {
    setLocalValue(safeValue)
  }, [safeValue])

  const handleValueChange = (val: number) => {
    setLocalValue(Math.round(val))
    onValueChange(Math.round(val))
  }

  const handleEditingChanged = (isEditing: boolean) => {
    if (!isEditing) {
      onValueSet(Math.round(localValue))
    }
  }

  const handleValueSet = () => {
    onValueSet(Math.round(localValue))
  }

  const groupedStyle: ViewStyle | undefined =
    isFirst !== undefined || isLast !== undefined
      ? {
          borderTopLeftRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
          borderTopRightRadius: isFirst ? theme.spacing.s4 : theme.spacing.s1,
          borderBottomLeftRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
          borderBottomRightRadius: isLast ? theme.spacing.s4 : theme.spacing.s1,
          marginBottom: isLast ? 0 : theme.spacing.s2,
        }
      : undefined

  const sliderHeight = 40

  return (
    <View
      className="w-full bg-primary-foreground rounded-2xl px-4 py-4"
      style={[groupedStyle, disableBorder && {borderWidth: 0}, style]}>
      <View className="w-full mb-2 gap-1">
        <View className="w-full flex-row items-center justify-between">
          <Text text={label} className="text-sm font-semibold text-foreground" />
          <Text text={String(localValue)} className="text-sm font-medium text-muted-foreground" />
        </View>
        {subtitle && <Text text={subtitle} className="text-xs text-muted-foreground" />}
      </View>
      {Platform.OS === "ios" ? (
        <IosHost style={{width: "100%", height: sliderHeight}}>
          <IosSlider
            value={localValue}
            min={min}
            max={max}
            step={1}
            onValueChange={handleValueChange}
            onEditingChanged={handleEditingChanged}
          />
        </IosHost>
      ) : (
        <AndroidHost style={{width: "100%", height: sliderHeight}}>
          <AndroidSlider
            value={localValue}
            min={min}
            max={max}
            steps={Math.max(0, max - min - 1)}
            onValueChange={handleValueChange}
            onValueChangeFinished={handleValueSet}
          />
        </AndroidHost>
      )}
    </View>
  )
}

export default SliderSetting
