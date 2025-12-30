import {router, usePathname, useSegments} from "expo-router"
import {createContext, useContext, useEffect, useRef} from "react"

import {navigationRef} from "@/contexts/NavigationRef"

export type NavigationHistoryPush = (path: string, params?: any) => void
export type NavigationHistoryReplace = (path: string, params?: any) => void
export type NavigationHistoryGoBack = () => void

export type NavObject = {
  push: NavigationHistoryPush
  replace: NavigationHistoryReplace
  goBack: NavigationHistoryGoBack
  setPendingRoute: (route: string) => void
  getPendingRoute: () => string | null
  navigate: (path: string, params?: any) => void
}

interface NavigationHistoryContextType {
  goBack: () => void
  getHistory: () => string[]
  clearHistory: () => void
  push: (path: string, params?: any) => void
  replace: (path: string, params?: any) => void
  setPendingRoute: (route: string | null) => void
  getPendingRoute: () => string | null
  navigate: (path: string, params?: any) => void
  clearHistoryAndGoHome: () => void
  replaceAll: (path: string, params?: any) => void
  goHomeAndPush: (path: string, params?: any) => void
}

const NavigationHistoryContext = createContext<NavigationHistoryContextType | undefined>(undefined)

export function NavigationHistoryProvider({children}: {children: React.ReactNode}) {
  const historyRef = useRef<string[]>([])
  const historyParamsRef = useRef<any[]>([])

  const pathname = usePathname()
  const _segments = useSegments()
  // const [pendingRoute, setPendingRouteNonClashingName] = useState<string | null>(null)
  const pendingRoute = useRef<string | null>(null)

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

  // useFocusEffect(
  //   useCallback(() => {
  //     const onBackPress = () => {
  //       // Skip for app settings and webview - they handle their own back navigation
  //       if (pathname === "/applet/settings" || pathname === "/applet/webview") {
  //         return false // Let the screen's handler execute
  //       }

  //       if (segments.length > 0 && segments[0] != "(tabs)") {
  //         goBack()
  //       }
  //       return true
  //     }

  //     BackHandler.addEventListener("hardwareBackPress", onBackPress)

  //     return () => BackHandler.removeEventListener("hardwareBackPress", onBackPress)
  //   }, [pathname, segments]),
  // )

  const goBack = () => {
    console.info("NavHistory: goBack()")
    const history = historyRef.current

    // Remove current path
    history.pop()
    historyParamsRef.current.pop()

    // Get previous path
    const previousPath = history[history.length - 1]
    const _previousParams = historyParamsRef.current[historyParamsRef.current.length - 1]

    console.info(`NavHistory: going back to: ${previousPath}`)
    // if (previousPath) {
    //   // Fallback to direct navigation if router.back() fails
    //   // router.replace({pathname: previousPath as any, params: previousParams as any})
    // } else if (router.canGoBack()) {
    //   router.back()
    // } else {
    //   // Ultimate fallback to home tab
    //   router.replace("/(tabs)/home")
    // }
    if (router.canGoBack()) {
      router.back()
    }
  }

  const push = (path: string, params?: any): void => {
    console.info("NavHistory: push()", path)
    // if the path is the same as the last path, don't add it to the history
    if (historyRef.current[historyRef.current.length - 1] === path) {
      return
    }

    historyRef.current.push(path)
    historyParamsRef.current.push(params)

    router.push({pathname: path as any, params: params as any})
  }

  const replace = (path: string, params?: any): void => {
    console.info("NavHistory: replace()", path)
    historyRef.current.pop()
    historyParamsRef.current.pop()
    historyRef.current.push(path)
    historyParamsRef.current.push(params)
    router.replace({pathname: path as any, params: params as any})
  }

  const getHistory = () => {
    return [...historyRef.current]
  }

  const clearHistory = () => {
    console.info("NavHistory: clearHistory()")
    historyRef.current = []
    historyParamsRef.current = []
  }

  const setPendingRoute = (route: string | null) => {
    console.info("NavHistory: setPendingRoute()", route)
    // setPendingRouteNonClashingName(route)
    pendingRoute.current = route
  }

  const getPendingRoute = () => {
    return pendingRoute.current
  }

  const navigate = (path: string, params?: any) => {
    console.info("NavHistory: navigate()", path)
    router.navigate({pathname: path as any, params: params as any})
  }

  const clearHistoryAndGoHome = () => {
    console.info("NavHistory: clearHistoryAndGoHome()")
    historyRef.current = []
    historyParamsRef.current = []
    try {
      // router.navigate("/(tabs)/home")
      router.dismissTo("/")
      router.replace("/(tabs)/home")
    } catch (error) {
      console.error("NavHistory: clearHistoryAndGoHome() error", error)
    }
    // router.replace("/(tabs)/home")
  }

  // whatever route we pass, will be the only route in the entire stack:
  const replaceAll = (path: string, params?: any) => {
    console.info("NavHistory: replaceAll()", path)
    clearHistoryAndGoHome()
    replace(path, params)
  }

  // the only routes in the stack will be home and the one we pass:
  const goHomeAndPush = (path: string, params?: any) => {
    console.info("NavHistory: goHomeAndPush()", path)
    clearHistoryAndGoHome()
    push(path, params)
  }

  const navObject: NavObject = {
    push,
    replace,
    goBack,
    setPendingRoute,
    getPendingRoute,
    navigate,
  }

  // Set the ref so we can use it from outside the context:
  useEffect(() => {
    navigationRef.current = navObject
  }, [])

  return (
    <NavigationHistoryContext.Provider
      value={{
        goBack,
        getHistory,
        clearHistory,
        push,
        replace,
        setPendingRoute,
        getPendingRoute,
        navigate,
        clearHistoryAndGoHome,
        replaceAll,
        goHomeAndPush,
      }}>
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
