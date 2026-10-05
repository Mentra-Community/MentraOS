import type {RefObject} from "react"
import {findNodeHandle, Platform, type View} from "react-native"
import {captureRef} from "react-native-view-shot"

import Crust from "@mentra/crust"

/** Capture before moving the miniapp; Android copies the rendered window pixels. */
export async function captureMiniappPreview(viewRef: RefObject<View | null>): Promise<string> {
  if (Platform.OS === "android") {
    const viewTag = findNodeHandle(viewRef.current)
    if (viewTag === null) throw new Error("Miniapp screenshot view is unavailable")
    return Crust.captureMiniappPreview(viewTag)
  }

  return captureRef(viewRef, {
    format: "jpg",
    quality: 0.1,
    result: "tmpfile",
  })
}
