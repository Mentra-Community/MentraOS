import {router} from "expo-router"
import {supabase} from "@/supabase/supabaseClient"
import {NavigationHistoryPush, NavigationHistoryReplace, NavObject} from "@/contexts/NavigationHistoryContext"
import {Platform} from "react-native"
import * as WebBrowser from "expo-web-browser"

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
      navObject.replace("/(tabs)/home")
    },
  },
  {
    pattern: "/home",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      navObject.replace("/(tabs)/home")
    },
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
        router.push(route as any)
      } else {
        router.push("/(tabs)/settings")
      }
    },
    requiresAuth: true,
  },

  // Glasses management routes
  {
    pattern: "/glasses",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      router.push("/(tabs)/glasses")
    },
    requiresAuth: true,
  },

  // Pairing routes
  {
    pattern: "/pairing",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      router.push("/pairing/guide")
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
      navObject.push("/(tabs)/store")
    },
    requiresAuth: true,
  },
  {
    pattern: "/package/:packageName",
    handler: (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {packageName} = params
      // Navigate to app details or app webview
      navObject.push(`/store?packageName=${packageName}`)
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

      // // Handle OAuth callback with any query parameters
      // const queryString = Object.entries(params)
      //   .filter(([key]) => key !== 'path') // Remove path param
      //   .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      //   .join('&')

      // const route = queryString ? `/auth/callback?${queryString}` : '/auth/callback'
      // router.replace(route as any)

      // const authParams = parseAuthParams(event.url)

      if (authParams && authParams.access_token && authParams.refresh_token) {
        try {
          // Update the Supabase session manually
          const {data, error} = await supabase.auth.setSession({
            access_token: authParams.access_token,
            refresh_token: authParams.refresh_token,
          })
          if (error) {
            console.error("Error setting session:", error)
          } else {
            console.log("Session updated:", data.session)
            console.log("[LOGIN DEBUG] Session set successfully, data.session exists:", !!data.session)
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
                router.replace("/")
                console.log("[LOGIN DEBUG] router.replace called successfully")
              } catch (navError) {
                console.error("[LOGIN DEBUG] Error calling router.replace:", navError)
              }
            }, 100)
            console.log("[LOGIN DEBUG] setTimeout scheduled")
            return // Don't do the navigation below
          }
        } catch (err) {
          console.error("Exception during setSession:", err)
          console.error("[LOGIN DEBUG] setSession error details:", {
            name: err.name,
            message: err.message,
            stack: err.stack,
          })
        }
      }

      // Check if this is an auth callback without tokens
      if (!authParams) {
        // Try checking if user is already authenticated
        const {
          data: {session},
        } = await supabase.auth.getSession()
        if (session) {
          navObject.replace("/")
        }
      }
    },
  },

  // Mirror/Gallery routes
  {
    pattern: "/mirror/gallery",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      router.push("/mirror/gallery")
    },
    requiresAuth: true,
  },
  {
    pattern: "/mirror/video/:videoId",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {videoId} = params
      router.push(`/mirror/video-player?videoId=${videoId}`)
    },
    requiresAuth: true,
  },

  // Search routes
  {
    pattern: "/search",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {q} = params
      const route = q ? `/search/search?q=${encodeURIComponent(q)}` : "/search/search"
      router.push(route as any)
    },
    requiresAuth: true,
  },

  // Permissions routes
  {
    pattern: "/permissions/grant",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      router.push("/permissions/grant")
    },
    requiresAuth: true,
  },

  // Onboarding routes
  {
    pattern: "/welcome",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      router.push("/welcome")
    },
  },
  {
    pattern: "/onboarding/welcome",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      router.push("/onboarding/welcome")
    },
  },

  // Universal app link routes (for apps.mentra.glass)
  {
    pattern: "/package/:packageName",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {packageName} = params
      router.push(`/(tabs)/store?packageName=${packageName}`)
    },
    requiresAuth: true,
  },
  {
    pattern: "/apps/:packageName",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {packageName} = params
      router.push(`/app/webview?packageName=${packageName}`)
    },
    requiresAuth: true,
  },
  {
    pattern: "/apps/:packageName/settings",
    handler: async (url: string, params: Record<string, string>, navObject: NavObject) => {
      const {packageName} = params
      router.push(`/app/settings?packageName=${packageName}`)
    },
    requiresAuth: true,
  },
]
