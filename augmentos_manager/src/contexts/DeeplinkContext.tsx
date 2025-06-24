import React, {createContext, useContext, useEffect, useRef} from "react"
import {Linking} from "react-native"
import {useRouter} from "expo-router"
import {useAuth} from "./AuthContext"

interface DeeplinkContextType {}

const DeeplinkContext = createContext<DeeplinkContextType>({})

export const useDeeplink = () => useContext(DeeplinkContext)

export const DeeplinkProvider: React.FC<{children: React.ReactNode}> = ({children}) => {
  const router = useRouter()
  const {isAuthenticated} = useAuth()
  const pendingDeeplink = useRef<string | null>(null)

  const handleUrl = (url: string) => {
      try {
        const urlObj = new URL(url)
        
        // Handle auth callbacks (existing functionality)
        if (url.includes("auth/callback")) {
          // Let the login page handle this
          return
        }

        // Handle app store deeplinks
        if (urlObj.hostname === "apps.mentra.glass") {
          // Store the deeplink for after authentication
          pendingDeeplink.current = url
          
          // If not authenticated, go to login first
          if (!isAuthenticated) {
            router.push("/auth/login")
            return
          }
          
          const pathParts = urlObj.pathname.split("/").filter(Boolean)
          
          // Check if it's an app detail page: /package/[packageName]
          if (pathParts[0] === "package" && pathParts[1]) {
            const packageName = pathParts[1]
            // Navigate to store tab with the packageName parameter
            router.push({
              pathname: "/(tabs)/store",
              params: {packageName}
            })
          } else {
            // Just open the store tab for other app store URLs
            router.push("/(tabs)/store")
          }
          
          // Clear the pending deeplink
          pendingDeeplink.current = null
        }
      } catch (error) {
        console.error("Error handling deeplink:", error)
      }
    }

  useEffect(() => {
    // Handle deeplinks when app is already open
    const handleDeepLink = (event: {url: string}) => {
      handleUrl(event.url)
    }

    // Handle initial URL when app launches from a deeplink
    const handleInitialURL = async () => {
      const initialUrl = await Linking.getInitialURL()
      if (initialUrl) {
        handleUrl(initialUrl)
      }
    }

    // Subscribe to URL events
    const subscription = Linking.addEventListener("url", handleDeepLink)

    // Check for initial URL
    handleInitialURL()

    return () => {
      subscription.remove()
    }
  }, [router, isAuthenticated])

  // Handle pending deeplink after authentication
  useEffect(() => {
    if (isAuthenticated && pendingDeeplink.current) {
      const url = pendingDeeplink.current
      pendingDeeplink.current = null
      // Re-process the pending deeplink now that user is authenticated
      setTimeout(() => handleUrl(url), 100)
    }
  }, [isAuthenticated])

  return <DeeplinkContext.Provider value={{}}>{children}</DeeplinkContext.Provider>
}