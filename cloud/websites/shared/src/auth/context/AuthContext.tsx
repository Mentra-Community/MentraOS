import {createContext, useEffect, useState, useRef, useMemo} from "react"
import {mentraAuthProvider} from "../utils/auth/authProvider"
import axios from "axios"
import {
  MentraAuthSession,
  MentraAuthUser,
  MentraSigninResponse,
  MentraSignOutResponse,
} from "../utils/auth/authingProvider.types"

const CORE_API_URL = import.meta.env.VITE_API_URL || import.meta.env.VITE_CLOUD_API_URL || "http://localhost:8002"
const STORE_PACKAGE_NAME = "org.augmentos.store"

declare global {
  interface Window {
    location: Location
    setSupabaseToken: (token: string) => void
    setCoreToken: (token: string) => void
  }
}

export interface AuthContextType {
  session: MentraAuthSession | null
  user: MentraAuthUser | null
  isLoading: boolean
  isAuthenticated: boolean
  supabaseToken: string | null
  coreToken: string | null
  tokenReady: boolean
  isWebViewAuth: boolean
  signIn: (email: string, password: string) => Promise<MentraSigninResponse>

  signUp: (email: string, password: string, redirectPath: string) => Promise<MentraSigninResponse>
  signOut: () => Promise<MentraSignOutResponse>
  refreshUser: () => Promise<void>
}

// Create the context
export const AuthContext = createContext<AuthContextType | undefined>(undefined)

/**
 * Props for the AuthProvider component.
 */
interface AuthProviderProps {
  children: any
  /**
   * Set to true to enable WebView-specific authentication logic.
   * This includes checking for URL tokens and exposing global functions
   * for the native app to inject tokens.
   * @default false
   */
  enableWebViewAuth?: boolean
}

/**
 * Provides the AuthContext to its children.
 * This component manages all authentication state and logic.
 */
export function AuthProvider({
  children,
  enableWebViewAuth = false, // Default to false
}: AuthProviderProps) {
  // --- State Variables ---
  const [session, setSession] = useState<MentraAuthSession | null>(null)
  const [user, setUser] = useState<MentraAuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [providerToken, setProviderToken] = useState<string | null>(null)
  const [coreToken, setCoreToken] = useState<string | null>(null)
  const [tokenReady, setTokenReady] = useState(false)
  const [isWebViewAuth, setIsWebViewAuth] = useState(false) // Will remain false if webView is disabled
  const DEPLOYMENT_REGION = import.meta.env.VITE_DEPLOYMENT_REGION || "global"
  const isChina = DEPLOYMENT_REGION === "china"

  const prevUserIdRef = useRef<string | undefined>(undefined)
  const prevTokenRef = useRef<string | null>(null)

  const setupAxiosAuth = (token: string | null) => {
    if (token) {
      axios.defaults.headers.common["Authorization"] = `Bearer ${token}`
    } else {
      delete axios.defaults.headers.common["Authorization"]
    }
  }

  const exchangeForCoreToken = async (providerToken: string) => {
    try {
      setTokenReady(false)
      console.log("Exchanging Supabase token for Core token...")

      const response = await axios.post(
        `${CORE_API_URL}/api/auth/exchange-token`,
        {
          supabaseToken: isChina ? undefined : providerToken,
          authingToken: isChina ? providerToken : undefined,
        },
        {headers: {"Content-Type": "application/json"}},
      )

      if (response.status === 200 && response.data.coreToken) {
        console.log("Successfully exchanged token.")
        const newCoreToken = response.data.coreToken
        setupAxiosAuth(newCoreToken)
        setCoreToken(newCoreToken)
        localStorage.setItem("core_token", newCoreToken)
        return newCoreToken
      } else {
        throw new Error(`Failed to exchange token: ${response.statusText}`)
      }
    } catch (error) {
      console.error("Failed to exchange token, falling back to Supabase token:", error)
      setupAxiosAuth(providerToken)
      return null
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 300))
      setTokenReady(true)
    }
  }

  // --- WebView-Specific Helpers (only used if enableWebViewAuth is true) ---

  const extractTempTokenFromUrl = (url: string): string | null => {
    try {
      const parsedUrl = new URL(url)
      return parsedUrl.searchParams.get("aos_temp_token")
    } catch (e) {
      console.error("Error parsing URL for temp token:", e)
      return null
    }
  }

  const exchangeTempToken = async (tempToken: string): Promise<boolean> => {
    try {
      console.log("Exchanging temporary token...")
      const response = await axios.post(
        `${CORE_API_URL}/api/auth/exchange-store-token`,
        {aos_temp_token: tempToken, packageName: STORE_PACKAGE_NAME},
        {headers: {"Content-Type": "application/json"}},
      )

      const result = response.data

      if (result.success && result.tokens) {
        console.log("Successfully exchanged temporary token.")

        if (result.tokens.coreToken) {
          setupAxiosAuth(result.tokens.coreToken)
          setCoreToken(result.tokens.coreToken)
          localStorage.setItem("core_token", result.tokens.coreToken)
        }
        if (result.tokens.supabaseToken) {
          setProviderToken(result.tokens.supabaseToken)
          localStorage.setItem("supabase_token", result.tokens.supabaseToken)
        }

        setSession({
          token: result.tokens.supabaseToken || "temp-token-session",
        } as MentraAuthSession)
        setUser({id: result.userId || "webview-user"} as MentraAuthUser)
        setIsWebViewAuth(true)
        localStorage.setItem("is_webview", "true")
        setTokenReady(true)
        return true
      }
      return false
    } catch (error) {
      console.error("Failed to exchange temporary token:", error)
      return false
    }
  }

  // --- Auth Methods ---

  const refreshUser = async (): Promise<void> => {
    try {
      console.log("Refreshing user session...")
      const {data} = await mentraAuthProvider.getSession()
      setSession(data!.session)
      setUser(data!.session?.user || null)
    } catch (error) {
      console.error("Error refreshing user:", error)
    }
  }

  const signIn = async (email: string, password: string): Promise<MentraSigninResponse> => {
    try {
      console.log("Signing in with email/password")
      const {data, error} = await mentraAuthProvider.signInWithEmail(email, password)

      if (data && data.session?.token && !error) {
        console.log("Sign in successful, setting up tokens")
        setProviderToken(data.session.token)
        setSession(data.session)
        setUser(data.user)

        if (data.user?.email) {
          localStorage.setItem("userEmail", data.user.email)
        }

        await exchangeForCoreToken(data.session.token)
      }
      return {data, error}
    } catch (error) {
      console.error("Error during sign in:", error)
      return {data: null, error: {message: "Failed to sign in"}}
    }
  }

  const signUp = async (email: string, password: string, redirectPath: string): Promise<MentraSigninResponse> => {
    try {
      console.log("Signing up with email/password")
      const emailRedirectTo = `${window.location.origin}${redirectPath}`
      const {data, error} = await mentraAuthProvider.signUpWithEmail(email, password, emailRedirectTo)

      if (data && data.session?.token && !error) {
        console.log("Sign up successful, setting up tokens")
        setProviderToken(data.session.token)
        setSession(data.session)
        setUser(data.user)

        if (data.user?.email) {
          localStorage.setItem("userEmail", data.user.email)
        }

        await exchangeForCoreToken(data.session.token)
        if (redirectPath) {
          setTimeout(() => {
            console.log(`Redirecting to ${redirectPath} after successful sign up`)
            window.location.href = `${window.location.origin}${redirectPath}`
          }, 500)
        }
      } else if (!error) {
        console.log("Sign up successful, email confirmation may be required.")
      }

      return {data, error}
    } catch (error) {
      console.error("Error during sign up:", error)
      return {data: null, error: {message: "Failed to sign up"}}
    }
  }

  const signOut = async (): Promise<MentraSignOutResponse> => {
    console.log("Signing out user...")
    try {
      const {error} = await mentraAuthProvider.signOut()
      setupAxiosAuth(null)
      setProviderToken(null)
      setCoreToken(null)
      setUser(null)
      setSession(null)
      setIsWebViewAuth(false)
      setTokenReady(false)

      // Clear all related local storage items
      localStorage.removeItem("core_token")
      localStorage.removeItem("userEmail")

      // Conditionally clear WebView items
      if (enableWebViewAuth) {
        localStorage.removeItem("supabase_token")
        localStorage.removeItem("is_webview")
      }
      console.log("Sign out completed successfully.")
      return {error}
    } catch (error) {
      console.error("Error during sign out:", error)
      return {error: {message: "Failed to sign out"}}
    }
  }

  // --- Main useEffect for Initialization and Auth State Changes ---

  useEffect(() => {
    /**
     * Runs once on mount to initialize auth state.
     */
    const initializeAuth = async () => {
      setIsLoading(true)
      setTokenReady(false)
      try {
        // --- CONDITIONAL WebView Logic ---
        if (enableWebViewAuth) {
          // 1. Check for temporary token in URL
          const tempToken = extractTempTokenFromUrl(window.location.href)
          if (tempToken) {
            console.log("WebView token found in URL, attempting exchange...")
            const success = await exchangeTempToken(tempToken)
            if (success) {
              console.log("Successfully authenticated using temporary token.")
              return // Auth is complete
            }
            console.error("Failed to exchange temporary token.")
          }

          // 2. Check for saved WebView session
          const savedCoreToken = localStorage.getItem("core_token")
          const savedSupabaseToken = localStorage.getItem("supabase_token")
          const savedIsWebView = localStorage.getItem("is_webview") === "true"

          if (savedIsWebView && savedSupabaseToken && savedCoreToken) {
            console.log("Restoring saved WebView session.")
            setupAxiosAuth(savedCoreToken)
            setCoreToken(savedCoreToken)
            setProviderToken(savedSupabaseToken)
            setSession({token: savedSupabaseToken} as MentraAuthSession)
            setUser({id: "webview-user"} as MentraAuthUser)
            setIsWebViewAuth(true)
            setTokenReady(true)
            return // Auth is complete
          }
        }
        // --- END CONDITIONAL WebView Logic ---

        // 3. Check for saved core token (for web)
        const savedCoreToken = localStorage.getItem("core_token")

        // 4. Check for standard Supabase session
        console.log("Checking for standard Supabase session...")
        const {data} = await mentraAuthProvider.getSession()
        setSession(data?.session || null)
        setUser(data?.session?.user || null)

        if (data?.session?.token) {
          console.log("Found active Supabase session.")
          setProviderToken(data.session.token)
          if (savedCoreToken) {
            // Use saved core token with valid session
            console.log("Using saved core token with valid session.")
            setupAxiosAuth(savedCoreToken)
            setCoreToken(savedCoreToken)
            setTokenReady(true)
          } else {
            await exchangeForCoreToken(data.session.token)
          }
        } else {
          // No valid session - clear any stale core token
          if (savedCoreToken) {
            console.log("No valid session but found stale core token - clearing it.")
            localStorage.removeItem("core_token")
          }
          setTokenReady(true) // No session, but ready
        }
      } catch (error) {
        console.error("Error initializing auth:", error)
        setTokenReady(true)
      } finally {
        setIsLoading(false)
      }
    }

    initializeAuth()

    // --- CONDITIONAL WebView global functions ---
    if (enableWebViewAuth) {
      console.log("WebView auth enabled. Attaching global token handlers.")
      window.setSupabaseToken = (token: string) => {
        console.log("Supabase token received from WebView")
        setProviderToken(token)
        localStorage.setItem("supabase_token", token)

        exchangeForCoreToken(token).then(() => {
          setSession({token: token} as MentraAuthSession)
          setUser({id: "webview-user"} as MentraAuthUser)
          setIsWebViewAuth(true)
          localStorage.setItem("is_webview", "true")
        })
      }

      window.setCoreToken = (token: string) => {
        console.log("CoreToken received directly from WebView")
        setupAxiosAuth(token)
        setCoreToken(token)
        localStorage.setItem("core_token", token)

        const supabaseToken = localStorage.getItem("supabase_token")
        setSession({
          token: supabaseToken || "core-only-session",
        } as MentraAuthSession)
        setUser({id: "webview-user"} as MentraAuthUser)
        setIsWebViewAuth(true)
        localStorage.setItem("is_webview", "true")
        setTokenReady(true)
      }
    }

    // --- Auth State Change Listener ---
    const {data} = mentraAuthProvider.onAuthStateChange(async (event, session) => {
      // Optimization: Skip if user and token are the same
      const newUserId = session?.user?.id
      const newToken = session?.token
      const isUserChanged = prevUserIdRef.current !== newUserId
      const isTokenChanged = prevTokenRef.current !== newToken
      const isSignOut = event === "SIGNED_OUT"
      const isSignIn = event === "SIGNED_IN"

      if (!isUserChanged && !isTokenChanged && !isSignOut && !isSignIn && event !== "USER_UPDATED") {
        return
      }

      console.log("Auth state changed:", event)
      prevUserIdRef.current = newUserId
      prevTokenRef.current = newToken || null

      setSession(session)
      setUser(session?.user || null)

      if (session?.user?.email) {
        localStorage.setItem("userEmail", session.user.email)
      }

      if (isSignIn && session?.token) {
        setTokenReady(false)
        setProviderToken(session.token)
        await exchangeForCoreToken(session.token)

        const isLoginPage = window.location.pathname.includes("/login") || window.location.pathname.includes("/signin")
        if (isLoginPage) {
          const redirectTo = new URLSearchParams(window.location.search).get("redirectTo") || "/dashboard"
          console.log(`Redirecting to ${redirectTo} after auth state change`)
          window.location.href = window.location.origin + redirectTo
        }
      } else if (isSignOut) {
        // Full sign-out logic is in the signOut() function,
        // but we clear tokens here too as a safeguard.
        setupAxiosAuth(null)
        setProviderToken(null)
        setCoreToken(null)
        setIsWebViewAuth(false)
        setTokenReady(false)
        localStorage.removeItem("core_token")
        localStorage.removeItem("userEmail")
        if (enableWebViewAuth) {
          localStorage.removeItem("supabase_token")
          localStorage.removeItem("is_webview")
        }
      } else if (event === "USER_UPDATED" && session?.token && isTokenChanged) {
        console.log("Token refreshed, exchanging for new Core token...")
        setTokenReady(false)
        setProviderToken(session.token)
        await exchangeForCoreToken(session.token)
      } else {
        setTokenReady(true)
      }
    })

    // Clean up subscription on unmount
    return () => {
      data?.subscription.unsubscribe()
      // Conditionally clean up global functions
      if (enableWebViewAuth) {
        ;(window as any).setSupabaseToken = undefined
        ;(window as any).setCoreToken = undefined
      }
    }
  }, [enableWebViewAuth]) // Re-run if enableWebViewAuth changes (though it shouldn't)

  // --- Calculated State ---
  const isAuthenticated = isWebViewAuth || (!!user && !!session)

  // --- Provider Value ---
  const contextValue = useMemo(
    () => ({
      session,
      user,
      isLoading,
      isAuthenticated,
      supabaseToken: providerToken,
      coreToken,
      tokenReady,
      isWebViewAuth,
      signIn,
      signUp,
      signOut,
      refreshUser,
    }),
    [session, user, isLoading, isAuthenticated, providerToken, coreToken, tokenReady, isWebViewAuth],
  )

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>
}
