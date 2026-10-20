import {Alert, Linking} from "react-native"

import {Icon, IconTypes} from "@/components/ignite"
import {
  type AlertButton as SheetAlertButton,
  type ButtonStyle,
  dismissAlert as dismissSheetAlert,
  hasAlertHost,
  showAlert as presentAlert,
} from "@/contexts/ModalContext"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"

import {SettingsNavigationUtils} from "./SettingsNavigationUtils"

/**
 * The app's alerts, as callbacks: `showAlert(title, message, buttons)` runs the pressed button's
 * `onPress`. They show as the alert sheet in `@/contexts/ModalContext`. Before it's mounted, they fall
 * back to the system alert.
 */

/** Button words that mean cancel or destroy, in English and in the app's language, for buttons without a style. */
const words = (keys: Array<Parameters<typeof translate>[0]>, english: string[]) =>
  new Set([...english, ...keys.map((key) => translate(key))].map((word) => word.toLowerCase()))

const sheetStyle = (button: AlertButton): ButtonStyle => {
  if (button.style) return button.style
  const text = button.text?.toLowerCase() ?? ""
  if (words(["common:cancel", "common:no", "common:back"], ["cancel", "no", "back"]).has(text)) return "cancel"
  if (words(["common:delete"], ["delete", "remove", "destroy"]).has(text)) return "destructive"
  return "default"
}

function AlertIcon({name, size, color}: {name: string; size?: number; color?: string}) {
  const {theme} = useAppTheme()
  return <Icon name={name as IconTypes} size={size ?? 32} color={color ?? theme.colors.secondary_foreground} />
}

export interface AlertButton {
  text: string
  onPress?: () => void
  style?: "default" | "cancel" | "destructive"
}

export interface AlertOptions {
  cancelable?: boolean
  iconName?: string
  iconColor?: string
  iconSize?: number
}

export interface ConnectivityAlertOptions extends AlertOptions {
  requirement?: "bluetooth" | "location" | "locationServices" | "permissions"
  showTurnOnButton?: boolean
  turnOnButtonText?: string
}

/**
 * Shows an alert sheet and runs the pressed button's `onPress` once the sheet has closed. With a cancel
 * button (styled "cancel", or worded Cancel, No or Back), swiping it away or Android back counts as
 * pressing it, unless `cancelable` is false.
 */
const showAlert = (title: string, message: string, buttons: AlertButton[] = [], options?: AlertOptions) => {
  if (!hasAlertHost()) {
    Alert.alert(title, message, buttons, options)
    return
  }
  const shown: AlertButton[] = buttons.length ? buttons : [{text: translate("common:ok")}]
  const sheetButtons: SheetAlertButton[] = shown.map((button) => ({text: button.text, style: sheetStyle(button)}))
  void presentAlert({
    title,
    message,
    buttons: sheetButtons,
    options: {
      allowDismiss: options?.cancelable !== false,
      icon: options?.iconName ? (
        <AlertIcon name={options.iconName} size={options.iconSize} color={options.iconColor} />
      ) : undefined,
    },
  })
    .then((index) => shown[index]?.onPress?.())
    .catch((error) => console.error(`Alert "${title}" button handler failed:`, error))
}

/**
 * Closes the alert titled `title` without running any button handler, and drops queued ones with that
 * title. For alerts whose condition resolved on its own.
 */
const dismissAlert = (title: string) => {
  dismissSheetAlert(title)
}

/**
 * Shows a connectivity-related alert with a "Turn On" button that opens the appropriate settings
 */
const showConnectivityAlert = (
  title: string,
  message: string,
  requirement: "bluetooth" | "location" | "locationServices" | "permissions",
  options?: ConnectivityAlertOptions,
) => {
  const buttons: AlertButton[] = []

  // Add "Turn On" button if enabled
  if (options?.showTurnOnButton !== false) {
    buttons.push({
      text: options?.turnOnButtonText || "Turn On",
      onPress: () => {
        SettingsNavigationUtils.openSettingsForRequirement(requirement)
      },
    })
  }

  // Add "Cancel" button
  buttons.push({
    text: "Cancel",
    style: "cancel",
  })

  showAlert(title, message, buttons, options)
}

/** The Turn On button (unless turned off) and Cancel, for a connectivity alert with its own icon. */
const turnOnButtons = (
  requirement: "bluetooth" | "location" | "permissions",
  turnOnText: string,
  options?: ConnectivityAlertOptions,
): AlertButton[] => [
  ...(options?.showTurnOnButton !== false
    ? [
        {
          text: options?.turnOnButtonText || turnOnText,
          onPress: () => SettingsNavigationUtils.openSettingsForRequirement(requirement),
        },
      ]
    : []),
  {text: "Cancel", style: "cancel"},
]

/**
 * Shows a Bluetooth-related alert with a "Turn On Bluetooth" button
 */
const showBluetoothAlert = (title: string, message: string, options?: ConnectivityAlertOptions) => {
  showAlert(title, message, turnOnButtons("bluetooth", "Turn On Bluetooth", options), {
    iconName: "bluetooth",
    iconColor: "#007AFF",
    iconSize: 32,
    ...options,
  })
}

/**
 * Shows a Location-related alert with a "Turn On Location" button
 */
const showLocationAlert = (title: string, message: string, options?: ConnectivityAlertOptions) => {
  showAlert(title, message, turnOnButtons("location", "Turn On Location", options), {
    iconName: "map-marker",
    iconColor: "#34C759",
    iconSize: 32,
    ...options,
  })
}

/**
 * Shows a Location Services alert with a "Turn On Location Services" button
 * Uses Google Play Services dialog on Android for better UX
 */
const showLocationServicesAlert = (title: string, message: string, options?: ConnectivityAlertOptions) => {
  // Show the location services dialog directly for better UX
  SettingsNavigationUtils.showLocationServicesDialog().catch((error) => {
    console.error("Error showing location services dialog:", error)
    // Fallback to regular alert if dialog fails
    showConnectivityAlert(title, message, "locationServices", {
      turnOnButtonText: "Turn On Location Services",
      ...options,
    })
  })
}

/**
 * Shows a Permissions alert with a "Open Settings" button
 */
const showPermissionsAlert = (title: string, message: string, options?: ConnectivityAlertOptions) => {
  showAlert(title, message, turnOnButtons("permissions", "Open Settings", options), {
    iconName: "shield-check",
    iconColor: "#FF9500",
    iconSize: 32,
    ...options,
  })
}

/**
 * Shows a "you are leaving the app" confirmation before opening an external URL
 * in the system browser. Use this anywhere we hand the user off to an outside
 * link (privacy policy, docs, etc.) so the copy and behavior stay consistent.
 */
const showLeaveAppAlert = (url: string) => {
  showAlert(translate("settings:leaveAppTitle"), translate("settings:leaveAppMessage"), [
    {text: translate("common:cancel"), style: "cancel"},
    {
      text: translate("common:continue"),
      onPress: () => {
        Linking.openURL(url).catch((error) => console.error("Failed to open external URL:", url, error))
      },
    },
  ])
}

/**
 * Shows a destructive action alert with a trash icon
 */
const showDestructiveAlert = (title: string, message: string, buttons: AlertButton[], options?: AlertOptions) => {
  showAlert(title, message, buttons, {iconName: "trash", iconSize: 32, ...options})
}

export {
  showAlert,
  dismissAlert,
  showConnectivityAlert,
  showBluetoothAlert,
  showLocationAlert,
  showLocationServicesAlert,
  showPermissionsAlert,
  showDestructiveAlert,
  showLeaveAppAlert,
}

export default showAlert
