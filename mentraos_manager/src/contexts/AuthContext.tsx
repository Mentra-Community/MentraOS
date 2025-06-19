import React, {createContext, useEffect, useState, useContext} from "react"
import {supabase} from "@/supabase/supabaseClient"
import {LogoutUtils} from "@/utils/LogoutUtils"

interface AuthContextProps {
  user: any // or a more specific type from @supabase/supabase-js
  session: any
  loading: boolean
  logout: () => void
}

const AuthContext = createContext<AuthContextProps>({
  user: null,
  session: null,
  loading: true,
  logout: () => {},
})

export const AuthProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const [session, setSession] = useState<any>(null)
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 1. Check for an active session on mount
    const getInitialSession = async () => {
      const {
        data: {session},
      } = await supabase.auth.getSession()

      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)
    }

    getInitialSession().catch(error => {
      console.error("AuthContext: Error getting initial session:", error)
      setLoading(false)
    })

    // 2. Listen for auth changes
    const {
      data: {subscription},
    } = supabase.auth.onAuthStateChange((event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      setLoading(false)
    })

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
