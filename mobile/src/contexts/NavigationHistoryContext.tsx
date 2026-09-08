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

// Stable identity so focusEffectPreventBack's focus effect (keyed on backFn)
// runs once per focus instead of on every render of the locked screen.
const noopBack = () => {}

/**
 * Hard-locks a one-way screen: no back gesture, no hardware back, no inherited
 * back handler. Use it on screens that deliberately render no back affordance
 * at all and that strand the user if they are left mid-flow (Mentra Live OTA).
 *
 * focusEffectPreventBack() on its own leaves two ways out:
 *
 *  - Android: `androidBackFn` is a single global slot that decPreventBack only
 *    clears once the prevent-back count reaches zero. A screen we were pushed
 *    on top of (any capsule host) is still holding that slot when it blurs, and
 *    NavigationHost runs whatever is in it on hardware/gesture back — which
 *    pops us off this screen. Claiming the slot with a no-op closes that path.
 *  - iOS: the stack's `gestureEnabled` is a navigator-wide default of
 *    `forceGestureEnabled || !preventBack`, so anything still holding
 *    `forceGestureEnabled` (a miniapp host mid-teardown) re-enables the edge
 *    swipe for every screen. A per-screen option beats the navigator default
 *    and cannot be turned back on from elsewhere.
 */
export const focusEffectLockScreen = () => {
  const navigation = useNavigation()

  focusEffectPreventBack(noopBack)

  useFocusEffect(
    useCallback(() => {
      // expo-router types useNavigation() against the generic navigator, which
      // doesn't surface the native stack's gestureEnabled option.
      const setGesture = navigation.setOptions as (options: {gestureEnabled?: boolean}) => void
      setGesture({gestureEnabled: false})
      return () => setGesture({gestureEnabled: undefined})
    }, [navigation]),
  )

  // Backstop for a back action dispatched in JS rather than by the gesture.
  // Only GO_BACK/POP are blocked: a locked screen still has to be able to leave
  // through its own controls, and those go out as REPLACE/POP_TO_TOP/POP_TO
  // (goBack() is never one of the exits). Blocking removal outright would
  // strand the user on the screen for good.
  useFocusEffect(
    useCallback(
      () =>
        navigation.addListener("beforeRemove", (event: any) => {
          const actionType = event?.data?.action?.type ?? ""
          if (actionType === "GO_BACK" || actionType === "POP") {
            event.preventDefault()
          }
        }),
      [navigation],
    ),
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
