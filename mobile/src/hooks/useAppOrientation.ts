import {useEffect, useState} from "react"
import {Dimensions, Platform} from "react-native"

import {appOrientation} from "@/utils/appOrientation"

/** Screen dimensions survive keyboard resizing and swap safely on rotation. */
export function useAppOrientation() {
  const [screen, setScreen] = useState(() => Dimensions.get("screen"))
  useEffect(() => {
    const subscription = Dimensions.addEventListener("change", ({screen}) => setScreen(screen))
    return () => subscription.remove()
  }, [])
  return appOrientation(Platform.OS, screen.width, screen.height)
}
