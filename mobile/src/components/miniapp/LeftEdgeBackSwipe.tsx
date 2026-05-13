/**
 * LeftEdgeBackSwipe — MiniappHost renders above the Stack (absolute-positioned
 * with high zIndex), so iOS's built-in interactivePopGestureRecognizer never
 * sees the touch. This gesture detector fakes an edge-swipe-right so users
 * can still exit the miniapp from the left edge.
 *
 * Disabled while the WebView has its own back history (so WKWebView's native
 * allowsBackForwardNavigationGestures handles popping in-miniapp pages).
 */

import {useEffect, useState} from "react"
import {View} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"

import {miniappHost} from "@/components/miniapp/MiniappHost"

const EDGE_HIT_WIDTH = 24
const SWIPE_THRESHOLD = 60

interface LeftEdgeBackSwipeProps {
  packageName: string
  onBack?: () => void
}

export default function LeftEdgeBackSwipe({packageName, onBack}: LeftEdgeBackSwipeProps) {
  const [enabled, setEnabled] = useState(!miniappHost.canGoBack(packageName))

  useEffect(() => {
    return miniappHost.subscribeCanGoBack(packageName, (canGoBack) => setEnabled(!canGoBack))
  }, [packageName])

  const gesture = Gesture.Pan()
    .activeOffsetX(10)
    .failOffsetY([-15, 15])
    .onEnd((e) => {
      if (e.translationX > SWIPE_THRESHOLD) {
        onBack?.()
      }
    })
    .runOnJS(true)

  if (!enabled) return null

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          width: EDGE_HIT_WIDTH,
        }}
      />
    </GestureDetector>
  )
}
