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
      // An offline-hosted miniapp (Settings, Store, …) registers a NavInterceptor
      // and owns its own internal stack. Hand hardware back to interceptor.goBack()
      // → the host's popOrExit: pop one sub-screen, and minimize to home only at
      // the host's root. This bypasses the global androidBackFn slot, which the
      // still-mounted root screen can clobber with its "minimize-to-home" handler
      // on any re-render — the cause of Android back exiting the whole miniapp
      // instead of going back one page.
      if (interceptor?.goBack()) {
        return true
      }
      // A registered interceptor that DECLINES is a host standing down mid-exit
      // (activeRef already false, still mounted for the fade-out). Falling
      // through to the store's goBack() there would reach router.back() and pop
      // whatever screen the push landed on — including a screen that locked
      // itself. Let the normal guard below decide instead.
      if (!preventBack) {
        goBack()
        return true
      }
      androidBackFn?.()
      return true
    })
    return () => sub.remove()
  }, [])

  return null
}