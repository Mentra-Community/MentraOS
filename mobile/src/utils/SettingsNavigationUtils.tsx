import {requireNativeModule} from "expo-modules-core"
import {Linking, Platform} from "react-native"

const Core = requireNativeModule("Core")

/**
 * Utility functions for navigating to system settings pages
 */
export class SettingsNavigationUtils {
  /**
   * Opens Bluetooth settings page
   * On Android: Uses native module to open Bluetooth settings directly
   * On iOS: Opens general settings (iOS doesn't have direct Bluetooth settings access)
   */
  static async openBluetoothSettings(): Promise<boolean> {
    try {
      if (Platform.OS === "android") {
        // Use native module for direct Bluetooth settings access
        await Core.openBluetoothSettings()
        return true
      } else if (Platform.OS === "ios") {
        // iOS doesn't have direct Bluetooth settings access, open general settings
        const canOpen = await Linking.canOpenURL("App-Prefs:Bluetooth")
        if (canOpen) {
          await Linking.openURL("App-Prefs:Bluetooth")
        } else {
          await Linking.openURL("App-Prefs:General")
        }
        return true
      }
      return false
    } catch (error) {
      console.error("Error opening Bluetooth settings:", error)
      return false
    }
  }

  /**
   * Shows location services dialog (Android) or opens location settings (iOS)
   * On Android: Uses Google Play Services dialog for better UX
   * On iOS: Opens location settings
   */
  static async showLocationServicesDialog(): Promise<boolean> {
    try {
      if (Platform.OS === "android") {
        // Use native module for location services dialog (better UX)
        await Core.showLocationServicesDialog()
        return true
      } else if (Platform.OS === "ios") {
        // iOS doesn't have a similar dialog, open location settings
        const canOpen = await Linking.canOpenURL("App-Prefs:Privacy&path=LOCATION")
        if (canOpen) {
          await Linking.openURL("App-Prefs:Privacy&path=LOCATION")
        } else {
          await Linking.openURL("App-Prefs:General")
        }
        return true
      }
      return false
    } catch (error) {
      console.error("Error showing location services dialog:", error)
      return false
    }
  }

  /**
   * Opens location settings page (fallback method)
   * Use showLocationServicesDialog() for better UX on Android
   */
  static async openLocationSettings(): Promise<boolean> {
    try {
      if (Platform.OS === "android") {
        // Use native module for direct location settings access
        await Core.openLocationSettings()
        return true
      } else if (Platform.OS === "ios") {
        // iOS doesn't have direct location settings access, open general settings
        const canOpen = await Linking.canOpenURL("App-Prefs:Privacy&path=LOCATION")
        if (canOpen) {
          await Linking.openURL("App-Prefs:Privacy&path=LOCATION")
        } else {
          await Linking.openURL("App-Prefs:General")
        }
        return true
      }
      return false
    } catch (error) {
      console.error("Error opening location settings:", error)
      return false
    }
  }

  /**
   * Opens app settings page
   * On Android: Opens app-specific settings
   * On iOS: Opens app settings
   */
  static async openAppSettings(): Promise<boolean> {
    try {
      if (Platform.OS === "android") {
        // Use native module for app settings
        await Core.openAppSettings()
        return true
      } else if (Platform.OS === "ios") {
        // iOS app settings
        await Linking.openURL("App-Prefs:General")
        return true
      }
      return false
    } catch (error) {
      console.error("Error opening app settings:", error)
      return false
    }
  }

  /**
   * Opens app permissions settings
   */
  static async openAppPermissionsSettings(): Promise<void> {
    try {
      await Linking.openSettings()
    } catch (error) {
      console.error("Failed to open app settings:", error)
    }
  }

  /**
   * Opens the appropriate settings page based on the requirement
   */
  static async openSettingsForRequirement(
    requirement: "bluetooth" | "location" | "locationServices" | "permissions",
  ): Promise<boolean> {
    try {
      switch (requirement) {
        case "bluetooth":
          return await this.openBluetoothSettings()
        case "location":
          return await this.openLocationSettings()
        case "locationServices":
          return await this.showLocationServicesDialog()
        case "permissions":
          return await this.openAppSettings()
        default:
          console.warn("Unknown requirement:", requirement)
          return false
      }
    } catch (error) {
      console.error("Error opening settings for requirement:", requirement, error)
      return false
    }
  }
}
