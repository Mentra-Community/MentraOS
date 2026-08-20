import * as Sentry from "@sentry/react-native"
import {FC, createContext, useEffect, useState, useContext} from "react"

import {SETTINGS, useSetting} from "@mentra/engine"
import {LogoutUtils} from "@/utils/LogoutUtils"
import mentraAuth from "@/utils/auth/authClient"
import {ensureDevModeForUser} from "@/utils/dev/devModeAllowlist"
import {MentraAuthSession, MentraAuthUser} from "@/utils/auth/authProvider.types"

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

export const AuthProvider: FC<{children: React.ReactNode}> = ({children}) => {
  const [session, setSession] = useState<any>(null)
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [_authEmail, setAuthEmail] = useSetting(SETTINGS.auth_email.key)

  useEffect(() => {
    let subscription: {unsubscribe: () => void} | undefined
    // onAuthStateChange() is async, so this effect can be cleaned up while the
    // subscribe call is still in flight. The subscription would then be created
    // *after* cleanup ran and never torn down. That used to be self-correcting,
    // because the provider held one slot and the next subscriber overwrote the
    // orphan; now that every listener is retained, the orphan would survive and
    // another would accumulate on each remount, updating an unmounted provider.
    let cancelled = false

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
      if (session?.user?.email) {
        setAuthEmail(session.user.email)
        void ensureDevModeForUser(session.user.email)
      }
      setLoading(false)
    }

    // 2. Setup auth state change listener
    const setupAuthListener = async () => {
      const res = await mentraAuth.onAuthStateChange((event, session: any) => {
        // Whether the UI's listener actually receives auth events is the whole
        // of OS-1828: the provider kept a single callback slot, the engine
        // registered second and silently replaced this one, and sign-in went
        // nowhere. There was no log either way, so the failure looked like
        // "SSO is flaky". Never log the session itself — tokens live on it.
        console.log(`AuthContext: auth state ${event}, session ${session ? "present" : "absent"}`)
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
          void ensureDevModeForUser(session.user.email)
        }
      })
      console.log("AuthContext: setupAuthListener()", res)
      if (res.is_ok()) {
        // The provider returns {unsubscribe}. This used to look for
        // {data:{subscription}} — a Supabase shape that no provider has emitted
        // since the Cloud V2 cutover — so `subscription` stayed undefined and
        // the cleanup below was a silent no-op, leaking a listener on every
        // remount. Accept the current shape, keeping the old one for safety.
        const changeData = res.value as {
          unsubscribe?: () => void
          data?: {subscription?: {unsubscribe: () => void}}
        }
        const resolved =
          changeData.data?.subscription ??
          (typeof changeData.unsubscribe === "function" ? {unsubscribe: changeData.unsubscribe} : undefined)

        // Cleanup already ran while we were awaiting, so nothing will unsubscribe
        // this later. Drop it here instead of leaving it registered forever.
        if (cancelled) resolved?.unsubscribe()
        else subscription = resolved
      }
    }

    getInitialSession()
    setupAuthListener()

    // Cleanup the listener
    return () => {
      cancelled = true
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
