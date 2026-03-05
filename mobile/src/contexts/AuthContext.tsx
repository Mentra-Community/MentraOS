import * as Sentry from "@sentry/react-native"
import CoreModule from "core"
import {FC, createContext, useEffect, useState, useContext} from "react"

import mentraAuth from "@/utils/auth/authClient"
import {MentraAuthSession, MentraAuthUser} from "@/utils/auth/authProvider.types"
import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
import {storage} from "@/utils/storage"
import restComms from "@/services/RestComms"
import {Session} from "@supabase/supabase-js"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

interface AuthContextProps {
  user: MentraAuthUser | null
  session: MentraAuthSession | null
  loading: boolean
  logout: () => void
}

const AuthContext = createContext<AuthContextProps>({
  user: null,
  session: null,
  loading: true,
  logout: () => {},
})

class LogoutUtils {
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
      await CoreModule.disconnect()
      console.log(`${this.TAG}: Disconnected glasses`)
    } catch (error) {
      console.warn(`${this.TAG}: Error disconnecting glasses:`, error)
    }

    try {
      // Then forget the glasses completely
      await CoreModule.forget()
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

    const res = await mentraAuth.signOut()
    if (res.is_error()) {
      console.error(`${this.TAG}: Error signing out:`, res.error)
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

    for (const key of supabaseKeys) {
      const res = await storage.remove(key)
      if (res.is_error()) {
        console.error(`${this.TAG}: Error clearing Supabase token:`, res.error)
      }
    }
  }

  /**
   * Clear backend server communication tokens
   */
  private static async clearBackendTokens(): Promise<void> {
    console.log(`${this.TAG}: Clearing backend tokens...`)

    try {
      // Clear the core token from RestComms
      restComms.setCoreToken(null)
      console.log(`${this.TAG}: Cleared backend core token`)
    } catch (error) {
      console.error(`${this.TAG}: Error clearing backend tokens:`, error)
    }
  }

  /**
   * Clear all app-specific settings from AsyncStorage
   */
  private static async clearAppSettings(): Promise<void> {
    console.log(`${this.TAG}: Clearing app settings...`)

    // burn it all:
    try {
      useSettingsStore.getState().resetAllSettingsLocally()
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
    // Check if any critical auth tokens remain
    const res = storage.load<Session>("supabase.auth.session")
    let supabaseSession = null
    if (res.is_ok()) {
      supabaseSession = res.value
    }
    const coreToken = restComms.getCoreToken()

    const isLoggedOut = !supabaseSession && !coreToken

    console.log(`${this.TAG}: Logout verification - Success: ${isLoggedOut}`)
    return isLoggedOut
  }
}

export const AuthProvider: FC<{children: React.ReactNode}> = ({children}) => {
  const [session, setSession] = useState<any>(null)
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [_authEmail, setAuthEmail] = useSetting(SETTINGS.auth_email.key)

  useEffect(() => {
    let subscription: {unsubscribe: () => void} | undefined

    // 1. Check for an active session on mount
    const getInitialSession = async () => {
      // console.log("AuthContext: Getting initial session")
      const res = await mentraAuth.getSession()
      if (res.is_error()) {
        console.error("AuthContext: Error getting initial session:", res.error)
        setLoading(false)
        return
      }
      const session = res.value
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)
    }

    // 2. Setup auth state change listener
    const setupAuthListener = async () => {
      const res = await mentraAuth.onAuthStateChange((_event, session: any) => {
        // console.log("AuthContext: Auth state changed:", event)
        // console.log("AuthContext: Session:", session)
        // console.log("AuthContext: User:", session?.user)
        setSession(session)
        setUser(session?.user ?? null)
        setLoading(false)
        // set sentry user:
        Sentry.setUser({
          id: session?.user?.id,
          email: session?.user?.email,
        })
        // Send user email to glasses for crash reporting
        if (session?.user?.email) {
          setAuthEmail(session.user.email)
        }
      })
      console.log("AuthContext: setupAuthListener()", res)
      if (res.is_ok()) {
        let changeData = res.value
        if (changeData.data?.subscription) {
          subscription = changeData.data.subscription
        }
      }
    }

    getInitialSession()
    setupAuthListener()

    // Cleanup the listener
    return () => {
      subscription?.unsubscribe()
    }
  }, [])

  const logout = async () => {
    console.log("AuthContext: Starting logout process")

    try {
      // Use the comprehensive logout utility
      await LogoutUtils.performCompleteLogout()

      // Verify logout was successful
      const logoutSuccessful = await LogoutUtils.verifyLogoutSuccess()
      if (!logoutSuccessful) {
        console.warn("AuthContext: Logout verification failed, but continuing...")
      }

      // Update local state
      setSession(null)
      setUser(null)

      console.log("AuthContext: Logout process completed")
    } catch (error) {
      console.error("AuthContext: Error during logout:", error)

      // Even if there's an error, clear local state to prevent user from being stuck
      setSession(null)
      setUser(null)
    }
  }

  const value: AuthContextProps = {
    user,
    session,
    loading,
    logout,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
