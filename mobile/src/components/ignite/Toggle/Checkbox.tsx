import {useEffect, useRef, useCallback} from "react"
import {Image, ImageStyle, Animated, StyleProp, View, ViewStyle} from "react-native"

import {Icon, iconRegistry, IconTypes} from "@/components/ignite/Icon"
import {useAppTheme} from "@/contexts/ThemeContext"
import {$styles} from "@/theme"

import {$inputOuterBase, BaseToggleInputProps, ToggleProps, Toggle} from "./Toggle"

export interface CheckboxToggleProps extends Omit<ToggleProps<CheckboxInputProps>, "ToggleInput"> {
  /**
   * Optional style prop that affects the Image component.
   */
  inputDetailStyle?: ImageStyle
  /**
   * Checkbox-only prop that changes the icon used for the "on" state.
   */
  icon?: IconTypes
}

interface CheckboxInputProps extends BaseToggleInputProps<CheckboxToggleProps> {
  icon?: CheckboxToggleProps["icon"]
}
/**
 * @param {CheckboxToggleProps} props - The props for the `Checkbox` component.
 * @see [Documentation and Examples]{@link https://docs.infinite.red/ignite-cli/boilerplate/app/components/Checkbox}
 * @returns {JSX.Element} The rendered `Checkbox` component.
 */
export function Checkbox(props: CheckboxToggleProps) {
  const {icon, ...rest} = props
  const checkboxInput = useCallback(
    (toggleProps: CheckboxInputProps) => <CheckboxInput {...toggleProps} icon={icon} />,
    [icon],
  )
  return <Toggle accessibilityRole="checkbox" {...rest} ToggleInput={checkboxInput} />
}

function CheckboxInput(props: CheckboxInputProps) {
  const {
    on,
    status,
    disabled,
    outerStyle: $outerStyleOverride,
    innerStyle: $innerStyleOverride,
    detailStyle: $detailStyleOverride,
  } = props

  const {
    theme: {colors},
  } = useAppTheme()

  const opacity = useRef(new Animated.Value(0))

  useEffect(() => {
    Animated.timing(opacity.current, {
      toValue: on ? 1 : 0,
      duration: 300,
      useNativeDriver: true,
    }).start()
  }, [on])

  return (
    <View
      className="rounded-md"
      style={[{
        width: 24,
        height: 24,
        borderWidth: 2,
        borderColor: on ? colors.primary : colors.border,
        backgroundColor: on ? colors.primary : colors.background,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 6,
      }, $outerStyleOverride]}>
      <Animated.View
        style={[{opacity: opacity.current}]}>
        <Icon name="check" size={16} color={colors.background} />
      </Animated.View>
    </View>
  )
}