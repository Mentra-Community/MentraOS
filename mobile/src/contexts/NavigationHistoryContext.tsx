import {router, useFocusEffect, useNavigationContainerRef, usePathname, useSegments} from "expo-router"
import {createContext, useContext, useEffect, useRef, useCallback, useState} from "react"
import {Alert, BackHandler} from "react-native"
import {useNavigation} from "expo-router"
import {CommonActions, StackActions} from "@react-navigation/native"

import {navigationRef} from "@/contexts/NavigationRef"

export type NavigationHistoryPush = (path: string, params?: any) => void
export type NavigationHistoryReplace = (path: string, params?: any) => void
export type NavigationHistoryReplaceAll = (path: string, params?: any) => void
export type NavigationHistoryGoBack = () => void

export type NavObject = {
  push: NavigationHistoryPush
  replace: NavigationHistoryReplace
  replaceAll: NavigationHistoryReplaceAll
  goBack: NavigationHistoryGoBack
  setPendingRoute: (route: string) => void
  getPendingRoute: () => string | null
  navigate: (path: string, params?: any) => void
  preventBack: boolean
}

interface NavigationHistoryContextType {
  goBack: () => void
  getHistory: () => string[]
  getPreviousRoute: () => string | null
  clearHistory: () => void
  push: (path: string, params?: any) => void
  replace: (path: string, params?: any) => void
  setPendingRoute: (route: string | null) => void
  getPendingRoute: () => string | null
  navigate: (path: string, params?: any) => void
  clearHistoryAndGoHome: () => void
  replaceAll: (path: string, params?: any) => void
  goHomeAndPush: (path: string, params?: any) => void
  preventBack: boolean
  setPreventBack: (value: boolean) => void
  pushPrevious: (index?: number) => void
  pushUnder: (path: string, params?: any) => void
  incPreventBack: () => void
  decPreventBack: () => void
  setAndroidBackFn: (fn: () => void) => void
}

const NavigationHistoryContext = createContext<NavigationHistoryContextType | undefined>(undefined)

export function NavigationHistoryProvider({children}: {children: React.ReactNode}) {
  const historyRef = useRef<string[]>([])
  const historyParamsRef = useRef<any[]>([])

  const pathname = usePathname()
  const _segments = useSegments()
  const pendingRoute = useRef<string | null>(null)
  const navigation = useNavigation()
  const [preventBack, setPreventBack] = useState(false)
  const preventBackCountRef = useRef(0)
  const androidBackFnRef = useRef<() => void | undefined>(undefined)
  const setAndroidBackFn = (fn: () => void) => {
    androidBackFnRef.current = fn
  }
  const rootNavigation = useNavigationContainerRef()

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

  // block the back button on android when preventBack is true:
  useEffect(() => {
    // if (!preventBack) return
    console.log("NAV: REGISTERING BACK HANDLER =========================")
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      console.log("NAV: BACK HANDLER CALLED =========================")
      if (androidBackFnRef.current) {
        androidBackFnRef.current()
      }
      return true
    })
    return () => backHandler.remove()
  }, [preventBack])

  const incPreventBack = useCallback(() => {
    preventBackCountRef.current++
    setPreventBack(true)
  }, [])

  const decPreventBack = useCallback(() => {
    preventBackCountRef.current--
    if (preventBackCountRef.current <= 0) {
      preventBackCountRef.current = 0
      setPreventBack(false)
      androidBackFnRef.current = undefined
    }
  }, [])

  useEffect(() => {
    let sub = navigation.addListener("state", (state) => {
      // console.log("NAV: iOS: state", state)
      // console.log("NAV: iOS: state.routeNames", state.data.state.routeNames)
      // console.log("NAV: iOS: state.routes", state.data.state.routes)
      // let a = state.data.state.routes
      // console.log("NAV: iOS: a", a[0].state?.routes)
      // if (a.length > 1) {
      //   console.log("NAV: iOS: b", a[1])
      // }
      // console.log("NAV: iOS: BBB", state.data.state)
    })
  }, [navigation])

  // useEffect(() => {
  //   let currentRoute = rootNavigation.getCurrentRoute()
  //   console.log("NAV: iOS: currentRoute", currentRoute)
  //   let currentRouteOptions = rootNavigation.getCurrentOptions()
  //   console.log("NAV: iOS: currentRouteOptions", currentRouteOptions)
  // }, [pathname])


  // const unsubscribe = rootNavigation..addListener("beforeRemove", (e) => {
  //   // Triggered on back swipe, back button, or programmatic goBack()
  //   console.log("NAV: iOS: User is leaving the screen")

  //   // Optionally prevent navigation:
  //   // e.preventDefault()
  // })
  
  // useEffect(() => {
  //   console.log("NAV: iOS: useEffect()")
  //   const unsubscribe = navigation.addListener("beforeRemove", (e) => {
  //     // Triggered on back swipe, back button, or programmatic goBack()
  //     console.log("NAV: iOS: User is leaving the screen")

  //     // Optionally prevent navigation:
  //     // e.preventDefault()
  //   })

  //   return unsubscribe
  // }, [navigation])

  const goBack = () => {
    console.info("NAV: goBack()")
    const history = historyRef.current

    // Remove current path
    history.pop()
    historyParamsRef.current.pop()

    // Get previous path
    const previousPath = history[history.length - 1]
    const _previousParams = historyParamsRef.current[historyParamsRef.current.length - 1]

    console.info(`NAV: going back to: ${previousPath}`)
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
    console.info("NAV: push()", path)
    // if the path is the same as the last path, don't add it to the history
    if (historyRef.current[historyRef.current.length - 1] === path) {
      return
    }

    historyRef.current.push(path)
    historyParamsRef.current.push(params)

    router.push({pathname: path as any, params: params as any})
  }

  const replace = (path: string, params?: any): void => {
    console.info("NAV: replace()", path)
    historyRef.current.pop()
    historyParamsRef.current.pop()
    historyRef.current.push(path)
    historyParamsRef.current.push(params)
    router.replace({pathname: path as any, params: params as any})
  }

  const getHistory = () => {
    return [...historyRef.current]
  }

  const getPreviousRoute = () => {
    if (historyRef.current.length < 2) {
      return null
    }
    return historyRef.current[historyRef.current.length - 2]
  }

  const clearHistory = () => {
    console.info("NAV: clearHistory()")
    historyRef.current = []
    historyParamsRef.current = []
    try {
      router.dismissAll()
    } catch (_e) {}
    try {
      router.dismissTo("/(tabs)/home")
      // router.dismissTo("/")
      // router.replace("/")
      // router.
    } catch (_e) {}
    // try {
    //   router.dismissTo("/")
    // } catch (_e) {}
  }

  const setPendingRoute = (route: string | null) => {
    console.info("NAV: setPendingRoute()", route)
    // setPendingRouteNonClashingName(route)
    pendingRoute.current = route
  }

  const getPendingRoute = () => {
    return pendingRoute.current
  }

  const navigate = (path: string, params?: any) => {
    console.info("NAV: navigate()", path)
    router.navigate({pathname: path as any, params: params as any})
  }

  const pushList = (list: string[]) => {
    console.info("NAV: pushList()", list)
    // list.forEach((path) => {
    //   push(path)
    // })
  }

  const clearHistoryAndGoHome = () => {
    console.info("NAV: clearHistoryAndGoHome()")
    clearHistory()
    try {
      // router.dismissAll()
      // router.dismissTo("/")
      // router.navigate("/")
      router.replace("/(tabs)/home")
      historyRef.current = ["/(tabs)/home"]
      historyParamsRef.current = [undefined]
    } catch (error) {
      console.error("NAV: clearHistoryAndGoHome() error", error)
    }
  }

  // whatever route we pass, will be the only route in the entire stack:
  // dismiss all and push the new route:
  const replaceAll = (path: string, params?: any) => {
    console.info("NAV: replaceAll()", path)
    clearHistory()
    // try {
    //   // router.dismissAll()
    //   // router.dismissTo("/")
    //   // router.navigate("/")
    //   // router.dismissAll()
    //   // router.replace("/")
    // } catch (_e) {
    // }
    // replace(path, params)
    // push(path, params)
    router.replace({pathname: path as any, params: params as any})
  }

  const pushUnder = (path: string, params?: any) => {
    console.info("NAV: pushUnder()", path)
    // historyRef.current.push(path)
    // historyParamsRef.current.push(params)
    // router.push({pathname: path as any, params: params as any})

    // get current path:
    const currentIndex = historyRef.current.length - 1
    const currentPath = historyRef.current[currentIndex]
    const currentParams = historyParamsRef.current[currentIndex]

    // Build routes WITHOUT the current one
    const previousRoutes = historyRef.current.slice(0, -1).map((path, index) => ({
      name: path,
      params: historyParamsRef.current[index],
    }))

    const newRoutes = [
      ...previousRoutes,
      {name: path, params: params}, // New "under" route
      {name: currentPath, params: currentParams}, // Current screen stays on top
    ]

    navigation.dispatch(
      CommonActions.reset({
        index: newRoutes.length - 1, // Point to current screen (last)
        routes: newRoutes,
      }),
    )

    // Insert new path right before current in history
    historyRef.current.splice(currentIndex, 0, path)
    historyParamsRef.current.splice(currentIndex, 0, params)
  }

  // when you want to go back, but animate it like a push:
  const pushPrevious = (index: number = 0) => {
    console.info("NAV: pushPrevious()")
    console.log("NAV: historyRef.current", historyRef.current)
    // const prevIndex = historyRef.current.length - (2 + index)
    // const previousPath = historyRef.current[prevIndex]
    // const previousParams = historyParamsRef.current[prevIndex]
    // clearHistory()
    // push(previousPath as any, previousParams as any)

    const last = index + 2
    const lastRouteIndex = historyRef.current.length - last
    // the route we want to later "push" onto the stack:
    const lastRoute = historyRef.current[lastRouteIndex]
    console.log("NAV: lastRoute", lastRoute)
    const lastRouteParams = historyParamsRef.current[lastRouteIndex]

    // Build routes WITHOUT n routes (removing current and last n routes)
    const n = index + 2
    let updatedRoutes = historyRef.current.slice(0, -n)
    let updatedRoutesParams = historyParamsRef.current.slice(0, -n)

    // // remove any /home routes (remove the same index from updatedRoutesParams):
    // updatedRoutes.forEach((path, index) => {
    //   if (path === "/home") {
    //     updatedRoutes.splice(index, 1)
    //     updatedRoutesParams.splice(index, 1)
    //   }
    // })
    // remov
    // // add ghost route:
    // updatedRoutes.push("/")
    // updatedRoutesParams.push(undefined)

    const newRouteState = updatedRoutes.map((path, index) => ({
      name: path,
      params: historyParamsRef.current[index],
    }))

    console.log(
      "NAV: newRouteState",
      newRouteState.map((route) => route.name),
    )

    rootNavigation.dispatch(StackActions.popToTop())
    rootNavigation.dispatch(
      CommonActions.reset({
        index: newRouteState.length - 1, // Point to current screen (last)
        routes: newRouteState,
      }),
    )

    // update our history ref popping the last n elements:
    historyRef.current = updatedRoutes
    historyParamsRef.current = updatedRoutesParams

    console.log("NAV: updated historyRef.current", historyRef.current)
    console.log("NAV: updated historyParamsRef.current", historyParamsRef.current)

    // push the last route onto the stack:
    // dumb edge case, if the route is home, we need to clearHistoryAndGoHome()
    // TODO: may no longer be needed:
    if (lastRoute === "/(tabs)/home" || lastRoute === "/home") {
      clearHistoryAndGoHome()
    } else {
      push(lastRoute, lastRouteParams)
    }
  }

  // the only routes in the stack will be home and the one we pass:
  const goHomeAndPush = (path: string, params?: any) => {
    console.info("NAV: goHomeAndPush()", path)
    clearHistoryAndGoHome()
    push(path, params)
  }

  const navObject: NavObject = {
    push,
    replace,
    replaceAll,
    goBack,
    setPendingRoute,
    getPendingRoute,
    navigate,
    preventBack,
  }

  // Set the ref so we can use it from outside the context:
  useEffect(() => {
    navigationRef.current = navObject
  }, [preventBack])

  return (
    <NavigationHistoryContext.Provider
      value={{
        goBack,
        getHistory,
        getPreviousRoute,
        clearHistory,
        push,
        replace,
        setPendingRoute,
        getPendingRoute,
        navigate,
        clearHistoryAndGoHome,
        replaceAll,
        goHomeAndPush,
        setPreventBack,
        preventBack,
        pushPrevious,
        pushUnder,
        incPreventBack,
        decPreventBack,
        setAndroidBackFn,
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

// export const focusEffectPreventBack = () => {
//   const {setPreventBack} = useNavigationHistory()

//   useFocusEffect(
//     useCallback(() => {
//       setPreventBack(true)
//       return () => {
//         setPreventBack(false)
//       }
//     }, []),
//   )
// }

// screens that call this function will prevent the back button from being pressed:
export const focusEffectPreventBack = (androidBackFn?: () => void) => {
  const {incPreventBack, decPreventBack, setAndroidBackFn} = useNavigationHistory()

  useFocusEffect(
    useCallback(() => {
      incPreventBack()
      if (androidBackFn) {
        setAndroidBackFn(androidBackFn)
      }
      return () => {
        decPreventBack()
      }
    }, [incPreventBack, decPreventBack]),
  )
}
