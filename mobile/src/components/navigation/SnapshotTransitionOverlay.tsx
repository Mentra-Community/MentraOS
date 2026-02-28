import {Canvas, Image as SkiaImage, makeImageFromView} from "@shopify/react-native-skia"
import {createContext, useCallback, useContext, useRef, useState} from "react"
import {StyleSheet, View} from "react-native"
import {Easing, runOnJS, useSharedValue, withTiming} from "react-native-reanimated"

export type TransitionTrigger = {
  start: (onNavigate: () => void, direction?: "forward" | "back") => Promise<void>
  setNavigatorRef: (ref: View | null) => void
}

type TransitionContextType = TransitionTrigger | null

const TransitionContext = createContext<TransitionContextType>(null)

export const useSnapshotTransition = () => {
  const context = useContext(TransitionContext)
  return context
}

export const SnapshotTransitionProvider = ({children}: {children: React.ReactNode}) => {
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [oldSnapshot, setOldSnapshot] = useState<any>(null)
  const [newSnapshot, setNewSnapshot] = useState<any>(null)
  const [direction, setDirection] = useState<"forward" | "back">("forward")

  const navigatorRef = useRef<View | null>(null)
  const progress = useSharedValue(0)

  const setNavigatorRef = useCallback((ref: View | null) => {
    navigatorRef.current = ref
  }, [])

  const captureSnapshot = useCallback(async () => {
    if (!navigatorRef.current) {
      console.log("No navigator ref")
      return null
    }
    try {
      const snapshot = await makeImageFromView(navigatorRef)
      return snapshot
    } catch (error) {
      console.error("Failed to capture snapshot:", error)
      return null
    }
  }, [])

  const startTransition = useCallback(
    async (onNavigate: () => void, dir: "forward" | "back" = "forward") => {
      setDirection(dir)

      // Step 1: Capture the current view
      const oldSnap = await captureSnapshot()
      if (!oldSnap) {
        onNavigate()
        return
      }

      // Step 2: Show the overlay with the old snapshot
      setOldSnapshot(oldSnap)
      setIsTransitioning(true)
      progress.value = 0

      // Step 3: Perform the navigation (user still sees old snapshot)
      onNavigate()

      // Step 4: Wait a frame for navigation to complete, then capture new view
      await new Promise((resolve) => setTimeout(resolve, 50))

      const newSnap = await captureSnapshot()
      if (!newSnap) {
        setIsTransitioning(false)
        setOldSnapshot(null)
        return
      }

      // Step 5: Set the new snapshot
      setNewSnapshot(newSnap)

      // Step 6: Animate the transition
      const duration = dir === "forward" ? 300 : 250
      const easing = dir === "forward" ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic)

      progress.value = withTiming(
        1,
        {
          duration,
          easing,
        },
        (finished) => {
          if (finished) {
            runOnJS(setIsTransitioning)(false)
            runOnJS(setOldSnapshot)(null)
            runOnJS(setNewSnapshot)(null)
          }
        },
      )
    },
    [captureSnapshot, progress],
  )

  const trigger: TransitionTrigger = {
    start: startTransition,
    setNavigatorRef,
  }

  if (!isTransitioning || !oldSnapshot) {
    return <TransitionContext.Provider value={trigger}>{children}</TransitionContext.Provider>
  }

  // Calculate animated values based on direction
  const animProgress = progress.value

  let newScale: number, newOpacity: number, oldScale: number, oldOpacity: number

  if (direction === "forward") {
    // New screen: scales from 0.92 to 1.0, opacity 0 to 1
    newScale = 0.92 + animProgress * 0.08
    newOpacity = animProgress

    // Old screen: scales from 1 to 0.95, opacity 1 to 0.3
    oldScale = 1 - animProgress * 0.05
    oldOpacity = 1 - animProgress * 0.7
  } else {
    // Back transition (reverse)
    // Old screen (becoming visible): scales from 0.95 to 1, opacity 0.3 to 1
    oldScale = 0.95 + animProgress * 0.05
    oldOpacity = 0.3 + animProgress * 0.7

    // New screen (going away): scales from 1 to 0.92, opacity 1 to 0
    newScale = 1 - animProgress * 0.08
    newOpacity = 1 - animProgress
  }

  return (
    <TransitionContext.Provider value={trigger}>
      {children}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {/* Old snapshot */}
        <Canvas style={StyleSheet.absoluteFill}>
          {oldSnapshot && (
            <SkiaImage
              image={oldSnapshot}
              fit="cover"
              x={0}
              y={0}
              width={oldSnapshot.width()}
              height={oldSnapshot.height()}
              opacity={oldOpacity}
              transform={[{scale: oldScale}]}
            />
          )}
        </Canvas>

        {/* New snapshot */}
        {newSnapshot && (
          <Canvas style={StyleSheet.absoluteFill}>
            <SkiaImage
              image={newSnapshot}
              fit="cover"
              x={0}
              y={0}
              width={newSnapshot.width()}
              height={newSnapshot.height()}
              opacity={newOpacity}
              transform={[{scale: newScale}]}
            />
          </Canvas>
        )}
      </View>
    </TransitionContext.Provider>
  )
}
