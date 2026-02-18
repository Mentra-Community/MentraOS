import {router, useFocusEffect, usePathname, useSegments, useNavigation} from "expo-router"
import {createContext, useContext, useEffect, useRef, useCallback, useState} from "react"
import {BackHandler} from "react-native"
import {CommonActions} from "@react-navigation/native"

import {navigationRef} from "@/contexts/NavigationRef"
import {StackAnimationTypes} from "react-native-screens"

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
  setAnimation: (animation: StackAnimationTypes) => void
}

interface NavigationHistoryContextType {
  goBack: () => void
  getHistory: () => string[]
  getPreviousRoute: (index?: number) => string | null
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
  setAnimation: (animation: StackAnimationTypes) => void
  animation: StackAnimationTypes
}

const NavigationHistoryContext = createContext<NavigationHistoryContextType | undefined>(undefined)

export function NavigationHistoryProvider({children}: {children: React.ReactNode}) {
  const historyRef = useRef<string[]>([])
  const historyParamsRef = useRef<any[]>([])
  const [history, setDebugHistory] = useState<string[]>([]) // for debugging only!

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
  const [animation, setAnimation] = useState<StackAnimationTypes>("simple_push")
  // const rootNavigation = useNavigationContainerRef()

  useEffect(() => {
    const newPath = pathname

    if (historyRef.current.length < 1) {
      historyRef.current.push(newPath)
      setDebugHistory([...historyRef.current])
      return
    }

    // Keep history limited to prevent memory issues (keep last 20 entries)
    if (historyRef.current.length > 20) {
      historyRef.current = historyRef.current.slice(-20)
      setDebugHistory([...historyRef.current])
    }

    let currentPath = historyRef.current[historyRef.current.length - 1]
    if (newPath === currentPath) {
      return
    }

    // add the new path to the history:
    // but only if it's not already in the history:
    if (historyRef.current.includes(newPath)) {
      // this was actually a back navigation, so we should pop until we get to the last instance of the path:
      console.log("NAV: BACK NAVIGATION DETECTED")
      while (historyRef.current[historyRef.current.length - 1] !== newPath) {
        historyRef.current.pop()
        historyParamsRef.current.pop()
      }
    } else {
      historyRef.current.push(newPath)
    }
    setDebugHistory([...historyRef.current])
  }, [pathname])

  // always block the android back button, but allow the behavior to be overridden by the androidBackFnRef:
  // when preventBack is false, goBack() will be called:
  useEffect(() => {
    console.log("NAV: ======== REGISTERING BACK HANDLER ===========")
    const backHandler = BackHandler.addEventListener("hardwareBackPress", () => {
      console.log("NAV: ======== BACK HANDLER CALLED ===========")
      if (!preventBack) {
        goBack()
        return true
      }
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

  // subscribe to route changes and check if a back button was used:
  // const oldPathRef = useRef<string | null>(null)
  // useEffect(() => {
  //   const oldPath = oldPathRef.current
  //   const newPath = pathname
  //   if (historyRef.current.length < 2) {
  //     oldPathRef.current = pathname
  //     return
  //   }
  //   if (oldPath !== null && oldPath !== newPath) {
  //     // if our previous pathname is the current pathname, and the current pathname is n-1, then we have navigated back:
  //     const curHistoryIndex = historyRef.current.length - 1
  //     const prevHistoryIndex = curHistoryIndex - 1
  //     const prevHistoryPath = historyRef.current[prevHistoryIndex]
  //     const curHistoryPath = historyRef.current[curHistoryIndex]
  //     if (newPath === prevHistoryPath && oldPath === curHistoryPath) {
  //       console.log("NAV: SILENT_BACK_DETECTED")
  //       // we need to update the historyRef and historyParamsRef to pop the last route:
  //       historyRef.current.pop()
  //       historyParamsRef.current.pop()
  //       setDebugHistory([...historyRef.current])
  //     }
  //   }
  //   // update ref *after* comparison
  //   oldPathRef.current = pathname
  // }, [pathname])

  const goBack = () => {
    console.info("NAV: goBack()")
    const currentPath = historyRef.current[historyRef.current.length - 1]
    // const currentParams = historyParamsRef.current[historyParamsRef.current.length - 1]

    if (currentPath === "/home" || currentPath === "/") {
      // can't go back from home or root, do nothing
      console.info("NAV: can't go back from home or root, doing nothing")
      return
    }

    // remove current path:
    historyRef.current.pop()
    historyParamsRef.current.pop()
    setDebugHistory([...historyRef.current])

    // Get previous path
    // const previousPath = historyRef.current[historyRef.current.length - 2]
    // const previousParams = historyParamsRef.current[historyParamsRef.current.length - 2]
    // console.info(`NAV: going back from: ${currentPath}`)
    // if (previousPath) {
    //   // Fallback to direct navigation if router.back() fails
    //   // router.replace({pathname: previousPath as any, params: previousParams as any})
    // } else if (router.canGoBack()) {
    //   router.back()
    // } else {
    //   // Ultimate fallback to home tab
    //   router.replace("/home")
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
    setDebugHistory([...historyRef.current])

    router.push({pathname: path as any, params: params as any})
  }

  const replace = (path: string, params?: any): void => {
    console.info("NAV: replace()", path)
    historyRef.current.pop()
    historyParamsRef.current.pop()
    historyRef.current.push(path)
    historyParamsRef.current.push(params)
    setDebugHistory([...historyRef.current])
    router.replace({pathname: path as any, params: params as any})
  }

  const getHistory = () => {
    return history
  }

  const getPreviousRoute = (index: number = 0) => {
    if (historyRef.current.length < 2 + index) {
      return null
    }
    return historyRef.current[historyRef.current.length - (2 + index)]
  }

  const clearHistory = () => {
    console.info("NAV: clearHistory()")
    historyRef.current = []
    historyParamsRef.current = []
    setDebugHistory([...historyRef.current])
    try {
      router.dismissAll()
    } catch (_e) {}
    try {
      router.dismissTo("/home")
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

  const clearHistoryAndGoHome = () => {
    console.info("NAV: clearHistoryAndGoHome()")
    clearHistory()
    try {
      // router.dismissAll()
      // router.dismissTo("/")
      // router.navigate("/")
      router.replace("/home")
      historyRef.current = ["/home"]
      historyParamsRef.current = [undefined]
      setDebugHistory([...historyRef.current])
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
    historyRef.current = [path]
    historyParamsRef.current = [params]
    setDebugHistory([...historyRef.current])
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

    // console.log("NAV: previousRoutes", previousRoutes)

    const newRoutes = [
      ...previousRoutes,
      {name: path, params: params}, // New "under" route
      {name: currentPath, params: currentParams}, // Current screen stays on top
    ]

    // console.log("NAV: newRoutes", newRoutes.map((route) => route.name))

    navigation.dispatch(
      CommonActions.reset({
        index: newRoutes.length - 1, // Point to current screen (last)
        routes: newRoutes,
      }),
    )

    // rootNavigation.dispatch(
    //   CommonActions.reset({
    //     index: newRoutes.length - 1, // Point to current screen (last)
    //     routes: newRoutes,
    //   }),
    // )

    // Insert new path right before current in history
    historyRef.current.splice(currentIndex, 0, path)
    historyParamsRef.current.splice(currentIndex, 0, params)
    setDebugHistory([...historyRef.current])
  }

  const pushList = (routes: string[], params: any[]) => {
    console.info("NAV: pushList()", routes)
    const first = routes.shift()
    const firstParams = params.shift()
    push(first!, firstParams)
    // go bottom to top and pushUnder the rest (in reverse order):
    for (let i = routes.length - 1; i >= 0; i--) {
      pushUnder(routes[i], params[i])
    }
  }

  // when you want to go back, but animate it like a push:
  const pushPrevious = (index: number = 0) => {
    console.info("NAV: pushPrevious()")
    // const prevIndex = historyRef.current.length - (2 + index)
    // const previousPath = historyRef.current[prevIndex]
    // const previousParams = historyParamsRef.current[prevIndex]
    // clearHistory()
    // push(previousPath as any, previousParams as any)

    const last = index + 2
    const lastRouteIndex = historyRef.current.length - last
    // the route we want to later "push" onto the stack:
    const lastRoute = historyRef.current[lastRouteIndex]
    const lastRouteParams = historyParamsRef.current[lastRouteIndex]

    // Build routes WITHOUT n routes (removing current and last n routes)
    const n = index + 2
    let updatedRoutes = historyRef.current.slice(0, -n)
    let updatedRoutesParams = historyParamsRef.current.slice(0, -n)

    // re-add the last (soon to be new current) route:
    updatedRoutes.push(lastRoute)
    updatedRoutesParams.push(lastRouteParams)

    clearHistoryAndGoHome()

    if (lastRoute === "/home") {
      return // we are already on home, so we are done
    }

    // if /home is at the start of the list remove it:
    if (updatedRoutes[0] === "/home") {
      updatedRoutes.shift()
      updatedRoutesParams.shift()
    }
    updatedRoutes.reverse() // reverse for the pushList function
    updatedRoutesParams.reverse() // must also reverse params to keep them aligned!
    console.log("NAV: updatedRoutes", updatedRoutes)
    console.log("NAV: updatedRoutesParams", updatedRoutesParams)
    pushList(updatedRoutes, updatedRoutesParams)

    // rootNavigation.dispatch(StackActions.popToTop())
    // rootNavigation.dispatch(
    //   CommonActions.reset({
    //     index: newRouteState.length - 1, // Point to current screen (last)
    //     routes: newRouteState,
    //   }),
    // )

    // // update our history ref popping the last n elements:
    // historyRef.current = updatedRoutes
    // historyParamsRef.current = updatedRoutesParams

    // console.log("NAV: updated historyRef.current", historyRef.current)
    // console.log("NAV: updated historyParamsRef.current", historyParamsRef.current)

    // console.log("NAV: pushing lastRoute", lastRoute, lastRouteParams)
    // push(lastRoute, lastRouteParams)
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
    setAnimation,
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
        setAnimation,
        animation,
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
