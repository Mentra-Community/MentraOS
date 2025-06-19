import AsyncStorage from "@react-native-async-storage/async-storage"
import {supabase} from "@/supabase/supabaseClient"
import coreCommunicator from "@/bridge/CoreCommunicator"
import {stopExternalService} from "@/bridge/CoreServiceStarter"
import BackendServerComms from "@/backend_comms/BackendServerComms"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {SETTINGS_KEYS} from "@/consts"

export class LogoutUtils {
  private static readonly TAG = "LogoutUtils"

  /**
   * Comprehensive logout that completely nukes all user state and connections
   * This should be used for both regular logout and account deletion scenarios
   */
  public static async performCompleteLogout(): Promise<void> {
    console.log(`${this.TAG}: Starting complete logout process...`)

    try {
      // Step 1: Disconnect and forget any connected glasses
      await this.disconnectAndForgetGlasses()

      // Step 2: Clear Supabase authentication
      await this.clearSupabaseAuth()

      // Step 3: Clear backend communication tokens
      await this.clearBackendTokens()

      // Step 4: Stop and cleanup core services
      await this.stopCoreServices()

      // Step 5: Clear all app settings and user data
      await this.clearAppSettings()

      // Step 6: Clear any remaining auth-related storage
      await this.clearAuthStorage()

      // Step 7: Reset status providers and event emitters
      await this.resetStatusProviders()

      console.log(`${this.TAG}: Complete logout process finished successfully`)
    } catch (error) {
      console.error(`${this.TAG}: Error during logout process:`, error)
      // Continue with cleanup even if some steps fail
    }
  }

  /**
   * Disconnect and forget any connected glasses
   */
  private static async disconnectAndForgetGlasses(): Promise<void> {
    console.log(`${this.TAG}: Disconnecting and forgetting glasses...`)

    try {
      // First try to disconnect any connected glasses
      await coreCommunicator.sendDisconnectWearable()
      console.log(`${this.TAG}: Disconnected glasses`)
    } catch (error) {
      console.warn(`${this.TAG}: Error disconnecting glasses:`, error)
    }

    try {
      // Then forget the glasses completely
      await coreCommunicator.sendForgetSmartGlasses()
      console.log(`${this.TAG}: Forgot glasses pairing`)
    } catch (error) {
      console.warn(`${this.TAG}: Error forgetting glasses:`, error)
    }
  }

  /**
   * Clear Supabase authentication and related tokens
   */
  private static async clearSupabaseAuth(): Promise<void> {
    console.log(`${this.TAG}: Clearing Supabase authentication...`)

    try {
      // Try to sign out with Supabase - may fail in offline mode
      await supabase.auth.signOut().catch(err => {
        console.log(`${this.TAG}: Supabase sign-out failed, continuing with local cleanup:`, err)
      })
    } catch (error) {
      console.warn(`${this.TAG}: Supabase signOut failed:`, error)
    }

    // Completely clear ALL Supabase Auth storage
    const supabaseKeys = [
      "supabase.auth.token",
      "supabase.auth.refreshToken",
      "supabase.auth.session",
      "supabase.auth.expires_at",
      "supabase.auth.expires_in",
      "supabase.auth.provider_token",
      "supabase.auth.provider_refresh_token",
    ]

    try {
      await AsyncStorage.multiRemove(supabaseKeys)
      console.log(`${this.TAG}: Cleared Supabase auth tokens`)
    } catch (error) {
      console.error(`${this.TAG}: Error clearing Supabase tokens:`, error)
    }
  }

  /**
   * Clear backend server communication tokens
   */
  private static async clearBackendTokens(): Promise<void> {
    console.log(`${this.TAG}: Clearing backend tokens...`)

    try {
      // Clear the core token from BackendServerComms
      BackendServerComms.getInstance().setCoreToken(null)
      console.log(`${this.TAG}: Cleared backend core token`)
    } catch (error) {
      console.error(`${this.TAG}: Error clearing backend tokens:`, error)
    }
  }

  /**
   * Stop core services and cleanup connections
   */
  private static async stopCoreServices(): Promise<void> {
    console.log(`${this.TAG}: Stopping core services...`)

    try {
      // Delete core authentication secret key
      await coreCommunicator.deleteAuthenticationSecretKey()
      console.log(`${this.TAG}: Deleted core authentication secret key`)
    } catch (error) {
      console.error(`${this.TAG}: Error deleting auth secret key:`, error)
    }

    try {
      // Stop the core communicator service
      coreCommunicator.stopService()
      console.log(`${this.TAG}: Stopped core communicator service`)
    } catch (error) {
      console.error(`${this.TAG}: Error stopping core service:`, error)
    }

    try {
      // Stop external services
      stopExternalService()
      console.log(`${this.TAG}: Stopped external services`)
    } catch (error) {
      console.error(`${this.TAG}: Error stopping external services:`, error)
    }

    try {
      // Clean up communicator resources
      coreCommunicator.cleanup()
      console.log(`${this.TAG}: Cleaned up core communicator resources`)
    } catch (error) {
      console.error(`${this.TAG}: Error cleaning up communicator:`, error)
    }
  }

  /**
   * Clear all app-specific settings from AsyncStorage
   */
  private static async clearAppSettings(): Promise<void> {
    console.log(`${this.TAG}: Clearing app settings...`)

    try {
      // Clear specific settings that should be reset on logout
      const settingsToKeep = [
        SETTINGS_KEYS.THEME_PREFERENCE, // Keep theme preference
        SETTINGS_KEYS.CUSTOM_BACKEND_URL, // Keep custom backend URL if set
      ]

      const settingsToClear = Object.values(SETTINGS_KEYS).filter(key => !settingsToKeep.includes(key))

      if (settingsToClear.length > 0) {
        await AsyncStorage.multiRemove(settingsToClear)
        console.log(`${this.TAG}: Cleared ${settingsToClear.length} app settings`)
      }
    } catch (error) {
      console.error(`${this.TAG}: Error clearing app settings:`, error)
    }
  }

  /**
   * Clear any remaining authentication-related storage
   */
  private static async clearAuthStorage(): Promise<void> {
    console.log(`${this.TAG}: Clearing remaining auth storage...`)

    try {
      // Get all AsyncStorage keys and filter for user/auth related ones
      const allKeys = await AsyncStorage.getAllKeys()
      const authKeys = allKeys.filter(
        (key: string) =>
          key.startsWith("supabase.auth.") ||
          key.includes("user") ||
          key.includes("token") ||
          key.includes("session") ||
          key.includes("auth"),
      )

      if (authKeys.length > 0) {
        await AsyncStorage.multiRemove(authKeys)
        console.log(`${this.TAG}: Cleared ${authKeys.length} additional auth keys`)
      }
    } catch (error) {
      console.error(`${this.TAG}: Error clearing auth storage:`, error)
    }
  }

  /**
   * Reset status providers and emit cleanup events
   */
  private static async resetStatusProviders(): Promise<void> {
    console.log(`${this.TAG}: Resetting status providers...`)

    try {
      // Remove all core communicator event listeners
      coreCommunicator.removeAllListeners("statusUpdateReceived")
      coreCommunicator.removeAllListeners("dataReceived")

      // Remove global event listeners
      GlobalEventEmitter.removeAllListeners("STATUS_PARSE_ERROR")

      // Emit a logout event for any components that need to reset
      GlobalEventEmitter.emit("USER_LOGGED_OUT")

      // Emit an event to reset app status
      GlobalEventEmitter.emit("RESET_APP_STATUS")

      // Emit event to clear WebView data and cache
      GlobalEventEmitter.emit("CLEAR_WEBVIEW_DATA")

      console.log(`${this.TAG}: Reset status providers and event listeners`)
    } catch (error) {
      console.error(`${this.TAG}: Error resetting status providers:`, error)
    }
  }

  /**
   * Lightweight logout for testing or scenarios where full cleanup isn't needed
   */
  public static async performLightLogout(): Promise<void> {
    console.log(`${this.TAG}: Starting light logout process...`)

    try {
      await this.clearSupabaseAuth()
      await this.clearBackendTokens()
      console.log(`${this.TAG}: Light logout process completed`)
    } catch (error) {
      console.error(`${this.TAG}: Error during light logout:`, error)
    }
  }

  /**
   * Check if user is properly logged out by verifying key storage items
   */
  public static async verifyLogoutSuccess(): Promise<boolean> {
    try {
      // Check if any critical auth tokens remain
      const supabaseSession = await AsyncStorage.getItem("supabase.auth.session")
      const coreToken = BackendServerComms.getInstance().getCoreToken()

      const isLoggedOut = !supabaseSession && !coreToken

      console.log(`${this.TAG}: Logout verification - Success: ${isLoggedOut}`)
      return isLoggedOut
    } catch (error) {
      console.error(`${this.TAG}: Error verifying logout:`, error)
      return false
    }
  }
}
