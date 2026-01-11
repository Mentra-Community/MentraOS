import * as Linking from "expo-linking"
import * as WebBrowser from "expo-web-browser"
import {FC, ReactNode, createContext, useContext, useEffect} from "react"
import {Platform} from "react-native"

// import {Linking} from "react-native"
// import {useAuth} from "@/contexts/AuthContext"
import {NavObject, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import mentraAuth from "@/utils/auth/authClient"
import {BackgroundTimer} from "@/utils/timers"

export interface DeepLinkRoute {
  pattern: string
  handler: (url: string, params: Record<string, string>, navObject: NavObject) => void | Promise<void>
  requiresAuth?: boolean
}

/**
 * Define all deep link routes for the app
 */
const deepLinkRoutes: DeepLinkRoute[] = [
  // Home routes
  {
    pattern: "/",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      // Don't navigate to home without authentication
      // Let the app's index route handle the navigation logic
      navObject.replace("/")
    },
    requiresAuth: false, // Let index.tsx handle auth checking
  },
  {
    pattern: "/home",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      navObject.replaceAll("/(tabs)/home")
    },
    requiresAuth: true, // Require auth for explicit /home navigation
  },

  // Settings routes
  {
    pattern: "/settings",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      navObject.push("/(tabs)/settings")
    },
    requiresAuth: true,
  },
  {
    pattern: "/settings/:section",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {section} = params

      // Map section names to actual routes
      const sectionRoutes: Record<string, string> = {
        "profile": "/settings/profile",
        "privacy": "/settings/privacy",
        "developer": "/settings/developer",
        "theme": "/settings/theme",
        "change-password": "/settings/change-password",
        "data-export": "/settings/data-export",
        "dashboard": "/settings/dashboard",
      }

      const route = sectionRoutes[section]
      if (route) {
        navObject.push(route as any)
      } else {
        navObject.push("/(tabs)/settings")
      }
    },
    requiresAuth: true,
  },

  // Glasses management routes
  {
    pattern: "/glasses",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      navObject.push("/(tabs)/glasses")
    },
    requiresAuth: true,
  },
  {
    pattern: "/asg/gallery",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      navObject.push("/asg/gallery")
    },
    requiresAuth: true,
  },

  // Pairing routes
  {
    pattern: "/pairing",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      navObject.push("/pairing/guide")
    },
    requiresAuth: true,
  },
  {
    pattern: "/pairing/:step",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {step} = params

      const pairingRoutes: Record<string, string> = {
        "guide": "/pairing/guide",
        "prep": "/pairing/prep",
        "bluetooth": "/pairing/bluetooth",
        "select-glasses": "/pairing/select-glasses-model",
        "wifi-setup": "/wifi/scan",
      }

      const route = pairingRoutes[step]
      if (route) {
        navObject.push(route as any)
      } else {
        navObject.push("/pairing/guide")
      }
    },
    requiresAuth: true,
  },

  // Store routes
  {
    pattern: "/store",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {packageName} = params
      navObject.replace(`/store?packageName=${packageName}`)
    },
    requiresAuth: true,
  },
  {
    pattern: "/package/:packageName",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {packageName, preloaded, authed} = params
      if (preloaded && authed) {
        // we've already loaded the app, so we can just navigate there directly
        navObject.replace(`/store?packageName=${packageName}`)
        return
      }
      // we probably need to login first:
      navObject.setPendingRoute(`/store?packageName=${packageName}`)
      navObject.replace(`/`)
    },
    requiresAuth: true,
  },

  // Authentication routes
  {
    pattern: "/auth/start",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      navObject.replaceAll("/auth/start")
    },
  },
  {
    pattern: "/auth/callback",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      console.log("[LOGIN DEBUG] params:", params)
      console.log("[LOGIN DEBUG] url:", url)

      const parseAuthParams = (url: string) => {
        const parts = url.split("#")
        if (parts.length < 2) return null
        const paramsString = parts[1]
        const params = new URLSearchParams(paramsString)
        return {
          access_token: params.get("access_token"),
          refresh_token: params.get("refresh_token"),
          token_type: params.get("token_type"),
          expires_in: params.get("expires_in"),
          type: params.get("type"), // signup, email_change, recovery, etc.
          // Error params (when link is expired/invalid)
          error: params.get("error"),
          error_code: params.get("error_code"),
          error_description: params.get("error_description"),
        }
      }

      const authParams = parseAuthParams(url)

      // Check if there's an error in the URL (e.g., expired verification link)
      if (authParams?.error || authParams?.error_code) {
        console.log("[LOGIN DEBUG] Error in auth callback:", authParams.error_code, authParams.error_description)
        // Navigate to login with the error code so login screen can show the message
        navObject.replace(`/auth/start?authError=${authParams.error_code || authParams.error}`)
        return
      }

      if (authParams && authParams.access_token && authParams.refresh_token) {
        // Update the Supabase session manually
        const res = await mentraAuth.updateSessionWithTokens({
          access_token: authParams.access_token,
          refresh_token: authParams.refresh_token,
        })
        if (res.is_error()) {
          console.error("Error setting session:", res.error)
          return
        }
        // console.log("Session updated:", data.session)
        // console.log("[LOGIN DEBUG] Session set successfully, data.session exists:", !!data.session)
        console.log("[LOGIN DEBUG] Session set successfully")
        // Dismiss the WebView after successful authentication (non-blocking)
        console.log("[LOGIN DEBUG] About to dismiss browser, platform:", Platform.OS)
        try {
          const dismissResult = WebBrowser.dismissBrowser()
          console.log("[LOGIN DEBUG] dismissBrowser returned:", dismissResult, "type:", typeof dismissResult)
          if (dismissResult && typeof dismissResult.catch === "function") {
            dismissResult.catch(() => {
              // Ignore errors - browser might not be open
            })
          }
        } catch (dismissError) {
          console.log("[LOGIN DEBUG] Error calling dismissBrowser:", dismissError)
          // Ignore - browser might not be open or function might not exist
        }

        // Small delay to ensure auth state propagates
        console.log("[LOGIN DEBUG] About to set timeout for navigation")
        BackgroundTimer.setTimeout(() => {
          console.log("[LOGIN DEBUG] Inside setTimeout, about to call router.replace('/')")
          try {
            navObject.replaceAll("/")
            console.log("[LOGIN DEBUG] router.replace called successfully")
          } catch (navError) {
            console.error("[LOGIN DEBUG] Error calling router.replace:", navError)
          }
        }, 100)
        console.log("[LOGIN DEBUG] setTimeout scheduled")
        return // Don't do the navigation below
      }

      // Check if this is an auth callback without tokens
      if (!authParams) {
        // Try checking if user is already authenticated
        const res = await mentraAuth.getSession()
        if (res.is_ok()) {
          const session = res.value
          if (session?.token) {
            navObject.replace("/")
          }
        }
      }
    },
  },
  {
    pattern: "/auth/reset-password",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      console.log("[RESET PASSWORD DEBUG] Handling reset password deep link")
      console.log("[RESET PASSWORD DEBUG] URL:", url)
      console.log("[RESET PASSWORD DEBUG] Params:", params)

      // Parse the auth parameters from the URL fragment
      const parseAuthParams = (url: string) => {
        const parts = url.split("#")
        if (parts.length < 2) return null
        const paramsString = parts[1]
        const urlParams = new URLSearchParams(paramsString)
        return {
          access_token: urlParams.get("access_token"),
          refresh_token: urlParams.get("refresh_token"),
          type: urlParams.get("type"),
          // Error params (when link is expired/invalid)
          error: urlParams.get("error"),
          error_code: urlParams.get("error_code"),
          error_description: urlParams.get("error_description"),
        }
      }

      const authParams = parseAuthParams(url)

      // Check if there's an error in the URL (e.g., expired link)
      if (authParams?.error || authParams?.error_code) {
        console.log("[RESET PASSWORD DEBUG] Error in reset link:", authParams.error_code, authParams.error_description)
        // Navigate to login with the error code so login screen can show the message
        navObject.replace(`/auth/start?authError=${authParams.error_code || authParams.error}`)
        return
      }

      if (authParams && authParams.access_token && authParams.refresh_token && authParams.type === "recovery") {
        // Set the recovery session
        const res = await mentraAuth.updateSessionWithTokens({
          access_token: authParams.access_token,
          refresh_token: authParams.refresh_token,
        })
        if (res.is_error()) {
          console.error("[RESET PASSWORD DEBUG] Error setting recovery session:", res.error)
          navObject.replace("/auth/start?authError=invalid_reset_link")
          return
        }

        console.log("[RESET PASSWORD DEBUG] Recovery session set successfully")
        // Navigate to the reset password screen
        navObject.replace("/auth/reset-password")
      } else {
        console.log("[RESET PASSWORD DEBUG] Missing required auth parameters for password reset")
        navObject.replace("/auth/start?authError=invalid_reset_link")
      }
    },
  },

  // Mirror/Gallery routes
  {
    pattern: "/mirror/gallery",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      navObject.push("/mirror/gallery")
    },
    requiresAuth: true,
  },
  {
    pattern: "/mirror/video/:videoId",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {videoId} = params
      navObject.push(`/mirror/video-player?videoId=${videoId}`)
    },
    requiresAuth: true,
  },

  // Search routes
  {
    pattern: "/search",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {q} = params
      const route = q ? `/search/search?q=${encodeURIComponent(q)}` : "/search/search"
      navObject.push(route as any)
    },
    requiresAuth: true,
  },

  // Onboarding routes
  {
    pattern: "/welcome",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      navObject.push("/welcome")
    },
  },
  {
    pattern: "/onboarding/welcome",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      navObject.push("/onboarding/welcome")
    },
  },

  // Universal app link routes (for apps.mentra.glass)
  {
    pattern: "/package/:packageName",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {packageName} = params
      navObject.push(`/(tabs)/store?packageName=${packageName}`)
    },
    requiresAuth: true,
  },
  {
    pattern: "/apps/:packageName",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {packageName} = params
      navObject.push(`/applet/webview?packageName=${packageName}`)
    },
    requiresAuth: true,
  },
  {
    pattern: "/apps/:packageName/settings",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {packageName} = params
      navObject.push(`/applet/settings?packageName=${packageName}`)
    },
    requiresAuth: true,
  },
]

interface DeeplinkContextType {
  processUrl: (url: string) => Promise<void>
}

const DeeplinkContext = createContext<DeeplinkContextType>({} as DeeplinkContextType)

export const useDeeplink = () => useContext(DeeplinkContext)

export const DeeplinkProvider: FC<{children: ReactNode}> = ({children}) => {
  const {push, replace, goBack, setPendingRoute, getPendingRoute, navigate, replaceAll, preventBack} =
    useNavigationHistory()
  const config = {
    scheme: "com.mentra",
    host: "apps.mentra.glass",
    routes: deepLinkRoutes,
    authCheckHandler: async () => {
      // TODO: this is a hack when we should really be using the auth context:
      const res = await mentraAuth.getSession()
      if (res.is_error()) {
        return false
      }
      const session = res.value
      if (!session?.token) {
        return false
      }
      return true
    },
    fallbackHandler: (url: string) => {
      console.warn("Fallback handler called for URL:", url)
      setTimeout(() => {
        replaceAll("/auth/start")
      }, 100)
    },
    navObject: {push, replace, goBack, setPendingRoute, getPendingRoute, navigate, replaceAll, preventBack},
  }

  const handleUrlRaw = async ({url}: {url: string}) => {
    processUrl(url, false)
  }

  useEffect(() => {
    Linking.addEventListener("url", handleUrlRaw)
    Linking.getInitialURL().then(url => {
      console.log("@@@@@@@@@@@@@ INITIAL URL @@@@@@@@@@@@@@@", url)
      if (url) {
        processUrl(url, true)
      }
    })
  }, [])

  /**
   * Find matching route for the given URL
   */
  const findMatchingRoute = (url: URL): DeepLinkRoute | null => {
    let pathname = url.pathname
    const host = url.host
    if (host === "auth") {
      pathname = `/auth${pathname}`
    }

    for (const route of config.routes) {
      if (matchesPattern(pathname, route.pattern)) {
        return route
      }
    }

    return null
  }

  /**
   * Check if pathname matches the route pattern
   */
  const matchesPattern = (pathname: string, pattern: string): boolean => {
    // Convert pattern to regex
    // /user/:id -> /user/([^/]+)
    const regexPattern = pattern.replace(/:[^/]+/g, "([^/]+)").replace(/\*/g, ".*")

    const regex = new RegExp(`^${regexPattern}$`)
    return regex.test(pathname)
  }

  const extractParams = (url: URL, pattern: string): Record<string, string> => {
    const params: Record<string, string> = {}

    // Extract path parameters
    const pathParts = url.pathname.split("/").filter(Boolean)
    const patternParts = pattern.split("/").filter(Boolean)

    for (let i = 0; i < patternParts.length; i++) {
      const patternPart = patternParts[i]
      const pathPart = pathParts[i]

      if (patternPart.startsWith(":")) {
        const paramName = patternPart.slice(1)
        params[paramName] = pathPart || ""
      }
    }

    // Extract query parameters
    url.searchParams.forEach((value, key) => {
      params[key] = value
    })

    return params
  }

  const processUrl = async (url: string, initial: boolean = false) => {
    try {
      // Add delay to ensure Root Layout is mounted
      if (initial) {
        await new Promise(resolve => setTimeout(resolve, 1000))
      }

      console.log("[LOGIN DEBUG] Deep link received:", url)

      // small hack since some sources strip the host and we want to put the url into URL object here
      if (url.startsWith("/")) {
        url = "https://apps.mentra.glass" + url
      }

      const parsedUrl = new URL(url)
      const matchedRoute = findMatchingRoute(parsedUrl)

      if (!matchedRoute) {
        console.warn("No matching route found for URL:", url)
        config.fallbackHandler?.(url)
        return
      }

      const authed = await config.authCheckHandler()

      // Check authentication if required
      if (matchedRoute.requiresAuth && !authed) {
        console.warn("Authentication required for route:", matchedRoute.pattern)
        // Store the URL for after authentication
        setPendingRoute(url)
        setTimeout(() => {
          try {
            replace("/auth/start")
          } catch (error) {
            console.warn("Navigation failed, router may not be ready:", error)
          }
        }, 100)
      }

      // Extract parameters from URL
      const params = extractParams(parsedUrl, matchedRoute.pattern)
      if (authed) {
        params.authed = "true"
      }
      if (!initial) {
        params.preloaded = "true"
      }

      try {
        console.log("@@@@@@@@@@@@@ MATCHED ROUTE @@@@@@@@@@@@@@@", matchedRoute)
        console.log("@@@@@@@@@@@@@ PARAMS @@@@@@@@@@@@@@@", params)
        console.log("@@@@@@@@@@@@@ URL @@@@@@@@@@@@@@@", url)
        const navObject: NavObject = {
          push,
          replace,
          goBack,
          setPendingRoute,
          getPendingRoute,
          navigate,
          replaceAll,
        }
        await matchedRoute.handler(url, params, navObject)
      } catch (error) {
        console.warn("Route handler failed, router may not be ready:", error)
      }
    } catch (error) {
      console.error("Error handling deep link:", error)
      config.fallbackHandler?.(url)
    }
  }

  const contextValue: DeeplinkContextType = {
    processUrl,
  }

  return <DeeplinkContext.Provider value={contextValue}>{children}</DeeplinkContext.Provider>
}
