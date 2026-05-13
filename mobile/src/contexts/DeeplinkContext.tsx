import * as Linking from "expo-linking"
import * as WebBrowser from "expo-web-browser"
import {FC, ReactNode, createContext, useContext, useEffect} from "react"
import {AppState, Platform} from "react-native"

import {useSplashLoader} from "@/contexts/SplashLoaderProvider"
import miniappCatalog from "@/services/miniapps/MiniappCatalog"
import {useAppStatusStore} from "@mentra/island"
import mentraAuth from "@/utils/auth/authClient"
import {BgTimer} from "@mentra/island"
import { useNavigationStore } from "@/stores/navigation"

/** Returns immediately if the app is already active, otherwise waits for it. */
const waitForActive = (): Promise<void> => {
  if (AppState.currentState === "active") return Promise.resolve()
  return new Promise((resolve) => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        sub.remove()
        resolve()
      }
    })
  })
}

export interface DeepLinkRoute {
  pattern: string
  handler: (url: string, params: Record<string, string>) => void | Promise<void>
  requiresAuth?: boolean
}

/**
 * Define all deep link routes for the app
 */
const deepLinkRoutes: DeepLinkRoute[] = [
  // Home routes
  {
    pattern: "/",
    handler: (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      // Don't navigate to home without authentication
      // Let the app's index route handle the navigation logic
      nav.replace("/")
    },
    requiresAuth: false, // Let index.tsx handle auth checking
  },
  {
    pattern: "/home",
    handler: (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      nav.replaceAll("/home")
    },
    requiresAuth: true, // Require auth for explicit /home navigation
  },

  // Settings routes
  {
    pattern: "/settings",
    handler: (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      nav.push("/miniapps/settings")
    },
    requiresAuth: true,
  },
  {
    pattern: "/miniapps/settings/:section",
    handler: (url: string, params: Record<string, string>) => {
      const {section} = params
      const nav = useNavigationStore.getState()
      // Map section names to actual routes
      const sectionRoutes: Record<string, string> = {
        "profile": "/miniapps/settings/profile",
        "privacy": "/miniapps/settings/privacy",
        "developer": "/miniapps/settings/developer",
        "theme": "/miniapps/settings/theme",
        "change-password": "/miniapps/settings/change-password",
        "data-export": "/miniapps/settings/data-export",
        "dashboard": "/miniapps/settings/dashboard",
        // Test/benchmark route — only useful behind Super Mode.
        "stress-test": "/miniapps/settings/stress-test",
      }

      const route = sectionRoutes[section]
      if (route) {
        // Pass through query params — stress-test uses them
        const qsKeys = ["mb", "n", "autorun", "url", "jsc"]
        const qs = qsKeys
          .filter((k) => params[k] != null)
          .map((k) => `${k}=${encodeURIComponent(params[k])}`)
          .join("&")
        const fullRoute = qs ? `${route}?${qs}` : route
        nav.push(fullRoute as any)
      } else {
        nav.push("/settings")
      }
    },
    requiresAuth: true,
  },

  // Glasses management routes
  {
    pattern: "/glasses",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      nav.push("/glasses")
    },
    requiresAuth: true,
  },
  {
    pattern: "/asg/gallery",
    handler: (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      nav.push("/asg/gallery")
    },
    requiresAuth: true,
  },

  // Pairing routes
  {
    pattern: "/pairing",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      nav.push("/pairing/guide")
    },
    requiresAuth: true,
  },
  {
    pattern: "/pairing/:step",
    handler: (url: string, params: Record<string, string>) => {
      const {step} = params
      const nav = useNavigationStore.getState()

      const pairingRoutes: Record<string, string> = {
        "guide": "/pairing/guide",
        "prep": "/pairing/prep",
        "bluetooth": "/pairing/bluetooth",
        "select-glasses": "/pairing/select-glasses-model",
        "wifi-setup": "/wifi/scan",
      }

      const route = pairingRoutes[step]
      if (route) {
        nav.push(route as any)
      } else {
        nav.push("/pairing/guide")
      }
    },
    requiresAuth: true,
  },

  // Smart start: activates the app if installed, otherwise shows the store page
  {
    pattern: "/package/:packageName/start",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      const {packageName, preloaded, authed} = params
      if (preloaded && authed) {
        // Deep links can fire while the app is still in the background state.
        // Navigation calls made before the app is active get lost, so wait first.
        await waitForActive()
        // Reset stack to home, then push store on top so back always goes home.
        useNavigationStore.getState().replaceAll("/home")
        await miniappCatalog.refresh()
        const applet = useAppStatusStore.getState().apps.find((app) => app.packageName === packageName)
        console.log("[DEEPLINK] Smart start for package:", packageName, "applet found:", !!applet)
        if (applet) {
          setTimeout(() => useAppStatusStore.getState().start(applet), 150)
          return
        } else {
          setTimeout(() => nav.push("/miniapps/store/store", {packageName}), 150)
          return
        }
      }
      // Cold start or not authenticated — store raw URL so processUrl re-matches it after init
      nav.setPendingRoute(url)
      nav.replace(`/`)
    },
    requiresAuth: true,
  },

  // Store routes
  {
    pattern: "/store",
    handler: (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      const {packageName} = params
      nav.replace(`/store?packageName=${packageName}`)
    },
    requiresAuth: true,
  },
  {
    pattern: "/package/:packageName",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      const {packageName, preloaded, authed} = params
      if (preloaded && authed) {
        // Deep links can fire while the app is still in the background state.
        // Navigation calls made before the app is active get lost, so wait first.
        await waitForActive()
        // Reset stack to home, then push store on top so back always goes home.
        nav.replaceAll("/home")
        setTimeout(() => nav.push("/miniapps/store/store", {packageName}), 150)
        return
      }
      // Cold start or not authenticated — store raw URL so processUrl re-matches it after init
      nav.setPendingRoute(url)
      nav.replace(`/`)
    },
    requiresAuth: true,
  },

  // Authentication routes
  {
    pattern: "/auth/start",
    handler: (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      nav.replaceAll("/auth/start")
    },
  },
  {
    pattern: "/auth/callback",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      // console.log("[LOGIN DEBUG] params:", params)
      // console.log("[LOGIN DEBUG] url:", url)

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
        nav.replace(`/auth/start?authError=${authParams.error_code || authParams.error}`)
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
        // Use replace() instead of replaceAll() to avoid POP_TO_TOP errors
        // when the navigation stack is empty (coming back from browser)
        console.log("[LOGIN DEBUG] About to set timeout for navigation")
        BgTimer.setTimeout(() => {
          console.log("[LOGIN DEBUG] Inside setTimeout, navigating to index")
          try {
            nav.setAnimation("none")
            nav.replaceAll("/")
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
            nav.replace("/")
          }
        }
      }
    },
  },
  {
    pattern: "/auth/reset-password",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
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
        nav.replace(`/auth/start?authError=${authParams.error_code || authParams.error}`)
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
          nav.replace("/auth/start?authError=invalid_reset_link")
          return
        }

        console.log("[RESET PASSWORD DEBUG] Recovery session set successfully")
        // Navigate to the reset password screen
        nav.replace("/auth/reset-password")
      } else {
        console.log("[RESET PASSWORD DEBUG] Missing required auth parameters for password reset")
        nav.replace("/auth/start?authError=invalid_reset_link")
      }
    },
  },

  // Mirror/Gallery routes
  {
    pattern: "/mirror/gallery",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      nav.push("/mirror/gallery")
    },
    requiresAuth: true,
  },
  {
    pattern: "/mirror/video/:videoId",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      const {videoId} = params
      nav.push(`/mirror/video-player?videoId=${videoId}`)
    },
    requiresAuth: true,
  },

  // Search routes
  {
    pattern: "/search",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      const {q} = params
      const route = q ? `/search/search?q=${encodeURIComponent(q)}` : "/search/search"
      nav.push(route as any)
    },
    requiresAuth: true,
  },

  // Onboarding routes
  {
    pattern: "/welcome",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      nav.push("/welcome")
    },
  },
  {
    pattern: "/onboarding/welcome",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      nav.push("/onboarding/welcome")
    },
  },

  // Universal app link routes (for apps.mentra.glass)
  {
    pattern: "/apps/:packageName",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      const {packageName} = params
      nav.push(`/applet/webview?packageName=${packageName}`)
    },
    requiresAuth: true,
  },
  {
    pattern: "/apps/:packageName/settings",
    handler: async (url: string, params: Record<string, string>) => {
      const nav = useNavigationStore.getState()
      const {packageName} = params
      nav.push(`/applet/settings?packageName=${packageName}`)
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

  const {setSplashEnabled} = useSplashLoader()
  const nav = useNavigationStore.getState()
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
        nav.replaceAll("/auth/start")
      }, 100)
    },
  }

  const handleUrlRaw = async ({url}: {url: string}) => {
    processUrl(url, false)
  }

  useEffect(() => {
    Linking.addEventListener("url", handleUrlRaw)
    Linking.getInitialURL().then((url) => {
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

  let lastProcessedUrl: string | null = null
  let lastProcessedTime = 0

  const processUrl = async (url: string, initial: boolean = false) => {
    try {
      // ignore expo-dev-deeplinks: (this was causing android to restart the app after hot-reloads twice)
      if (url.includes("expo-development-client")) {
        console.log("DEEPLINK: Ignoring expo-development-client URL")
        return
      }

      // Deduplicate — iOS can fire the same universal link event multiple times,
      // and on cold start both getInitialURL and addEventListener fire for the
      // same URL. Initial calls skip the check but claim the URL so that the
      // duplicate addEventListener call is blocked. The index.tsx re-processing
      // call happens >2s later (1s initial delay + init time + 1s DEEPLINK_DELAY)
      // so it naturally falls outside the dedup window.
      const now = Date.now()
      if (!initial && url === lastProcessedUrl && now - lastProcessedTime < 3000) {
        console.log("DEEPLINK: Ignoring duplicate URL")
        return
      }
      lastProcessedUrl = url
      lastProcessedTime = now

      // For initial URLs (cold start), set the pending route BEFORE the delay.
      // This prevents a race condition where index.tsx init completes during the
      // delay and calls navigateToDestination() before the pending route is set,
      // causing it to navigate to /home instead of the deep link target.
      if (initial) {
        nav.setPendingRoute(url)
        await new Promise((resolve) => setTimeout(resolve, 1000))
        // If index.tsx already consumed and re-processed the pending route
        // during the delay, don't double-process it
        if (nav.getPendingRoute() !== url) {
          console.log("DEEPLINK: Pending route was consumed during delay, skipping")
          return
        }
      }

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
        nav.setPendingRoute(url)
        setTimeout(() => {
          try {
            nav.replace("/auth/start")
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
        setSplashEnabled(true)
        BgTimer.setTimeout(async () => {
          await matchedRoute.handler(url, params)
          BgTimer.setTimeout(() => {
            setSplashEnabled(false)
          }, 2500)
        }, 100)
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
