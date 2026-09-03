import {engine} from "@mentra/engine"

import mantle from "@/services/MantleManager"
import {settleFrame} from "@/utils/settleFrame"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import mentraAuth from "@/utils/auth/authClient"
import {storage} from "@/utils/storage"
import {cloudClient} from "@/services/cloudClient"

export class LogoutUtils {
  private static readonly TAG = "LogoutUtils"

  /**
   * Comprehensive logout that completely nukes all user state and connections
   * This should be used for both regular logout and account deletion scenarios
   */
  public static async performCompleteLogout(options: {skipAuthSignOut?: boolean} = {}): Promise<void> {
    console.log(`${this.TAG}: Starting complete logout process...`)

    try {
      // Step 1: Sign out first, so the UI leaves the screen that called us.
      //
      // Logout is almost always triggered from Settings → Profile → Log Out,
      // and that screen renders *inside the miniapp surface*. Step 2 tears that
      // surface down (mantle.cleanup() → localMiniappRuntime.cleanup()), so
      // running it first pulls the container out from under a component that is
      // still mounted and still awaiting this call. Fabric then fails to
      // reparent a view that already has a parent, React Native escalates that
      // to a host exception, and the ReactHost is destroyed — leaving a white
      // screen that survives navigation and only a force-quit clears (OS-1834).
      //
      // Signing out emits SIGNED_OUT, AuthContext drops the session, and the
      // tree re-renders to the auth stack, which unmounts the miniapp surface
      // on its own. That delivery is what OS-1828 fixed: before that, this
      // event never reached AuthContext at all.
      if (!options.skipAuthSignOut) {
        await this.clearAuthSession()
      }
      await cloudClient.clearAuthSession()

      // Step 2: Let that unmount actually commit before destroying what it was
      // rendering. Without this the teardown below still races the re-render
      // described above.
      await settleFrame()

      // Step 3: Disconnect and forget any connected glasses
      await this.disconnectAndForgetGlasses()

      // Step 4: Stop island runtime services
      await this.stopToolkitRuntime()

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
      await engine.glasses.disconnect()
      console.log(`${this.TAG}: Disconnected glasses`)
    } catch (error) {
      console.warn(`${this.TAG}: Error disconnecting glasses:`, error)
    }

    try {
      // Then forget the glasses completely
      await engine.glasses.forget()
      console.log(`${this.TAG}: Forgot glasses pairing`)
    } catch (error) {
      console.warn(`${this.TAG}: Error forgetting glasses:`, error)
    }
  }

  /**
   * Stop island runtime services that were started by engine.start().
   *
   * MantleManager.cleanup() runs first: it tears down the host-side wiring from
   * the previous session AND resets its `initialized` guard, so the next login in
   * the same process re-runs mantle.init() → engine.configure()/start() instead
   * of leaving the stopped runtime dead until an app restart.
   */
  private static async stopToolkitRuntime(): Promise<void> {
    console.log(`${this.TAG}: Stopping island runtime...`)

    try {
      await mantle.cleanup()
      console.log(`${this.TAG}: Cleaned up MantleManager`)
    } catch (error) {
      console.warn(`${this.TAG}: Error cleaning up MantleManager:`, error)
    }

    try {
      await engine.stop()
      console.log(`${this.TAG}: Stopped island runtime`)
    } catch (error) {
      console.warn(`${this.TAG}: Error stopping island runtime:`, error)
    }
  }

  /**
   * Sign out of the auth provider (V2 account tokens), then wipe the legacy
   * Supabase storage keys so users upgrading from pre-cutover builds don't
   * carry stale auth material forward.
   */
  private static async clearAuthSession(): Promise<void> {
    console.log(`${this.TAG}: Clearing auth session...`)

    const res = await mentraAuth.signOut()
    if (res.is_error()) {
      console.error(`${this.TAG}: Error signing out:`, res.error)
    }

    // Legacy pre-cutover Supabase storage keys (migration hygiene only).
    const supabaseKeys = [
      "supabase.auth.token",
      "supabase.auth.refreshToken",
      "supabase.auth.session",
      "supabase.auth.expires_at",
      "supabase.auth.expires_in",
      "supabase.auth.provider_token",
      "supabase.auth.provider_refresh_token",
    ]

    for (const key of supabaseKeys) {
      const res = await storage.remove(key)
      if (res.is_error()) {
        console.error(`${this.TAG}: Error clearing Supabase token:`, res.error)
      }
    }
  }

  /**
   * Clear all app-specific settings from AsyncStorage
   */
  private static async clearAppSettings(): Promise<void> {
    console.log(`${this.TAG}: Clearing app settings...`)

    // burn it all:
    try {
      engine.settings.resetAllLocal()
      storage.clearAll()
    } catch (error) {
      console.error(`${this.TAG}: Error clearing app settings:`, error)
    }
  }

  /**
   * Clear any remaining authentication-related storage
   */
  private static async clearAuthStorage(): Promise<void> {
    console.log(`${this.TAG}: Clearing remaining auth storage...`)

    // Get all AsyncStorage keys and filter for user/auth related ones
    const allKeys = storage.getAllKeys()
    const authKeys = allKeys.filter(
      (key: string) =>
        key.startsWith("supabase.auth.") ||
        key.includes("user") ||
        key.includes("token") ||
        key.includes("session") ||
        key.includes("auth"),
    )

    if (authKeys.length > 0) {
      const res = await storage.removeMultiple(authKeys)
      if (res.is_error()) {
        console.error(`${this.TAG}: Error clearing auth storage:`, res.error)
      } else {
        console.log(`${this.TAG}: Cleared ${authKeys.length} additional auth keys`)
      }
    }
  }

  /**
   * Reset status providers and emit cleanup events
   */
  private static async resetStatusProviders(): Promise<void> {
    console.log(`${this.TAG}: Resetting status providers...`)

    try {
      // Emit event to clear WebView data and cache
      GlobalEventEmitter.emit("CLEAR_WEBVIEW_DATA")

      console.log(`${this.TAG}: Reset status providers and event listeners`)
    } catch (error) {
      console.error(`${this.TAG}: Error resetting status providers:`, error)
    }
  }

  /**
   * Check if user is properly logged out by verifying key storage items
   */
  public static async verifyLogoutSuccess(): Promise<boolean> {
    // The device only holds V2 account tokens now (issue 019); logged out
    // means the MMKV token pair is gone.
    const access = storage.load<string>("mentra.account.accessToken")
    const refresh = storage.load<string>("mentra.account.refreshToken")
    const isLoggedOut = (access.is_error() || !access.value) && (refresh.is_error() || !refresh.value)

    console.log(`${this.TAG}: Logout verification - Success: ${isLoggedOut}`)
    return isLoggedOut
  }
}
