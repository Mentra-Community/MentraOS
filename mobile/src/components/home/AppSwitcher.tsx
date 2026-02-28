import React, {useCallback, useEffect} from "react"
import {View, Text, Image, Dimensions, Pressable} from "react-native"
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  Extrapolation,
  runOnJS,
  useDerivedValue,
} from "react-native-reanimated"
import {Gesture, GestureDetector} from "react-native-gesture-handler"

const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get("window")
const CARD_WIDTH = SCREEN_WIDTH * 0.65
const CARD_HEIGHT = SCREEN_HEIGHT * 0.65
const CARD_SPACING = 0
const DISMISS_THRESHOLD = -120
const VELOCITY_THRESHOLD = -800

interface AppCard {
  id: string
  name: string
  screenshot?: string
  icon?: string
  color?: string
}

interface AppCardItemProps {
  app: AppCard
  index: number
  activeIndex: Animated.SharedValue<number>
  onDismiss: (id: string) => void
  onSelect: (id: string) => void
  translateX: Animated.SharedValue<number>
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

function AppCardItem({app, index, activeIndex, translateX, onDismiss, onSelect}: AppCardItemProps) {
  const translateY = useSharedValue(0)
  const cardOpacity = useSharedValue(1)
  const cardScale = useSharedValue(1)

  const dismissCard = useCallback(() => {
    onDismiss(app.id)
  }, [app.id, onDismiss])

  const selectCard = useCallback(() => {
    onSelect(app.id)
  }, [app.id, onSelect])

  const panGesture = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .onUpdate((event) => {
      translateY.value = Math.min(0, event.translationY)
      const progress = Math.abs(translateY.value) / DISMISS_THRESHOLD
      // cardScale.value = interpolate(progress, [0, 1], [1, 0.95], Extrapolation.CLAMP)
      cardOpacity.value = interpolate(progress, [0, 1, 2], [1, 0.8, 0], Extrapolation.CLAMP)
    })
    .onEnd((event) => {
      const shouldDismiss = translateY.value < DISMISS_THRESHOLD || event.velocityY < VELOCITY_THRESHOLD

      if (shouldDismiss) {
        translateY.value = withTiming(-SCREEN_HEIGHT, {duration: 250})
        cardOpacity.value = withTiming(0, {duration: 200}, () => {
          runOnJS(dismissCard)()
        })
      } else {
        translateY.value = withSpring(0, {damping: 20, stiffness: 200, velocity: 200, overshootClamping: true})
        // cardScale.value = withSpring(1)
        cardOpacity.value = withSpring(1)
      }
    })

  const tapGesture = Gesture.Tap().onEnd(() => {
    runOnJS(selectCard)()
  })

  const composedGesture = Gesture.Exclusive(panGesture, tapGesture)

  const cardAnimatedStyle = useAnimatedStyle(() => {
    // const distance = Math.abs(index - activeIndex.value)
    // const distance = translateY.value
    // const scale = interpolate(distance, [0, 1, 2], [1, 0.92, 0.85], Extrapolation.CLAMP)
    // const opacity = interpolate(distance, [0, 2, 3], [1, 0.7, 0.4], Extrapolation.CLAMP)
    const opacity = 1

    let oneIndex = index + 1
    let oneActiveIndex = activeIndex.value + 1
    let count = 6
    let negativeIndex = count - (index + 1)
    // console.log("negativeIndex", negativeIndex)

    // card 6: start at -1600px
    // tX starts at -1600px
    let base = translateX.value
    let cardWidth = CARD_WIDTH + CARD_SPACING
    let totalWidth = (count - 1) * cardWidth
    let negativeBase = base + totalWidth
    let normalBase = negativeBase / cardWidth

    if (normalBase < 0) {
      normalBase = 0
    }

    // console.log("totalWidth", totalWidth)

    // console.log("base", base)

    let leftBase = base + negativeIndex * cardWidth

    // let res = leftBase - (negativeIndex * -base/10)
    let stat = leftBase - translateX.value - totalWidth

    // let res = stat + (negativeBase/(count-1) * index)

    // let res = stat + (negativeBase * index)

    // Non-linear version - use a power curve
    let progress = index / (count - 1) // 0 to 1

    // let nonLinearProgress = Math.pow(progress, 2) // < 1 = spread out more at the front
    // let res = stat + (Math.pow(normalBase, 2) * nonLinearProgress) * cardWidth

    let howFar = SCREEN_WIDTH / 4
    // let howFar = CARD_WIDTH / 2

    // let power = (Math.pow(normalBase, 1.25) * (index+1) * howFar) / count
    // let power = Math.pow(normalBase, 1.5) * howFar
    let lin = normalBase - negativeIndex
    // let lin = normalBase
    if (lin < 0) {
      lin = 0
    }
    // let power = Math.pow(lin, 1.5) * howFar * (index+1)/count
    let power = Math.pow(lin, 1.7) * howFar
    // let stepBehindPower = Math.pow(normalBase + negativeIndex, 1.5) * howFar

    // if (index == count - 1) {
    //   // stepBehindPower = 0
    // }
    // if (index == count - 2) {
    //   power = Math.pow(normalBase - 1, 1.5) * howFar
    // }
    // subtract the negative index so that start cards ar bunched up at the start:
    // let res = stat + (power - (Math.pow(negativeIndex, 1) * howFar))
    // console.log("power", power)
    // let diff = negativeIndex
    // let res = stat + (power / (Math.pow(diff, 4) + 1))
    let res = stat + power

    // console.log("res", res)
    // let res = stat + power

    // console.log("normalBase", normalBase)

    // let add = 0
    // if ()

    // console.log("negativeBase", negativeBase)

    // console.log(normalBase)

    //     let progress = index / (count - 1)
    // let linearPart = progress
    // let nonLinearPart = Math.pow(progress, 0.6) // < 1 spreads front cards, > 1 spreads back cards

    // let blend = 0.6 // 0 = fully linear, 1 = fully non-linear
    // let finalProgress = linearPart * (1 - blend) + nonLinearPart * blend

    // let res = stat + negativeBase * finalProgress
    // console.log("res", nonLinearProgress)

    // console.log("res", res)
    // console.log("leftBase", leftBase)

    // let res = base + (negativeIndex * cardWidth) - (negativeIndex * -base/10)

    return {
      transform: [
        // {perspective: 1000},
        {translateY: translateY.value},
        // {scale: cardScale.value * scale},
        // {translateX: -translateX.value / index},
        // {translateX: translateX.value},
        // the finger should center on the left side of the card, use the activeIndex and current index to dynamically speed up the card movement:
        // {translateX: -translateX.value / (activeIndex.value - index) + 1},
        {translateX: res},
        // {translateY: (index == activeIndex.value ? 0 : 1) * 300},
      ],
      opacity: cardOpacity.value * opacity,
    }
  })

  const bgColor = app.color || "#374151"

  return (
    <GestureDetector gesture={composedGesture}>
      <AnimatedPressable
        className="items-center"
        style={[
          {
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
          },
          cardAnimatedStyle,
        ]}>
        {/* Card Container with shadow */}
        <View className="flex-1 w-full rounded-3xl overflow-hidden bg-gray-800 shadow-2xl">
          {/* App Screenshot/Preview Area */}
          <View className="flex-1 rounded-3xl overflow-hidden" style={{backgroundColor: bgColor}}>
            {app.screenshot ? (
              <Image source={{uri: app.screenshot}} className="w-full h-full" resizeMode="cover" />
            ) : (
              <View className="flex-1 items-center justify-center">
                <Text className="text-white text-7xl font-light opacity-80">{app.name.charAt(0)}</Text>
              </View>
            )}

            {/* Status bar mockup */}
            <View className="absolute top-0 left-0 right-0 h-11 items-center justify-center">
              <Text className="text-white text-[15px] font-semibold">9:41</Text>
            </View>
          </View>

          {/* Swipe indicator */}
          <View className="absolute bottom-2 left-0 right-0 items-center">
            <View className="w-24 h-[5px] rounded-full bg-white/30" />
          </View>
        </View>

        {/* App Label Below Card */}
        <View className="mt-4 items-center gap-2">
          {app.icon ? (
            <Image source={{uri: app.icon}} className="w-12 h-12 rounded-xl" />
          ) : (
            <View className="w-12 h-12 rounded-xl items-center justify-center" style={{backgroundColor: bgColor}}>
              <Text className="text-white text-[22px] font-semibold">{app.name.charAt(0)}</Text>
            </View>
          )}
          <Text
            className="text-white text-[13px] font-medium text-center"
            style={{maxWidth: CARD_WIDTH * 0.8}}
            numberOfLines={1}>
            {app.name}
          </Text>
        </View>
      </AnimatedPressable>
    </GestureDetector>
  )
}

interface AppSwitcherProps {
  visible: boolean
  onClose: () => void
  apps: AppCard[]
  onAppSelect: (id: string) => void
  onAppDismiss: (id: string) => void
}

export default function AppSwitcher({visible, onClose, apps, onAppSelect, onAppDismiss}: AppSwitcherProps) {
  const translateX = useSharedValue(0)
  const offsetX = useSharedValue(0)
  const activeIndex = useSharedValue(0)
  const backdropOpacity = useSharedValue(0)
  const containerTranslateY = useSharedValue(100)
  const containerOpacity = useSharedValue(0)

  useEffect(() => {
    if (visible) {
      backdropOpacity.value = withTiming(1, {duration: 250})
      containerTranslateY.value = withSpring(0, {damping: 20, stiffness: 2000, velocity: 100, overshootClamping: true})
      containerOpacity.value = withTiming(1, {duration: 200})
      // translateX.value = 0
      // activeIndex.value = 0
      // start at the end of the cards:
      // translateX.value = -((apps.length - 1) * (CARD_WIDTH + CARD_SPACING))
      translateX.value = -((apps.length - 2) * CARD_WIDTH)
      activeIndex.value = apps.length
    } else {
      backdropOpacity.value = withTiming(0, {duration: 200})
      containerTranslateY.value = withTiming(100, {duration: 200})
      containerOpacity.value = withTiming(0, {duration: 150})
    }
  }, [visible])

  useDerivedValue(() => {
    activeIndex.value = -translateX.value / (CARD_WIDTH + CARD_SPACING) + 2
  })

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }))

  const containerStyle = useAnimatedStyle(() => ({
    transform: [{translateY: containerTranslateY.value}],
    opacity: containerOpacity.value,
  }))

  const cardsContainerStyle = useAnimatedStyle(() => ({
    transform: [{translateX: translateX.value}],
  }))

  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onStart(() => {
      offsetX.value = translateX.value
    })
    .onUpdate((event) => {
      const newTranslateX = offsetX.value + event.translationX
      const maxTranslate = 0
      const minTranslate = -((apps.length - 1) * (CARD_WIDTH + CARD_SPACING))

      // if (newTranslateX > maxTranslate) {
      //   translateX.value = newTranslateX * 0.3
      // } else if (newTranslateX < minTranslate) {
      //   translateX.value = minTranslate + (newTranslateX - minTranslate) * 0.9
      // } else {
      //   translateX.value = newTranslateX
      // }
      translateX.value = newTranslateX
    })
    .onEnd((event) => {
      const cardWidth = CARD_WIDTH + CARD_SPACING
      const velocity = event.velocityX

      let targetIndex = Math.round(-translateX.value / cardWidth)

      if (Math.abs(velocity) > 500) {
        targetIndex = velocity > 0 ? targetIndex - 1 : targetIndex + 1
      }

      targetIndex = Math.max(-1, Math.min(targetIndex, apps.length + 1))

      translateX.value = withSpring(-targetIndex * cardWidth, {
        damping: 20,
        stiffness: 90,
        velocity: velocity,
      })
    })

  const handleDismiss = useCallback(
    (id: string) => {
      onAppDismiss(id)
    },
    [onAppDismiss],
  )

  const handleSelect = useCallback(
    (id: string) => {
      onAppSelect(id)
      onClose()
    },
    [onAppSelect, onClose],
  )

  if (!visible && containerOpacity.value === 0) {
    return null
  }

  return (
    <View className="absolute -mx-6 inset-0 z-[1000]" pointerEvents={visible ? "auto" : "none"}>
      {/* Blurred Backdrop */}
      <Animated.View className="absolute inset-0 bg-black/30" style={backdropStyle}>
        <Pressable className="flex-1" onPress={onClose} />
      </Animated.View>

      {/* Main Container */}
      <Animated.View className="flex-1 justify-center" style={containerStyle}>
        {/* Header hint */}
        <View className="absolute top-[60px] left-0 right-0 items-center">
          <Text className="text-white/50 text-sm font-medium">Swipe up to close apps</Text>
        </View>

        {/* Cards Carousel */}
        {apps.length > 0 ? (
          <GestureDetector gesture={panGesture}>
            <Animated.View className="flex-1 justify-center">
              <Animated.View
                className="flex-row items-center"
                // style={[{paddingHorizontal: (SCREEN_WIDTH - CARD_WIDTH) / 2 - CARD_SPACING / 2}, cardsContainerStyle]}>
                // style={cardsContainerStyle}>
                // {/* // style={{transform: [{translateX: translateX.value}]}}> */}
                // {/* // style={useAnimatedStyle(() => ({ */}
                // {/* //   transform: [{translateX: translateX.value}], */}
                // {/* // }))}> */}
              >
                {apps.map((app, index) => (
                  <AppCardItem
                    key={app.id}
                    app={app}
                    index={index}
                    activeIndex={activeIndex}
                    translateX={translateX}
                    onDismiss={handleDismiss}
                    onSelect={handleSelect}
                  />
                ))}
              </Animated.View>
            </Animated.View>
          </GestureDetector>
        ) : (
          <View className="flex-1 items-center justify-center">
            <Text className="text-white text-[22px] font-semibold mb-2">No Apps Open</Text>
            <Text className="text-white/50 text-base">Your recently used apps will appear here</Text>
          </View>
        )}

        {/* Page Indicators */}
        {apps.length > 1 && (
          <View className="flex-row justify-center items-center gap-1.5 mb-5">
            {apps.map((_, index) => (
              <PageDot key={index} index={index} activeIndex={activeIndex} />
            ))}
          </View>
        )}

        {/* Close Button */}
        <Pressable className="absolute bottom-[50px] self-center bg-white/15 px-8 py-3.5 rounded-3xl" onPress={onClose}>
          <Text className="text-white text-[17px] font-semibold">Done</Text>
        </Pressable>
      </Animated.View>
    </View>
  )
}

function PageDot({index, activeIndex}: {index: number; activeIndex: Animated.SharedValue<number>}) {
  const dotStyle = useAnimatedStyle(() => {
    const isActive = Math.abs(activeIndex.value - 1 - index) < 0.5
    return {
      width: withSpring(isActive ? 24 : 8),
      opacity: withTiming(isActive ? 1 : 0.4),
    }
  })

  return <Animated.View className="h-2 rounded-full bg-white" style={dotStyle} />
}

export type {AppCard}
