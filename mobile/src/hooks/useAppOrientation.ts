import {useEffect, useState} from "react"
import {Dimensions, Platform} from "react-native"
import {SETTINGS, useSetting} from "@mentra/engine"

import {appOrientation} from "@/utils/appOrientation"

/** Screen dimensions survive keyboard resizing and swap safely on rotation. */
export function useAppOrientation() {
  const [enabled] = useSetting(SETTINGS.enable_landscape_web_views.key)
  const [screen, setScreen] = useState(() => Dimensions.get("screen"))
  useEffect(() => {
    const subscription = Dimensions.addEventListener("change", ({screen}) => setScreen(screen))
    return () => subscription.remove()
  }, [])
  return appOrientation(Platform.OS, enabled, screen.width, screen.height)
}
