import {requireNativeModule} from "expo-modules-core"
import {Linking, Platform} from "react-native"

const Core = requireNativeModule("Core")

/**
 * Utility functions for navigating to system settings pages
 */
export class SettingsNavigationUtils {
  static async openIosSettings(): Promise<void> {
    const canOpen = await Linking.canOpenURL("App-prefs:")
    if (canOpen) {
      await Linking.openURL("App-prefs:")
    } else {
      await Linking.openURL("app-settings:")
    }
  }

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
      } else if (Platform.OS === "ios") {
        // iOS doesn't have direct Bluetooth settings access, open general settings
        await this.openIosSettings()
        // await Linking.openURL("App-prefs:")
      }
      return true
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
        // TODO: this does not need to be in the core module:
        await Core.showLocationServicesDialog()
      } else if (Platform.OS === "ios") {
        await this.openIosSettings()
      }
      return true
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
      } else if (Platform.OS === "ios") {
        await this.openIosSettings()
      }
      return true
    } catch (error) {
      console.error("Error opening location settings:", error)
      return false
    }
  }

  /**
   * Opens WiFi settings page
   * On Android: Opens WiFi settings directly using Linking.sendIntent
   * On iOS: Opens general settings (iOS manages WiFi via Control Center)
   */
  static async openWifiSettings(): Promise<boolean> {
    try {
      if (Platform.OS === "android") {
        // Use Linking.sendIntent to open WiFi settings (no native code needed)
        await Linking.sendIntent("android.settings.WIFI_SETTINGS")
      } else if (Platform.OS === "ios") {
        // iOS doesn't have direct WiFi settings deep link
        // Users can enable WiFi from Control Center
        await this.openIosSettings()
      }
      return true
    } catch (error) {
      console.error("Error opening WiFi settings:", error)
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
      } else if (Platform.OS === "ios") {
        await this.openIosSettings()
      }
      return true
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
