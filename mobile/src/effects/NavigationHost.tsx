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
      const {preventBack, androidBackFn, goBack} = useNavigationStore.getState()
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