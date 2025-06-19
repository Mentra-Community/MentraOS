import React from "react"
import {Alert, AlertButton} from "react-native"
import BasicDialog from "@/components/ignite/BasicDialog"
import Icon from "react-native-vector-icons/MaterialCommunityIcons"
import {StyleSheet, View} from "react-native"
import {useAppTheme} from "./useAppTheme"
import {BackHandler} from "react-native"

// Type for button style options
type ButtonStyle = "default" | "cancel" | "destructive"

// Button interface aligned with MessageModal
interface ModalButton {
  text: string
  onPress?: () => void
  style?: ButtonStyle
}

// Global state to manage the modal
let modalRef: {
  showModal: (
    title: string,
    message: string,
    buttons?: AlertButton[],
    options?: {
      isDarkTheme?: boolean
      iconName?: string
      iconSize?: number
      iconColor?: string
      icon?: React.ReactNode
    },
  ) => void
} | null = null

// Function to register the modal reference
export const setModalRef = (ref: typeof modalRef) => {
  modalRef = ref
}

// Converts a React Native AlertButton to our ModalButton format
const convertToModalButton = (button: AlertButton, index: number, totalButtons: number): ModalButton => {
  let style: ButtonStyle = "default"

  // Heuristics to determine button style based on text and position
  if (button.style === "cancel" || button.style === "destructive") {
    // Use RN's native styles if provided
    style = button.style
  } else if (button.text && ["cancel", "no", "back"].includes(button.text.toLowerCase())) {
    style = "cancel"
  } else if (button.text && ["delete", "remove", "destroy"].includes(button.text.toLowerCase())) {
    style = "destructive"
  } else if (index === totalButtons - 1) {
    // Last button is usually confirm/primary
    style = "default"
  }

  return {
    text: button.text || "",
    onPress: button.onPress,
    style,
  }
}

// Global component that will be rendered once at the app root
export function ModalProvider({children}: {children: React.ReactNode}) {
  const {theme} = useAppTheme()
  const [visible, setVisible] = React.useState(false)
  const [title, setTitle] = React.useState("")
  const [message, setMessage] = React.useState("")
  const [buttons, setButtons] = React.useState<ModalButton[]>([])
  const [options, setOptions] = React.useState<{
    iconName?: string
    iconSize?: number
    iconColor?: string
    icon?: React.ReactNode
  }>({})

  React.useEffect(() => {
    const backHandler = () => {
      if (visible) {
        return true // prevent default back behavior
      }
      return false
    }

    const subscription = BackHandler.addEventListener("hardwareBackPress", backHandler)

    return () => subscription.remove()
  }, [visible])

  React.useEffect(() => {
    // Register the modal functions for global access
    setModalRef({
      showModal: (title, message, alertButtons = [], opts = {}) => {
        setTitle(title)
        setMessage(message)

        // Convert all buttons to our ModalButton format with style hints
        const modalButtons =
          alertButtons.length > 0
            ? alertButtons.map((btn, idx) => convertToModalButton(btn, idx, alertButtons.length))
            : [{text: "OK"}]

        setButtons(modalButtons)

        // Set options with fallback to component's props
        setOptions({
          iconName: opts.iconName,
          iconSize: opts.iconSize,
          iconColor: opts.iconColor,
          icon: opts.icon,
        })

        setVisible(true)
      },
    })

    return () => {
      setModalRef(null)
    }
  }, [])

  const handleDismiss = () => {
    setVisible(false)
  }

  return (
    <>
      {children}
      {visible && (
        <View
          style={{
            ...StyleSheet.absoluteFillObject,
            zIndex: 10,
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: theme.colors.modalOverlay,
            paddingHorizontal: 24,
          }}>
          <View
            style={{
              width: "100%",
              maxWidth: 400,
              borderRadius: 16,
              overflow: "hidden",
            }}>
            <BasicDialog
              title={title}
              description={message}
              icon={
                options.icon ??
                (options.iconName ? (
                  <Icon name={options.iconName} size={options.iconSize ?? 24} color={options.iconColor} />
                ) : undefined)
              }
              leftButtonText={buttons.length > 1 ? buttons[0].text : undefined}
              onLeftPress={
                buttons.length > 1
                  ? () => {
                      buttons[0].onPress?.()
                      setVisible(false)
                    }
                  : undefined
              }
              rightButtonText={buttons.length > 1 ? buttons[1].text : buttons[0].text}
              onRightPress={() => {
                if (buttons.length > 1) {
                  buttons[1].onPress?.()
                } else {
                  buttons[0].onPress?.()
                }
                setVisible(false)
              }}
            />
          </View>
        </View>
      )}
    </>
  )
}

export const showAlert = (
  title: string,
  message: string,
  buttons: AlertButton[] = [{text: "OK"}],
  options?: {
    cancelable?: boolean
    onDismiss?: () => void
    useNativeAlert?: boolean
    iconName?: string
    iconSize?: number
    iconColor?: string
    icon?: React.ReactNode
  },
): Promise<void> => {
  return new Promise(resolve => {
    const handleDismiss = () => {
      options?.onDismiss?.()
      resolve()
    }

    // Fall back to native Alert if modalRef is not set or if explicitly requested
    if (!modalRef || options?.useNativeAlert) {
      return Alert.alert(title, message, buttons, {
        cancelable: options?.cancelable ?? true,
        onDismiss: handleDismiss,
      })
    }

    const wrappedButtons = buttons.map(button => ({
      ...button,
      onPress: () => {
        button.onPress?.()
        resolve()
      },
    }))

    // Use custom modal implementation
    modalRef.showModal(title, message, wrappedButtons, {
      iconName: options?.iconName,
      iconSize: options?.iconSize,
      iconColor: options?.iconColor,
      icon: options?.icon,
    })
  })
}

export default showAlert
