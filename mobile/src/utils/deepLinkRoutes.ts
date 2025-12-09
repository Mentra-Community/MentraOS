import * as WebBrowser from "expo-web-browser"
import {Platform} from "react-native"

import {NavObject} from "@/contexts/NavigationHistoryContext"

import mentraAuth from "./auth/authClient"

export interface DeepLinkRoute {
  pattern: string
  handler: (url: string, params: Record<string, string>, navObject: NavObject) => void | Promise<void>
  requiresAuth?: boolean
}

/**
 * Define all deep link routes for the app
 */
export const deepLinkRoutes: DeepLinkRoute[] = [
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
      navObject.replace("/(tabs)/home")
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
        "wifi-setup": "/pairing/glasseswifisetup",
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
    pattern: "/auth/login",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      navObject.replace("/auth/login")
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
          // Add any other parameters you might need
        }
      }

      const authParams = parseAuthParams(url)

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
        setTimeout(() => {
          console.log("[LOGIN DEBUG] Inside setTimeout, about to call router.replace('/')")
          try {
            navObject.replace("/")
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
        const params = new URLSearchParams(paramsString)
        return {
          access_token: params.get("access_token"),
          refresh_token: params.get("refresh_token"),
          type: params.get("type"),
          // Add any other parameters that might be in the reset link
        }
      }

      const authParams = parseAuthParams(url)

      if (authParams && authParams.access_token && authParams.refresh_token && authParams.type === "recovery") {
        // Set the recovery session
        const res = await mentraAuth.updateSessionWithTokens({
          access_token: authParams.access_token,
          refresh_token: authParams.refresh_token,
        })
        if (res.is_error()) {
          console.error("[RESET PASSWORD DEBUG] Error setting recovery session:", res.error)
          navObject.replace("/auth/login")
          return
        }

        console.log("[RESET PASSWORD DEBUG] Recovery session set successfully")
        // Navigate to the reset password screen
        navObject.replace("/auth/reset-password")
      } else {
        console.log("[RESET PASSWORD DEBUG] Missing required auth parameters for password reset")
        navObject.replace("/auth/login")
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
