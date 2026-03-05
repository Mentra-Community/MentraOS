import {createContext, useContext, useEffect, useState, useRef} from "react"
import {Platform, View} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"

import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {BackgroundTimer} from "@/utils/timers"

type Direction = "up" | "down" | "left" | "right"

const KONAMI_CODE: Direction[] = ["up", "up", "down", "down", "left", "right", "left", "right"]
const MINI_CODE: Direction[] = ["up", "up", "down", "down", "left", "left", "right", "right", "up", "up"]
const SUPER_CODE: Direction[] = ["up", "down", "up", "down", "left", "left"]
const MAX_CODE_LENGTH = Math.max(KONAMI_CODE.length, MINI_CODE.length, SUPER_CODE.length)

type KonamiContextType = {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

const KonamiContext = createContext<KonamiContextType | null>(null)

export function useKonamiCode() {
  const context = useContext(KonamiContext)
  if (!context) {
    throw new Error("useKonamiCode must be used within a KonamiCodeProvider")
  }
  return context
}

export function KonamiCodeProvider({children}: {children: React.ReactNode}) {
  const [enabled, setEnabled] = useState(true)
  const [sequence, setSequence] = useState<Direction[]>([])
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const {goHomeAndPush} = useNavigationHistory()

  useEffect(() => {
    if (!enabled) return

    const matchesCode = (code: Direction[]) =>
      sequence.length >= code.length && code.every((dir, i) => dir === sequence[sequence.length - code.length + i])

    if (matchesCode(KONAMI_CODE)) {
      console.log("KONAMI: Konami code activated!")
      goHomeAndPush("/settings/developer")
      setSequence([])
    } else if (matchesCode(MINI_CODE)) {
      console.log("KONAMI: Mini code activated!")
      setSequence([])
    } else if (matchesCode(SUPER_CODE)) {
      console.log("KONAMI: Super code activated!")
      goHomeAndPush("/settings/super")
      setSequence([])
    }
  }, [sequence, goHomeAndPush, enabled])

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) {
        BackgroundTimer.clearTimeout(resetTimeoutRef.current)
      }
    }
  }, [])

  const addDirection = (direction: Direction) => {
    console.log("KONAMI: Swipe detected:", direction)

    setSequence((prev) => {
      const newSequence = [...prev, direction]
      return newSequence.slice(-MAX_CODE_LENGTH)
    })

    if (resetTimeoutRef.current) {
      BackgroundTimer.clearTimeout(resetTimeoutRef.current)
    }

    resetTimeoutRef.current = BackgroundTimer.setTimeout(() => {
      setSequence([])
    }, 8000)
  }

  let flingUp, flingDown, flingLeft, flingRight

  if (Platform.OS === "android") {
    flingUp = Gesture.Fling()
      .numberOfPointers(2)
      .direction(1)
      .onEnd(() => addDirection("right"))
      .runOnJS(true)

    flingDown = Gesture.Fling()
      .numberOfPointers(2)
      .direction(2)
      .onEnd(() => addDirection("left"))
      .runOnJS(true)

    flingLeft = Gesture.Fling()
      .numberOfPointers(2)
      .direction(4)
      .onEnd(() => addDirection("up"))
      .runOnJS(true)

    flingRight = Gesture.Fling()
      .numberOfPointers(2)
      .direction(8)
      .onEnd(() => addDirection("down"))
      .runOnJS(true)
  } else {
    flingUp = Gesture.Fling()
      .direction(1)
      .onEnd(() => addDirection("right"))
      .runOnJS(true)

    flingDown = Gesture.Fling()
      .direction(2)
      .onEnd(() => addDirection("left"))
      .runOnJS(true)

    flingLeft = Gesture.Fling()
      .direction(4)
      .onEnd(() => addDirection("up"))
      .runOnJS(true)

    flingRight = Gesture.Fling()
      .direction(8)
      .onEnd(() => addDirection("down"))
      .runOnJS(true)
  }

  const composedGesture = Gesture.Simultaneous(Gesture.Race(flingUp, flingDown, flingLeft, flingRight))

  return (
    <KonamiContext.Provider value={{enabled, setEnabled}}>
      {enabled ? (
        <GestureDetector gesture={composedGesture}>
          <View style={{flex: 1}}>{children}</View>
        </GestureDetector>
      ) : (
        children
      )}
    </KonamiContext.Provider>
  )
}
