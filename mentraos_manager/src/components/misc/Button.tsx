import React from "react"
import {TouchableOpacity, StyleSheet, GestureResponderEvent, ViewStyle} from "react-native"
import {Text} from "@/components/ignite"
import Icon from "react-native-vector-icons/MaterialCommunityIcons"
import {useAppTheme} from "@/utils/useAppTheme"

interface ButtonProps {
  onPress: (event: GestureResponderEvent) => void
  title?: string
  children?: React.ReactNode
  isDarkTheme?: boolean
  iconName?: string
  disabled?: boolean
  type?: "primary" | "secondary"
  style?: ViewStyle
}

const Button: React.FC<ButtonProps> = ({
  onPress,
  disabled = false,
  children,
  title,
  isDarkTheme,
  iconName,
  type = "primary",
  style,
  ...props
}) => {
  const {theme} = useAppTheme()

  return (
    <TouchableOpacity
      style={[
        styles.button,
        {backgroundColor: theme.colors.buttonPrimary},
        isDarkTheme && {backgroundColor: theme.colors.blue600},
        type === "secondary" && [styles.buttonSecondary, {borderColor: theme.colors.buttonPrimary}],
        disabled && [
          styles.buttonDisabled,
          {backgroundColor: theme.colors.buttonDisabled, borderColor: theme.colors.buttonDisabled},
        ],
        style,
      ]}
      onPress={onPress}
      disabled={disabled}
      {...props}>
      {iconName && (
        <Icon
          name={iconName}
          size={16}
          color={
            disabled
              ? theme.colors.palette.mediumGray
              : type === "secondary"
                ? theme.colors.buttonPrimary
                : theme.colors.palette.neutral100
          }
          style={styles.buttonIcon}
        />
      )}
      <Text
        text={title || (typeof children === "string" ? children : "")}
        style={[
          styles.buttonText,
          {color: theme.colors.palette.neutral100},
          disabled && [styles.buttonTextDisabled, {color: theme.colors.palette.mediumGray}],
          type === "secondary" && [styles.buttonTextSecondary, {color: theme.colors.buttonPrimary}],
        ]}
      />
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  button: {
    width: "100%",
    maxWidth: 300,
    height: 44,
    borderRadius: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    elevation: 2,
    shadowColor: "#000", // Keep shadow colors as they're universal
    shadowOffset: {width: 0, height: 1},
    shadowOpacity: 0.2,
    shadowRadius: 1.41,
  },
  buttonDisabled: {
    elevation: 0,
    shadowOpacity: 0,
  },
  buttonIcon: {
    marginRight: 8,
  },
  buttonSecondary: {
    backgroundColor: "transparent",
    borderWidth: 1,
    elevation: 0,
    shadowOpacity: 0,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "bold",
  },
  buttonTextDisabled: {
    // Color handled inline with theme
  },
  buttonTextSecondary: {
    // Color handled inline with theme
  },
})

export default Button
