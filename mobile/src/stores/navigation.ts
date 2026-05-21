// stores/navigation.ts
import {create} from "zustand"
import {router} from "expo-router"
import {StackAnimationTypes} from "react-native-screens"

export type NavigationAnimation = StackAnimationTypes | string

type NavigationState = {
  // state
  history: string[]
  historyParams: any[]
  pendingRoute: string | null
  preventBack: boolean
  preventBackCount: number
  androidBackFn: (() => void) | undefined
  animation: NavigationAnimation
  forceGestureEnabled: boolean

  // actions
  push: (path: string, params?: any) => void
  replace: (path: string, params?: any) => void
  replaceAll: (path: string, params?: any) => void
  goBack: () => void
  navigate: (path: string, params?: any) => void
  setPendingRoute: (route: string | null) => void
  getPendingRoute: () => string | null
  getCurrentRoute: () => string | null
  getCurrentParams: () => any | null
  getPreviousRoute: (index?: number) => string | null
  clearHistory: () => void
  clearHistoryAndGoHome: (params?: any) => void
  goHomeAndPush: (path: string, params?: any) => void
  pushUnder: (path: string, params?: any) => void
  pushPrevious: (index?: number) => void
  incPreventBack: () => void
  decPreventBack: () => void
  setPreventBack: (value: boolean) => void
  setAndroidBackFn: (fn: (() => void) | undefined) => void
  setAnimation: (animation: NavigationAnimation) => void
  setForceGestureEnabled: (value: boolean) => void
  // internal
  _trackPathname: (newPath: string) => void
  _resetAnimationDelayed: (animation?: NavigationAnimation) => void
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  history: [],
  historyParams: [],
  pendingRoute: null,
  preventBack: false,
  preventBackCount: 0,
  androidBackFn: undefined,
  animation: "simple_push",
  forceGestureEnabled: false,

  push: (path, params) => {
    console.info("NAV: push()", path)
    const {history, historyParams, _resetAnimationDelayed} = get()
    if (history[history.length - 1] === path) return

    set({
      history: [...history, path],
      historyParams: [...historyParams, params],
      ...(params?.transition ? {animation: params.transition} : {}),
    })

    router.push({pathname: path as any, params: params as any})

    if (params?.transition) _resetAnimationDelayed()
  },

  replace: (path, params) => {
    console.info("NAV: replace()", path)
    const {history, historyParams, _resetAnimationDelayed} = get()
    set({
      history: [...history.slice(0, -1), path],
      historyParams: [...historyParams.slice(0, -1), params],
      ...(params?.transition ? {animation: params.transition} : {}),
    })
    router.replace({pathname: path as any, params: params as any})
    if (params?.transition) _resetAnimationDelayed()
  },

  replaceAll: (path, params) => {
    console.info("NAV: replaceAll()", path)
    get().clearHistory()
    set({history: [path], historyParams: [params]})
    router.replace({pathname: path as any, params: params as any})
  },

  goBack: () => {
    console.log("NAV: goBack()")
    const {history, historyParams, _resetAnimationDelayed} = get()
    const currentPath = history[history.length - 1]
    if (currentPath === "/home" || currentPath === "/") return

    // if the route we're going back to is home, delayed reset the animation to fade:
    if (history[history.length - 2] === "/home") {
      _resetAnimationDelayed("fade")
    }

    set({
      history: history.slice(0, -1),
      historyParams: historyParams.slice(0, -1),
    })

    if (router.canGoBack()) router.back()
  },

  navigate: (path, params) => {
    console.info("NAV: navigate()", path)
    router.navigate({pathname: path as any, params: params as any})
  },

  setPendingRoute: (route) => {
    console.info("NAV: setPendingRoute()", route)
    set({pendingRoute: route})
  },
  getPendingRoute: () => get().pendingRoute,
  getCurrentRoute: () => {
    const {history} = get()
    return history[history.length - 1] ?? null
  },
  getCurrentParams: () => {
    const {historyParams} = get()
    return historyParams[historyParams.length - 1] ?? null
  },
  getPreviousRoute: (index = 0) => {
    const {history} = get()
    if (history.length < 2 + index) return null
    return history[history.length - (2 + index)]
  },

  clearHistory: () => {
    console.info("NAV: clearHistory()")
    set({history: [], historyParams: []})
    try {
      router.dismissAll()
    } catch {}
    try {
      router.dismissTo("/home")
    } catch {}
  },

  clearHistoryAndGoHome: (params) => {
    console.info("NAV: clearHistoryAndGoHome()")
    const {clearHistory, _resetAnimationDelayed} = get()
    clearHistory()
    try {
      if (params?.transition) set({animation: params.transition})
      router.replace({pathname: "/home" as any, params: params as any})
      set({history: ["/home"], historyParams: [undefined]})
    } catch (e) {
      console.error("NAV: clearHistoryAndGoHome() error", e)
    }
  },

  goHomeAndPush: (path, params) => {
    console.info("NAV: goHomeAndPush()", path)
    get().clearHistoryAndGoHome()
    get().push(path, params)
  },

  pushUnder: (path, params) => {
    // pushUnder needs `useNavigation()` from React Navigation, which is hook-only.
    // See "pushUnder gotcha" below.
    console.warn("NAV: pushUnder() — see note about useNavigation")
  },

  pushPrevious: (index = 0) => {
    // same gotcha as pushUnder
    console.warn("NAV: pushPrevious() — see note about useNavigation")
  },

  incPreventBack: () => {
    const next = get().preventBackCount + 1
    set({preventBackCount: next, preventBack: true})
  },
  decPreventBack: () => {
    let next = get().preventBackCount - 1
    if (next <= 0) {
      next = 0
      set({
        preventBackCount: 0,
        androidBackFn: undefined,
        preventBack: false,
      })
    } else {
      set({preventBackCount: next})
    }
  },

  setPreventBack: (value) => set({preventBack: value}),
  setAndroidBackFn: (fn) => set({androidBackFn: fn}),
  setAnimation: (animation) => set({animation}),
  setForceGestureEnabled: (value) => set({forceGestureEnabled: value}),

  _trackPathname: (newPath) => {
    const {history, historyParams} = get()
    if (history.length < 1) {
      set({history: [newPath]})
      return
    }
    if (history.length > 20) {
      set({history: history.slice(-20)})
    }
    const currentPath = history[history.length - 1]
    if (newPath === currentPath) return

    if (history.includes(newPath)) {
      console.log("NAV: BACK NAVIGATION DETECTED")
      let h = [...history]
      let p = [...historyParams]
      while (h[h.length - 1] !== newPath) {
        h.pop()
        p.pop()
      }
      set({history: h, historyParams: p})
    } else {
      set({history: [...history, newPath]})
    }
  },

  _resetAnimationDelayed: (animation?: NavigationAnimation) => {
    setTimeout(() => set({animation: animation ?? "simple_push"}), 800)
  },
}))
