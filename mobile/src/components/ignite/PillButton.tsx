import {} from "react"
import {TOptions} from "i18next"
import {TouchableOpacity, TouchableOpacityProps, TextStyle, ViewStyle, StyleProp} from "react-native"

import {Text} from "@/components/ignite/Text"
import {TxKeyPath} from "@/i18n"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

export type PillButtonVariant = "primary" | "secondary" | "icon"

interface PillButtonProps extends Omit<TouchableOpacityProps, "style"> {
  /**
   * Text which is looked up via i18n.
   */
  tx?: TxKeyPath
  /**
   * The text to display if not using `tx` or nested components.
   */
  text?: string
  /**
   * Optional options to pass to i18n. Useful for interpolation
   * as well as explicitly setting locale or translation fallbacks.
   */
  txOptions?: TOptions
  /**
   * The button variant - primary (solid color), secondary (transparent with border), or icon (gray background)
   */
  variant?: PillButtonVariant

  /**
   * Optional style overrides for the button container
   */
  buttonStyle?: ViewStyle

  /**
   * Optional style overrides for the button text
   */
  textStyle?: TextStyle

  /**
   * Whether the button is disabled
   */
  disabled?: boolean

  /**
   * Hit slop to increase touchable area around the button
   */
  hitSlop?: {top?: number; bottom?: number; left?: number; right?: number} | number
}

/**
 * A reusable pill-shaped button component with primary and secondary variants.
 * Matches the design system used in AlertUtils/BasicDialog and Developer Settings.
 */
export function PillButton({
  text,
  variant = "secondary",
  buttonStyle,
  textStyle,
  disabled = false,
  tx,
  txOptions,
  ...touchableProps
}: PillButtonProps) {
  const {themed} = useAppTheme()

  const isPrimary = variant === "primary"
  const isSecondary = variant === "secondary"

  const buttonStyles: StyleProp<ViewStyle> = [
    themed($button),
    isPrimary && themed($primaryButton),
    isSecondary && themed($secondaryButton),
    !isPrimary && !isSecondary && themed($iconButton),
    disabled && themed($disabled),
    buttonStyle,
  ]

  const textStyles: StyleProp<TextStyle> = [
    themed($text),
    isPrimary && themed($primaryText),
    isSecondary && themed($secondaryText),
    !isPrimary && !isSecondary && themed($iconText),
    disabled && themed($disabledText),
    textStyle,
  ]

  return (
    <TouchableOpacity style={buttonStyles} disabled={disabled} hitSlop={10} {...touchableProps}>
      <Text style={textStyles} tx={tx} text={text} txOptions={txOptions}></Text>
    </TouchableOpacity>
  )
}

const $button: ThemedStyle<ViewStyle> = () => ({
  paddingVertical: 8,
  paddingHorizontal: 16,
  borderRadius: 100, // Pill shape
  height: 36,
  justifyContent: "center",
  alignItems: "center",
})

const $primaryButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.secondary_foreground,
})

const $secondaryButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.primary_foreground,
  borderWidth: 1,
  borderColor: colors.border,
})

const $iconButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  backgroundColor: colors.primary_foreground,
  // shadow:
  shadowColor: colors.secondary_foreground,
  shadowOffset: {width: 0, height: 1},
  shadowOpacity: 0.2,
  shadowRadius: 2,
})

const $text: ThemedStyle<TextStyle> = () => ({
  fontSize: 14,
  fontWeight: "normal",
  textAlign: "center",
  lineHeight: 20, // Fix vertical centering
})

const $primaryText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textAlt,
})

const $secondaryText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
})

const $iconText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.text,
})

const $disabled: ThemedStyle<ViewStyle> = () => ({
  opacity: 0.4,
})

const $disabledText: ThemedStyle<TextStyle> = ({colors}) => ({
  color: colors.textDim,
})
