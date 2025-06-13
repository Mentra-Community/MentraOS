import {ComponentType} from "react"
import {LinearGradient} from "expo-linear-gradient"

const gradientBorderStyle: ViewStyle = {
  borderRadius: 30,
  padding: 2,
}
import {
  Pressable,
  PressableProps,
  PressableStateCallbackType,
  StyleProp,
  TextStyle,
  ViewStyle,
  View,
} from "react-native"
import type {ThemedStyle, ThemedStyleArray} from "@/theme"
import {$styles, spacing} from "@/theme"
import {Text, TextProps} from "./Text"
import {useAppTheme} from "@/utils/useAppTheme"

type Presets = "default" | "filled" | "reversed"

export interface ButtonAccessoryProps {
  style: StyleProp<any>
  pressableState: PressableStateCallbackType
  disabled?: boolean
}

export interface ButtonProps extends PressableProps {
  /**
   * Text which is looked up via i18n.
   */
  tx?: TextProps["tx"]
  /**
   * The text to display if not using `tx` or nested components.
   */
  text?: TextProps["text"]
  /**
   * Optional options to pass to i18n. Useful for interpolation
   * as well as explicitly setting locale or translation fallbacks.
   */
  txOptions?: TextProps["txOptions"]
  /**
   * An optional style override useful for padding & margin.
   */
  style?: StyleProp<ViewStyle>
  /**
   * An optional style override for the "pressed" state.
   */
  pressedStyle?: StyleProp<ViewStyle>
  /**
   * An optional style override for the button text.
   */
  textStyle?: StyleProp<TextStyle>
  /**
   * An optional style override for the button text when in the "pressed" state.
   */
  pressedTextStyle?: StyleProp<TextStyle>
  /**
   * An optional style override for the button text when in the "disabled" state.
   */
  disabledTextStyle?: StyleProp<TextStyle>
  /**
   * One of the different types of button presets.
   */
  preset?: Presets
  /**
   * An optional component to render on the right side of the text.
   * Example: `RightAccessory={(props) => <View {...props} />}`
   */
  RightAccessory?: ComponentType<ButtonAccessoryProps>
  /**
   * An optional component to render on the left side of the text.
   * Example: `LeftAccessory={(props) => <View {...props} />}`
   */
  LeftAccessory?: ComponentType<ButtonAccessoryProps>
  /**
   * Children components.
   */
  children?: React.ReactNode
  /**
   * disabled prop, accessed directly for declarative styling reasons.
   * https://reactnative.dev/docs/pressable#disabled
   */
  disabled?: boolean
  /**
   * An optional style override for the disabled state
   */
  disabledStyle?: StyleProp<ViewStyle>
  /**
   * Alignment for accessories, either "start" or "center"
   */
  accessoryAlignment?: "start" | "center"
  /**
   * Alignment for button text, either "left" or "center"
   */
  textAlignment?: "left" | "center"
}

/**
 * A component that allows users to take actions and make choices.
 * Wraps the Text component with a Pressable component.
 * @see [Documentation and Examples]{@link https://docs.infinite.red/ignite-cli/boilerplate/app/components/Button/}
 * @param {ButtonProps} props - The props for the `Button` component.
 * @returns {JSX.Element} The rendered `Button` component.
 * @example
 * <Button
 *   tx="common:ok"
 *   style={styles.button}
 *   textStyle={styles.buttonText}
 *   onPress={handleButtonPress}
 * />
 */
export function Button(props: ButtonProps) {
  const {
    tx,
    text,
    txOptions,
    style: $viewStyleOverride,
    pressedStyle: $pressedViewStyleOverride,
    textStyle: $textStyleOverride,
    pressedTextStyle: $pressedTextStyleOverride,
    disabledTextStyle: $disabledTextStyleOverride,
    children,
    RightAccessory,
    LeftAccessory,
    disabled,
    disabledStyle: $disabledViewStyleOverride,
    accessoryAlignment = "start",
    ...rest
  } = props

  const {themed, theme} = useAppTheme()

  const preset: Presets = props.preset ?? "default"
  const gradientColors = theme.isDark ? [theme.colors.buttonGradientEnd, theme.colors.buttonGradientEnd] : [theme.colors.transparent, theme.colors.transparent]
  /**
   * @param {PressableStateCallbackType} root0 - The root object containing the pressed state.
   * @param {boolean} root0.pressed - The pressed state.
   * @returns {StyleProp<ViewStyle>} The view style based on the pressed state.
   */
  function $viewStyle({pressed}: PressableStateCallbackType): StyleProp<ViewStyle> {
    return [
      themed($viewPresets[preset]),
      $viewStyleOverride,
      !!pressed && themed([$pressedViewPresets[preset], $pressedViewStyleOverride]),
      !!disabled && $disabledViewStyleOverride,
    ]
  }
  /**
   * @param {PressableStateCallbackType} root0 - The root object containing the pressed state.
   * @param {boolean} root0.pressed - The pressed state.
   * @returns {StyleProp<TextStyle>} The text style based on the pressed state.
   */
  function $textStyle({pressed}: PressableStateCallbackType): StyleProp<TextStyle> {
    return [
      themed($textPresets[preset]),
      $textStyleOverride,
      !!pressed && themed([$pressedTextPresets[preset], $pressedTextStyleOverride]),
      !!disabled && $disabledTextStyleOverride,
    ]
  }

  return (
    <LinearGradient colors={gradientColors} start={{x: 1, y: 0}} end={{x: 0, y: 0}} style={theme.isDark ? gradientBorderStyle : {}}>
      <Pressable
        style={$viewStyle}
        accessibilityRole="button"
        accessibilityState={{disabled: !!disabled}}
        {...rest}
        disabled={disabled}>
        {state => (
          <View style={{flex: 1, position: "relative", justifyContent: "center"}}>
            {!!LeftAccessory && (
              <View style={{marginLeft: spacing.xxs, position: "absolute", left: 0}}>
                <LeftAccessory style={$leftAccessoryStyle} pressableState={state} disabled={disabled} />
              </View>
            )}

            <Text
              tx={tx}
              text={text}
              txOptions={txOptions}
              style={[$textStyle(state), {textAlign: props.textAlignment === "left" ? "left" : "center"}]}>
              {children}
            </Text>

            {!!RightAccessory && (
              <View style={{position: "absolute", right: 0}}>
                <RightAccessory style={$rightAccessoryStyle} pressableState={state} disabled={disabled} />
              </View>
            )}
          </View>
        )}
      </Pressable>
    </LinearGradient>
  )
}

const $baseViewStyle: ThemedStyle<ViewStyle> = ({spacing, colors, isDark}) => ({
  minHeight: 44,
  borderRadius: 30,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: spacing.sm,
  paddingHorizontal: spacing.sm,
  overflow: "hidden",
  backgroundColor: colors.palette.primary200,
  // Add subtle border for light theme
  borderWidth: isDark ? 0 : 1,
  borderColor: isDark ? undefined : colors.border,
})

const $baseTextStyle: ThemedStyle<TextStyle> = ({typography}) => ({
  fontSize: 16,
  lineHeight: 20,
  textAlign: "center",
  flexShrink: 1,
  flexGrow: 0,
  zIndex: 2,
})

const $rightAccessoryStyle: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginStart: spacing.xs,
  zIndex: 1,
})
const $leftAccessoryStyle: ThemedStyle<ViewStyle> = ({spacing}) => ({
  marginEnd: spacing.xs,
  zIndex: 1,
})

const $viewPresets: Record<Presets, ThemedStyleArray<ViewStyle>> = {
  default: [
    $styles.row,
    $baseViewStyle,
    // ({colors}) => ({
    //   backgroundColor: colors.palette.primary100,
    // }),
  ],
  filled: [$styles.row, $baseViewStyle],
  reversed: [
    $styles.row,
    $baseViewStyle,
    ({colors}) => ({backgroundColor: colors.palette.neutral800, borderColor: colors.palette.neutral900}),
  ],
}

const $textPresets: Record<Presets, ThemedStyleArray<TextStyle>> = {
  default: [$baseTextStyle],
  filled: [$baseTextStyle],
  reversed: [$baseTextStyle, ({colors}) => ({color: colors.palette.neutral100})],
}

const $pressedViewPresets: Record<Presets, ThemedStyle<ViewStyle>> = {
  default: ({colors, isDark}) => ({backgroundColor: isDark ? colors.palette.neutral200 : colors.palette.primary100}),
  filled: ({colors}) => ({backgroundColor: colors.palette.neutral400}),
  reversed: ({colors}) => ({backgroundColor: colors.palette.neutral700}),
}

const $pressedTextPresets: Record<Presets, ThemedStyle<ViewStyle>> = {
  default: () => ({opacity: 0.9}),
  filled: () => ({opacity: 0.9}),
  reversed: () => ({opacity: 0.9}),
}
