import {ComponentType} from "react"
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
import {useAppTheme} from "@/utils/useAppTheme"

import {Text, TextProps} from "./Text"

type Presets = "default" | "primary" | "secondary" | "accent" | "warning" | "destructive" | "outlined" | "alternate"

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
  /**
   * Whether the button is compact
   */
  compact?: boolean

  /**
   * Whether the button is flex
   */
  flex?: boolean

  /**
   * Whether the button is flex container
   */
  flexContainer?: boolean

  /**
   * Whether the button is compact icon
   */
  compactIcon?: boolean
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
    compact = false,
    flex = false,
    flexContainer = false,
    compactIcon = false,
    ...rest
  } = props

  const {themed} = useAppTheme()

  const preset: Presets = props.preset ?? "default"
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
      !!flex && {flex: 1},
      (!!compact || !!compactIcon) && $compactViewStyle,
      !!compactIcon && $compactIconStyle,
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
      !!compact && $compactTextStyle,
    ]
  }

  return (
    <Pressable
      style={$viewStyle}
      accessibilityRole="button"
      accessibilityState={{disabled: !!disabled}}
      {...rest}
      disabled={disabled}>
      {state => (
        <View
          style={[{position: "relative", justifyContent: "center", alignItems: "center"}, flexContainer && {flex: 1}]}>
          {!!LeftAccessory && (
            <View style={{position: "absolute", left: 0, alignItems: "center", justifyContent: "center"}}>
              <LeftAccessory style={$leftAccessoryStyle} pressableState={state} disabled={disabled} />
            </View>
          )}

          <Text
            tx={tx}
            text={text}
            txOptions={txOptions}
            style={[
              $textStyle(state),
              {textAlign: props.textAlignment === "left" ? "left" : "center"},
              !!LeftAccessory && {paddingLeft: 28},
              !!RightAccessory && {paddingRight: 28},
            ]}>
            {children}
          </Text>

          {!!RightAccessory && (
            <View style={{position: "absolute", right: 0, alignItems: "center", justifyContent: "center"}}>
              <RightAccessory style={$rightAccessoryStyle} pressableState={state} disabled={disabled} />
            </View>
          )}
        </View>
      )}
    </Pressable>
  )
}

const $baseViewStyle: ThemedStyle<ViewStyle> = ({spacing, colors, isDark}) => ({
  minHeight: 44,
  borderRadius: 50,
  justifyContent: "center",
  alignItems: "center",
  paddingVertical: spacing.s3,
  paddingHorizontal: spacing.s3,
  overflow: "hidden",
  // Add subtle border for light theme
  borderWidth: isDark ? 0 : 1,
  borderColor: isDark ? undefined : colors.border,
})

const $compactViewStyle: StyleProp<ViewStyle> = {
  minHeight: 0,
  maxHeight: 36,
  paddingVertical: spacing.s2,
  paddingHorizontal: spacing.s2,
  // flex: 1,
} as ViewStyle

const $compactIconStyle: StyleProp<ViewStyle> = {
  maxWidth: 36,
} as ViewStyle

const $baseTextStyle: ThemedStyle<TextStyle> = ({colors}) => ({
  fontSize: 16,
  lineHeight: 20,
  textAlign: "center",
  flexShrink: 1,
  flexGrow: 0,
  zIndex: 2,
  color: colors.primary_foreground,
})

const $compactTextStyle: StyleProp<TextStyle> = {
  fontSize: 14,
} as TextStyle

const $rightAccessoryStyle: ThemedStyle<ViewStyle> = ({spacing, colors}) => ({
  marginStart: spacing.s2,
  zIndex: 1,
  color: colors.textAlt,
})
const $leftAccessoryStyle: ThemedStyle<ViewStyle> = ({spacing, colors}) => ({
  marginEnd: spacing.s2,
  zIndex: 1,
  color: colors.textAlt,
})

const $viewPresets: Record<Presets, ThemedStyleArray<ViewStyle>> = {
  default: [
    $styles.row,
    $baseViewStyle,
    ({colors}) => ({
      backgroundColor: colors.secondary_foreground,
    }),
  ],
  primary: [
    $styles.row,
    $baseViewStyle,
    ({colors}) => ({
      backgroundColor: colors.secondary_foreground,
    }),
  ],
  secondary: [
    $styles.row,
    $baseViewStyle,
    ({colors}) => ({
      backgroundColor: colors.primary_foreground,
    }),
  ],
  alternate: [
    $styles.row,
    $baseViewStyle,
    ({colors}) => ({
      backgroundColor: colors.background,
    }),
  ],
  accent: [
    $styles.row,
    $baseViewStyle,
    ({colors}) => ({
      backgroundColor: colors.accent,
    }),
  ],
  warning: [
    $styles.row,
    $baseViewStyle,
    ({colors}) => ({
      backgroundColor: colors.warning,
    }),
  ],
  destructive: [
    $styles.row,
    $baseViewStyle,
    ({colors}) => ({
      backgroundColor: colors.error,
    }),
  ],
  outlined: [
    $styles.row,
    $baseViewStyle,
    ({colors}) => ({
      backgroundColor: colors.palette.transparent,
      borderWidth: 1.5,
      borderColor: colors.textDim,
    }),
  ],
}

const $textPresets: Record<Presets, ThemedStyleArray<TextStyle>> = {
  default: [$baseTextStyle],
  primary: [$baseTextStyle],
  secondary: [$baseTextStyle, ({colors}) => ({color: colors.secondary_foreground})],
  alternate: [$baseTextStyle, ({colors}) => ({color: colors.secondary_foreground})],
  accent: [$baseTextStyle],
  warning: [$baseTextStyle, ({colors}) => ({color: colors.secondary_foreground})],
  destructive: [$baseTextStyle, ({colors}) => ({color: colors.palette.angry600})],
  outlined: [$baseTextStyle, ({colors}) => ({color: colors.text})],
}

const $pressedViewPresets: Record<Presets, ThemedStyle<ViewStyle>> = {
  default: ({colors}) => ({backgroundColor: colors.palette.transparent, borderColor: colors.border}),
  primary: ({colors}) => ({backgroundColor: colors.palette.transparent, borderColor: colors.border}),
  secondary: ({colors}) => ({backgroundColor: colors.palette.transparent, borderColor: colors.border}),
  alternate: ({colors}) => ({backgroundColor: colors.palette.transparent, borderColor: colors.border}),
  accent: ({colors}) => ({backgroundColor: colors.palette.transparent, borderColor: colors.border}),
  warning: ({colors}) => ({backgroundColor: colors.palette.transparent, borderColor: colors.border}),
  destructive: ({colors}) => ({backgroundColor: colors.palette.transparent, borderColor: colors.border}),
  outlined: ({colors}) => ({backgroundColor: colors.palette.transparent, borderColor: colors.border}),
}

const $pressedTextPresets: Record<Presets, ThemedStyle<TextStyle>> = {
  default: () => ({opacity: 0.9}),
  primary: () => ({opacity: 0.9}),
  secondary: () => ({opacity: 0.9}),
  accent: () => ({opacity: 0.9}),
  warning: () => ({opacity: 0.9}),
  destructive: () => ({opacity: 0.9}),
  outlined: () => ({opacity: 0.9}),
  alternate: () => ({opacity: 0.9}),
}
