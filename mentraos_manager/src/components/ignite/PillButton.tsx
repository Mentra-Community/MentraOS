import React from "react"
import {TouchableOpacity, Text, StyleSheet, TouchableOpacityProps, TextStyle, ViewStyle} from "react-native"
import {useAppTheme} from "@/utils/useAppTheme"

export type PillButtonVariant = "primary" | "secondary"

interface PillButtonProps extends Omit<TouchableOpacityProps, "style"> {
  /**
   * The text to display in the button
   */
  text: string

  /**
   * The button variant - primary (light blue) or secondary (dark blue)
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
  ...touchableProps
}: PillButtonProps) {
  const {theme} = useAppTheme()

  const isPrimary = variant === "primary"

  const buttonStyles = [
    styles.button,
    {
      backgroundColor: isPrimary ? theme.colors.buttonPillPrimary : theme.colors.buttonPillSecondary,
    },
    disabled && styles.disabled,
    buttonStyle,
  ]

  const textStyles = [
    styles.text,
    {
      color: isPrimary ? theme.colors.buttonPillPrimaryText : theme.colors.buttonPillSecondaryText,
    },
    disabled && styles.disabledText,
    textStyle,
  ]

  return (
    <TouchableOpacity style={buttonStyles} disabled={disabled} hitSlop={10} {...touchableProps}>
      <Text style={textStyles}>{text}</Text>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 100, // Pill shape
    height: 36,
    justifyContent: "center",
    alignItems: "center",
  },
  disabled: {
    opacity: 0.4,
  },
  disabledText: {
    // Text color will be automatically dimmed by the container opacity
  },
  text: {
    fontSize: 14,
    fontWeight: "normal",
    textAlign: "center",
  },
})
