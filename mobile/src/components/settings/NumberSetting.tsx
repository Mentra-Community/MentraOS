import {useState, useEffect} from "react"
import {View, Platform, Pressable, Alert, TextInput, ViewStyle, TextStyle} from "react-native"

import {Text} from "@/components/ignite"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

type NumberSettingProps = {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  placeholder?: string
  onValueChange: (value: number) => void
  containerStyle?: ViewStyle
  isFirst?: boolean
  isLast?: boolean
}

const NumberSetting: React.FC<NumberSettingProps> = ({
  label,
  value,
  min,
  max,
  step = 1,
  placeholder = "Enter number...",
  onValueChange,
  containerStyle,
  isFirst,
  isLast,
}) => {
  const {theme, themed} = useAppTheme()

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
  const [localValue, setLocalValue] = useState(value.toString())
  const [_isEditing, setIsEditing] = useState(false)

  // Update local value when prop changes
  useEffect(() => {
    setLocalValue(value.toString())
  }, [value])

  const validateAndUpdate = (text: string) => {
    // Allow empty string for editing
    if (text === "") {
      setLocalValue(text)
      return
    }

    // Check if it's a valid number
    const numValue = parseFloat(text)
    if (isNaN(numValue)) {
      return // Don't update if not a valid number
    }

    // Apply min/max constraints
    let finalValue = numValue
    if (min !== undefined && numValue < min) {
      finalValue = min
    }
    if (max !== undefined && numValue > max) {
      finalValue = max
    }

    // Apply step constraint
    if (step !== 1) {
      finalValue = Math.round(finalValue / step) * step
    }

    setLocalValue(finalValue.toString())
    onValueChange(finalValue)
  }

  const handleSubmit = () => {
    if (localValue === "") {
      // Reset to current value if empty
      setLocalValue(value.toString())
      setIsEditing(false)
      return
    }

    const numValue = parseFloat(localValue)
    if (isNaN(numValue)) {
      Alert.alert("Invalid Input", "Please enter a valid number.")
      setLocalValue(value.toString())
      setIsEditing(false)
      return
    }

    validateAndUpdate(localValue)
    setIsEditing(false)
  }

  const handleBlur = () => {
    handleSubmit()
  }

  const handleFocus = () => {
    setIsEditing(true)
  }

  const increment = () => {
    const newValue = value + step
    validateAndUpdate(newValue.toString())
  }

  const decrement = () => {
    const newValue = value - step
    validateAndUpdate(newValue.toString())
  }

  return (
    <View style={[themed($container), groupedStyle, containerStyle]}>
      <Text style={themed($label)}>{label}</Text>

      <View style={themed($inputContainer)}>
        <Pressable style={themed($decrementButton)} onPress={decrement} disabled={min !== undefined && value <= min}>
          <Text style={themed($buttonText)}>-</Text>
        </Pressable>

        <TextInput
          style={themed($input)}
          value={localValue}
          onChangeText={setLocalValue}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onSubmitEditing={handleSubmit}
          keyboardType="numeric"
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textDim}
          selectTextOnFocus={true}
          returnKeyType="done"
          contextMenuHidden={true}
          autoCorrect={false}
          autoCapitalize="none"
        />

        <Pressable style={themed($incrementButton)} onPress={increment} disabled={max !== undefined && value >= max}>
          <Text style={themed($buttonText)}>+</Text>
        </Pressable>
      </View>

      {(min !== undefined || max !== undefined) && (
        <Text style={themed($constraintsText)}>
          {min !== undefined && max !== undefined
            ? `Range: ${min} - ${max}`
            : min !== undefined
              ? `Min: ${min}`
              : `Max: ${max}`}
        </Text>
      )}
    </View>
  )
}

const $container: ThemedStyle<ViewStyle> = ({colors, spacing}) => ({
  backgroundColor: colors.primary_foreground,
  borderRadius: spacing.s4,
  paddingVertical: spacing.s4,
  paddingHorizontal: spacing.s4,
  width: "100%",
})

const $label: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 14,
  fontWeight: "600",
  color: colors.text,
  marginBottom: spacing.s2,
})

const $inputContainer: ThemedStyle<ViewStyle> = ({spacing}) => ({
  flexDirection: "row",
  alignItems: "center",
  gap: spacing.s2,
})

const $input: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  flex: 1,
  fontSize: 16,
  color: colors.text,
  backgroundColor: colors.backgroundAlt,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 6,
  paddingHorizontal: spacing.s3,
  paddingVertical: spacing.s2,
  textAlign: "center",
  minHeight: Platform.OS === "ios" ? 44 : 48,
})

const $decrementButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.backgroundAlt,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 6,
  width: 44,
  height: 44,
  justifyContent: "center",
  alignItems: "center",
})

const $incrementButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.backgroundAlt,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: 6,
  width: 44,
  height: 44,
  justifyContent: "center",
  alignItems: "center",
})

const $buttonText: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 18,
  fontWeight: "600",
  color: colors.text,
})

const $constraintsText: ThemedStyle<TextStyle> = ({colors, spacing}) => ({
  fontSize: 12,
  color: colors.textDim,
  marginTop: spacing.s2,
  textAlign: "center",
})

export default NumberSetting
