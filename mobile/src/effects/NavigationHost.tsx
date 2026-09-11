import {useEffect} from "react"
import {BackHandler} from "react-native"
import {usePathname} from "expo-router"
import {useNavigationStore} from "@/stores/navigation"

export default function NavigationHost() {
  const pathname = usePathname()

  useEffect(() => {
    useNavigationStore.getState()._trackPathname(pathname)
    // if we're on the home screen, reset the animation to fade:
    if (pathname === "/home") {
      useNavigationStore.getState()._resetAnimationDelayed("fade")
    }
  }, [pathname])

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      const {preventBack, androidBackFn, goBack, interceptor} = useNavigationStore.getState()
      // Nothing is guarding the focused screen, so goBack() decides: it
      // dispatches the interceptor itself and otherwise pops the router.
      if (!preventBack) {
        goBack()
        return true
      }
      // A guard is up. An offline-hosted miniapp (Settings, Store, …) registers a
      // NavInterceptor and owns its own internal stack, so ask it first:
      // interceptor.goBack() → the host's popOrExit: pop one sub-screen, and
      // minimize to home only at the host's root. This bypasses the global
      // androidBackFn slot, which the still-mounted root screen can clobber with
      // its "minimize-to-home" handler on any re-render — the cause of Android
      // back exiting the whole miniapp instead of going back one page.
      //
      // An interceptor that DECLINES is a host standing down mid-exit (activeRef
      // already false, still mounted for the fade-out). Handing back to the
      // store's goBack() there would reach router.back() and pop whatever screen
      // the push landed on — including a screen that locked itself. Fall through
      // to the guard instead. Either way the interceptor is dispatched once.
      if (interceptor?.goBack()) {
        return true
      }
      androidBackFn?.()
      return true
    })
    return () => sub.remove()
  }, [])

  return null
}