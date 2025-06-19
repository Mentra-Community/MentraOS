import {useAppTheme} from "@/utils/useAppTheme"
import React from "react"
import {View, Text, Modal, TouchableOpacity, StyleSheet} from "react-native"
import Icon from "react-native-vector-icons/MaterialCommunityIcons"

interface ButtonProps {
  text: string
  onPress?: () => void
  style?: "default" | "cancel" | "destructive"
}

interface MessageModalProps {
  visible: boolean
  title: string
  message: string
  buttons?: ButtonProps[]
  onDismiss?: () => void
  iconName?: string
  iconSize?: number
  iconColor?: string
}

const MessageModal: React.FC<MessageModalProps> = ({
  visible,
  title,
  message,
  buttons = [{text: "Okay"}],
  onDismiss,
  iconName,
  iconSize = 40,
  iconColor,
}) => {
  const {theme} = useAppTheme()
  const defaultIconColor = iconColor || (theme.isDark ? "#FFFFFF" : "#2196F3")

  // Handle button press and dismiss modal
  const handleButtonPress = (onPress?: () => void) => {
    if (onPress) {
      onPress()
    }
    if (onDismiss) {
      onDismiss()
    }
  }

  // Determine how to render buttons based on count
  const renderButtons = () => {
    if (buttons.length === 0) {
      // Fallback to default button
      return (
        <TouchableOpacity
          style={[styles.modalButton, styles.singleButton, {backgroundColor: theme.colors.buttonPrimary}]}
          onPress={() => handleButtonPress(undefined)}>
          <Text style={[styles.modalButtonText, {color: theme.colors.palette.neutral100}]}>OK</Text>
        </TouchableOpacity>
      )
    } else if (buttons.length === 1) {
      // Single button - full width with minimum width
      return (
        <TouchableOpacity
          style={[styles.modalButton, styles.singleButton, {backgroundColor: theme.colors.buttonPrimary}]}
          onPress={() => handleButtonPress(buttons[0].onPress)}>
          <Text style={[styles.modalButtonText, {color: theme.colors.palette.neutral100}]}>{buttons[0].text}</Text>
        </TouchableOpacity>
      )
    } else {
      // Multiple buttons
      return (
        <View style={buttons.length > 2 ? styles.buttonColumnContainer : styles.buttonRowContainer}>
          {buttons.map((button, index) => {
            const isDestructive = button.style === "destructive"
            const isCancel = button.style === "cancel"

            return (
              <TouchableOpacity
                key={index}
                style={[
                  styles.modalButton,
                  {
                    backgroundColor: isDestructive
                      ? theme.colors.buttonDanger
                      : isCancel
                        ? theme.colors.palette.gray500
                        : theme.colors.buttonPrimary,
                  },
                  buttons.length > 2 ? styles.buttonFullWidth : styles.buttonHalfWidth,
                  index < buttons.length - 1 && buttons.length > 2 && styles.buttonMarginBottom,
                  index === 0 && buttons.length === 2 && styles.buttonMarginRight,
                ]}
                onPress={() => handleButtonPress(button.onPress)}>
                <Text style={[styles.modalButtonText, {color: theme.colors.palette.neutral100}]}>{button.text}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
      )
    }
  }

  return (
    <Modal transparent={true} visible={visible} animationType="fade" onRequestClose={onDismiss}>
      <View style={[styles.modalOverlay, {backgroundColor: theme.colors.modalOverlay}]}>
        <View
          style={[
            styles.modalContent,
            {backgroundColor: theme.isDark ? theme.colors.modalBackground : theme.colors.palette.neutral100},
          ]}>
          {iconName && <Icon name={iconName} size={iconSize} color={defaultIconColor} />}
          <Text style={[styles.modalTitle, theme.isDark ? styles.lightText : styles.darkText]}>{title}</Text>
          <Text style={[styles.modalDescription, theme.isDark ? styles.lightSubtext : styles.darkSubtext]}>
            {message}
          </Text>
          {renderButtons()}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    // backgroundColor moved to dynamic styling with theme
    justifyContent: "center",
    alignItems: "center",
  },
  modalContent: {
    alignItems: "center",
    borderRadius: 16,
    padding: 24,
    width: "85%",
  },
  modalContentLight: {
    // backgroundColor moved to dynamic styling with theme
  },
  modalContentDark: {
    // backgroundColor moved to dynamic styling with theme
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 8,
    marginTop: 16,
    textAlign: "center",
  },
  modalDescription: {
    fontSize: 16,
    lineHeight: 22,
    marginBottom: 24,
    textAlign: "center",
  },
  // Button styles
  buttonRowContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
  },
  buttonColumnContainer: {
    flexDirection: "column",
    width: "100%",
  },
  modalButton: {
    alignItems: "center",
    borderRadius: 8,
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  singleButton: {
    width: "100%", // Use full width for single buttons
    marginHorizontal: 0, // No horizontal margins
  },
  buttonFullWidth: {
    width: "100%",
  },
  buttonHalfWidth: {
    flex: 1,
  },
  buttonMarginBottom: {
    marginBottom: 10,
  },
  buttonMarginRight: {
    marginRight: 10,
  },
  modalButtonText: {
    fontSize: 16,
    fontWeight: "bold",
    textAlign: "center",
  },
  // Text styles - colors moved to dynamic styling
  lightText: {
    // Color handled dynamically with theme
  },
  darkText: {
    // Color handled dynamically with theme
  },
  lightSubtext: {
    // Color handled dynamically with theme
  },
  darkSubtext: {
    // Color handled dynamically with theme
  },
})

export default MessageModal
