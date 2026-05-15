import {useFocusEffect, useNavigation} from "expo-router"
import {useCallback} from "react"
import {Platform} from "react-native"
import {CommonActions} from "@react-navigation/native"


import {useNavigationStore} from "@/stores/navigation"

// screens that call this function will prevent the back button from being pressed:
export type PreventBackEvent = {actionType: string}

export const focusEffectPreventBack = (backFn?: (event?: PreventBackEvent) => void, iosDontPreventBack?: boolean) => {
  const incPreventBack = useNavigationStore((s) => s.incPreventBack)
  const decPreventBack = useNavigationStore((s) => s.decPreventBack)
  const setAndroidBackFn = useNavigationStore((s) => s.setAndroidBackFn)
  const navigation = useNavigation()

  // hook into the back button on ios (skip if iosDontPreventBack — let native gesture handle it):
  if (Platform.OS === "ios") {
    useFocusEffect(
      useCallback(() => {
        const unsubscribe = navigation.addListener("beforeRemove", (e: any) => {
          backFn?.({actionType: e?.data?.action?.type ?? ""})
        })
        return () => {
          unsubscribe()
        }
      }, [backFn]),
    )
  }

  // don't prevent back on ios if iosDontPreventBack is true:
  if (iosDontPreventBack && Platform.OS === "ios") {
    return
  }

  useFocusEffect(
    useCallback(() => {
      incPreventBack()
      if (backFn) {
        setAndroidBackFn(() => backFn())
      }
      return () => {
        decPreventBack()
      }
    }, [incPreventBack, decPreventBack, backFn]),
  )
}

export function usePushUnder() {
  const navigation = useNavigation()

  return useCallback(
    (path: string, params?: any) => {
      console.info("NAV: pushUnder()", path)
      const {history, historyParams} = useNavigationStore.getState()

      const currentIndex = history.length - 1
      const currentPath = history[currentIndex]
      const currentParams = historyParams[currentIndex]

      // Build routes WITHOUT the current one
      const previousRoutes = history.slice(0, -1).map((p, i) => ({
        name: p,
        params: historyParams[i],
      }))

      const newRoutes = [
        ...previousRoutes,
        {name: path, params}, // new "under" route
        {name: currentPath, params: currentParams}, // current screen stays on top
      ]

      navigation.dispatch(
        CommonActions.reset({
          index: newRoutes.length - 1,
          routes: newRoutes,
        }),
      )

      // insert new path right before current in history
      const newHistory = [...history]
      const newHistoryParams = [...historyParams]
      newHistory.splice(currentIndex, 0, path)
      newHistoryParams.splice(currentIndex, 0, params)
      useNavigationStore.setState({
        history: newHistory,
        historyParams: newHistoryParams,
      })
    },
    [navigation],
  )
}

export function usePushPrevious() {
  const pushUnder = usePushUnder()

  return useCallback(
    (index: number = 0) => {
      console.info("NAV: pushPrevious()")
      const {history, historyParams, clearHistoryAndGoHome, push} = useNavigationStore.getState()

      const last = index + 2
      const lastRouteIndex = history.length - last
      const lastRoute = history[lastRouteIndex]
      const lastRouteParams = historyParams[lastRouteIndex]

      // build routes without the last n routes
      const n = index + 2
      let updatedRoutes = history.slice(0, -n)
      let updatedRoutesParams = historyParams.slice(0, -n)

      // re-add the soon-to-be-current route
      updatedRoutes.push(lastRoute)
      updatedRoutesParams.push(lastRouteParams)

      clearHistoryAndGoHome()

      if (lastRoute === "/home") return

      if (updatedRoutes[0] === "/home") {
        updatedRoutes.shift()
        updatedRoutesParams.shift()
      }

      updatedRoutes.reverse()
      updatedRoutesParams.reverse()
      console.log("NAV: updatedRoutes", updatedRoutes)
      console.log("NAV: updatedRoutesParams", updatedRoutesParams)

      // inline pushList logic
      const first = updatedRoutes.shift()!
      const firstParams = updatedRoutesParams.shift()
      push(first, firstParams)

      // pushUnder the rest in reverse order (already reversed above, so iterate backward)
      for (let i = updatedRoutes.length - 1; i >= 0; i--) {
        pushUnder(updatedRoutes[i], updatedRoutesParams[i])
      }
    },
    [pushUnder],
  )
}
