import {createContext, useContext, useEffect, useMemo, useRef, useState} from "react"
import {Platform, View} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"

import {useNavigationStore} from "@/stores/navigation"
import {BgTimer} from "@mentra/island"

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
  const enabledRef = useRef(enabled)
  const sequenceRef = useRef<Direction[]>([])
  const resetTimeoutRef = useRef<number | null>(null)
  const {goHomeAndPush} = useNavigationStore.getState()

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) {
        BgTimer.clearTimeout(resetTimeoutRef.current)
      }
    }
  }, [])

  const addDirectionRef = useRef((direction: Direction) => {
    if (!enabledRef.current) return

    console.log("KONAMI: Swipe detected:", direction)

    const newSequence = [...sequenceRef.current, direction].slice(-MAX_CODE_LENGTH)
    sequenceRef.current = newSequence

    const matchesCode = (code: Direction[]) =>
      newSequence.length >= code.length &&
      code.every((dir, i) => dir === newSequence[newSequence.length - code.length + i])

    if (matchesCode(KONAMI_CODE)) {
      console.log("KONAMI: Konami code activated!")
      goHomeAndPush("/miniapps/settings/developer")
      sequenceRef.current = []
    } else if (matchesCode(MINI_CODE)) {
      console.log("KONAMI: Mini code activated!")
      sequenceRef.current = []
    } else if (matchesCode(SUPER_CODE)) {
      console.log("KONAMI: Super code activated!")
      goHomeAndPush("/miniapps/settings/super")
      sequenceRef.current = []
    }

    if (resetTimeoutRef.current) {
      BgTimer.clearTimeout(resetTimeoutRef.current)
    }

    resetTimeoutRef.current = BgTimer.setTimeout(() => {
      sequenceRef.current = []
    }, 8000)
  })

  const composedGesture = useMemo(() => {
    const addDirection = (direction: Direction) => addDirectionRef.current(direction)

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

    return Gesture.Simultaneous(Gesture.Race(flingUp, flingDown, flingLeft, flingRight))
  }, [])

  const contextValue = useMemo(() => ({enabled, setEnabled}), [enabled])

  if (!enabled) {
    return <KonamiContext.Provider value={contextValue}>{children}</KonamiContext.Provider>
  }

  return (
    <KonamiContext.Provider value={contextValue}>
      <GestureDetector gesture={composedGesture}>
        <View style={{flex: 1}}>{children}</View>
      </GestureDetector>
    </KonamiContext.Provider>
  )
}
