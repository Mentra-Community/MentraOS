import {useEffect, useState, useRef} from "react"
import {Platform, View} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"

import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {BackgroundTimer} from "@/utils/timers"

type Direction = "up" | "down" | "left" | "right"

const KONAMI_CODE: Direction[] = ["up", "up", "down", "down", "left", "right", "left", "right"]
const MINI_CODE: Direction[] = ["up", "up", "down", "down", "left", "left", "right", "right", "up", "up"]
const MAX_CODE_LENGTH = Math.max(KONAMI_CODE.length, MINI_CODE.length)

export function KonamiCodeProvider({children}: {children: React.ReactNode}) {
  const [sequence, setSequence] = useState<Direction[]>([])
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const {goHomeAndPush} = useNavigationHistory()

  useEffect(() => {
    if (sequence.length === KONAMI_CODE.length) {
      const matches = sequence.every((dir, i) => dir === KONAMI_CODE[i])
      if (matches) {
        console.log("KONAMI: Konami code activated!")
        goHomeAndPush("/settings/developer")
        setSequence([])
      }
    }
    if (sequence.length === MINI_CODE.length) {
      const matches = sequence.every((dir, i) => dir === MINI_CODE[i])
      if (matches) {
        console.log("KONAMI: Mini code activated!")
        setSequence([])
      }
    }
  }, [sequence, goHomeAndPush])

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
    }, 3000)
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
    <GestureDetector gesture={composedGesture}>
      <View style={{flex: 1}}>{children}</View>
    </GestureDetector>
  )
}
