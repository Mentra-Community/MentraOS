import React, {createContext, useContext, useEffect, useRef, useState} from "react"
import {Linking} from "react-native"
import {useRouter} from "expo-router"
import {useAuth} from "@/contexts/AuthContext"
import {deepLinkRoutes} from "@/utils/deepLinkRoutes"
import {NavObject, useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {supabase} from "@/supabase/supabaseClient"

interface DeeplinkContextType {}

export interface DeepLinkRoute {
  pattern: string
  handler: (url: string, params: Record<string, string>, navObject: NavObject) => void | Promise<void>
  requiresAuth?: boolean
}

export interface DeepLinkConfig {
  scheme: string
  host?: string
  routes: DeepLinkRoute[]
  fallbackHandler: (url: string) => void
  authCheckHandler: () => Promise<boolean>
  navObject: NavObject
}

const DeeplinkContext = createContext<DeeplinkContextType>({})

export const useDeeplink = () => useContext(DeeplinkContext)

export const DeeplinkProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const router = useRouter()
  const {user} = useAuth()
  const {push, replace, goBack} = useNavigationHistory()
  const pendingDeeplink = useRef<string | null>(null)
  const isInitialized = useRef(false)

  const config = {
    scheme: "com.mentra",
    host: "apps.mentra.glass",
    routes: deepLinkRoutes,
    authCheckHandler: async () => {
      // TODO: this is a hack when we should really be using the auth context:
      const session = await supabase.auth.getSession()
      if (session.data.session == null) {
        return false
      }
      return true
    },
    fallbackHandler: (url: string) => {
      console.warn("Fallback handler called for URL:", url)
      setTimeout(() => {
        push("/auth/login")
      }, 100)
    },
    navObject: {push, replace, goBack},
  }

  const handleUrlRaw = async ({url}: {url: string}) => {
    if (isInitialized.current) {
      processUrl(url)
    } else {
      // Store for later if handler not ready
      pendingDeeplink.current = url
    }
  }

  const initializeHandler = () => {
    if (isInitialized.current) return

    try {
      const subscription = Linking.addEventListener("url", handleUrlRaw)
      isInitialized.current = true

      // return cleanup function
      return () => {
        subscription?.remove()
      }
    } catch (error) {
      console.error("Error initializing deep link handler:", error)
    }
    return () => {}
  }

  /**
   * Find matching route for the given URL
   */
  const findMatchingRoute = (url: URL): DeepLinkRoute | null => {
    let pathname = url.pathname
    let host = url.host
    if (host === "auth") {
      pathname = `/auth${pathname}`
    }

    console.log("pathname", pathname)
    console.log("config", config)

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

  const processUrl = async (url: string) => {
    try {
      console.log("[LOGIN DEBUG] Deep link received:", url)

      // if (!this.isValidUrl(url)) {
      //   console.warn('Invalid deep link URL:', url)
      //   this.config.fallbackHandler?.(url)
      //   return
      // }

      const parsedUrl = new URL(url)
      const matchedRoute = findMatchingRoute(parsedUrl)

      if (!matchedRoute) {
        console.warn("No matching route found for URL:", url)
        config.fallbackHandler?.(url)
        return
      }

      // Check authentication if required
      if (matchedRoute.requiresAuth && !(await config.authCheckHandler())) {
        console.warn("Authentication required for route:", matchedRoute.pattern)
        // Store the URL for after authentication
        pendingDeeplink.current = url
        setTimeout(() => {
          replace("/auth/login")
        }, 100)
        return
      }

      // Extract parameters from URL
      const params = extractParams(parsedUrl, matchedRoute.pattern)

      // Execute the route handler
      matchedRoute.handler(url, params, {push, replace, goBack})
    } catch (error) {
      console.error("Error handling deep link:", error)
      config.fallbackHandler?.(url)
    }
  }

  useEffect(() => {
    initializeHandler()
  }, [user])

  // Handle pending deeplink after authentication
  useEffect(() => {
    if (user && pendingDeeplink.current) {
      const url = pendingDeeplink.current
      pendingDeeplink.current = null
      // Re-process the pending deeplink now that user is authenticated
      setTimeout(() => processUrl(url), 1000)
    }
  }, [user])

  const contextValue: DeeplinkContextType = {}

  return <DeeplinkContext.Provider value={contextValue}>{children}</DeeplinkContext.Provider>
}
