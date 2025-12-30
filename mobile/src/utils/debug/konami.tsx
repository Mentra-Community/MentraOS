import {useEffect, useState, useRef} from "react"
import {View} from "react-native"
import {Gesture, GestureDetector} from "react-native-gesture-handler"

import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {BackgroundTimer} from "@/utils/timers"

type Direction = "up" | "down" | "left" | "right"

const KONAMI_CODE: Direction[] = ["up", "up", "down", "down", "left", "right", "left", "right"]

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
  }, [sequence, goHomeAndPush])

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current) {
        BackgroundTimer.clearTimeout(resetTimeoutRef.current)
      }
    }
  }, [])

  const addDirection = (direction: Direction) => {
    // console.log("KONAMI: Swipe detected:", direction)

    setSequence(prev => {
      const newSequence = [...prev, direction]
      return newSequence.slice(-KONAMI_CODE.length)
    })

    if (resetTimeoutRef.current) {
      BackgroundTimer.clearTimeout(resetTimeoutRef.current)
    }

    resetTimeoutRef.current = BackgroundTimer.setTimeout(() => {
      setSequence([])
    }, 3000)
  }

  const flingUp = Gesture.Fling()
    .direction(1) // Up
    .onEnd(() => addDirection("right"))
    .runOnJS(true)

  const flingDown = Gesture.Fling()
    .direction(2) // Down
    .onEnd(() => addDirection("left"))
    .runOnJS(true)

  const flingLeft = Gesture.Fling()
    .direction(4) // Left
    .onEnd(() => addDirection("up"))
    .runOnJS(true)

  const flingRight = Gesture.Fling()
    .direction(8) // Right
    .onEnd(() => addDirection("down"))
    .runOnJS(true)

  const composedGesture = Gesture.Simultaneous(Gesture.Race(flingUp, flingDown, flingLeft, flingRight))

  return (
    <GestureDetector gesture={composedGesture}>
      <View style={{flex: 1}}>{children}</View>
    </GestureDetector>
  )
}
