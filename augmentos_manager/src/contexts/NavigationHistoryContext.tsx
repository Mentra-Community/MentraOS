import React, {createContext, useCallback, useContext, useEffect, useRef} from "react"
import {useFocusEffect, usePathname, useSegments} from "expo-router"
import {router} from "expo-router"
import {BackHandler} from "react-native"

export type NavigationHistoryPush = (path: string, params?: any) => Promise<void>
export type NavigationHistoryReplace = (path: string, params?: any) => Promise<void>
export type NavigationHistoryGoBack = () => void

export type NavObject = {
  push: NavigationHistoryPush
  replace: NavigationHistoryReplace
  goBack: NavigationHistoryGoBack
}

interface NavigationHistoryContextType {
  goBack: () => void
  getHistory: () => string[]
  clearHistory: () => void
  push: (path: string, params?: any) => Promise<void>
  replace: (path: string, params?: any) => Promise<void>
}

const NavigationHistoryContext = createContext<NavigationHistoryContextType | undefined>(undefined)

export function NavigationHistoryProvider({children}: {children: React.ReactNode}) {
  const historyRef = useRef<string[]>([])
  const pathname = usePathname()
  const segments = useSegments()

  useEffect(() => {
    // Add current path to history if it's different from the last entry
    const lastPath = historyRef.current[historyRef.current.length - 1]
    if (pathname !== lastPath) {
      historyRef.current.push(pathname)

      // Keep history limited to prevent memory issues (keep last 20 entries)
      if (historyRef.current.length > 20) {
        historyRef.current = historyRef.current.slice(-20)
      }
    }
  }, [pathname])

  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        // Skip for app settings and webview - they handle their own back navigation
        if (pathname === '/app/settings' || pathname === '/app/webview') {
          return false  // Let the screen's handler execute
        }
        
        if (segments.length > 0 && segments[0] != "(tabs)") {
          goBack()
        }
        return true
      }

      BackHandler.addEventListener("hardwareBackPress", onBackPress)

      return () => BackHandler.removeEventListener("hardwareBackPress", onBackPress)
    }, [pathname, segments]),
  )

  const goBack = () => {
    const history = historyRef.current

    // Remove current path
    history.pop()

    // Get previous path
    const previousPath = history[history.length - 1]

    if (previousPath) {
      // Fallback to direct navigation if router.back() fails
      router.replace(previousPath as any)
    } else if (router.canGoBack()) {
      router.back()
    } else {
      // Ultimate fallback to home tab
      router.replace("/(tabs)/home")
    }
  }

  const push = (path: string, params?: any): Promise<void> => {
    // if the path is the same as the last path, don't add it to the history
    if (historyRef.current[historyRef.current.length - 1] === path) {
      return Promise.resolve()
    }

    historyRef.current.push(path)

    router.push({pathname: path as any, params: params as any})
    return Promise.resolve()
  }

  const replace = (path: string, params?: any): Promise<void> => {
    historyRef.current.pop()
    historyRef.current.push(path)
    const result = router.replace({pathname: path as any, params: params as any})
    return result || Promise.resolve()
  }

  const getHistory = () => {
    return [...historyRef.current]
  }

  const clearHistory = () => {
    historyRef.current = []
  }

  return (
    <NavigationHistoryContext.Provider value={{goBack, getHistory, clearHistory, push, replace}}>
      {children}
    </NavigationHistoryContext.Provider>
  )
}

export function useNavigationHistory() {
  const context = useContext(NavigationHistoryContext)
  if (context === undefined) {
    throw new Error("useNavigationHistory must be used within a NavigationHistoryProvider")
  }
  return context
}
