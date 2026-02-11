import React, {useCallback, useEffect, useMemo, useState} from "react"
import {View, Dimensions, Pressable, Image, TouchableOpacity} from "react-native"
import {Text} from "@/components/ignite/"
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
import {ClientAppletInterface} from "@/stores/applets"
import AppIcon from "@/components/home/AppIcon"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useSafeAreaInsets} from "react-native-safe-area-context"

const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get("window")
const CARD_WIDTH = SCREEN_WIDTH * 0.67
const CARD_HEIGHT = SCREEN_HEIGHT * 0.67
const CARD_SPACING = 0
const DISMISS_THRESHOLD = -180
const VELOCITY_THRESHOLD = -800

let DUMMY_APPS: ClientAppletInterface[] = [
  {
    packageName: "com.example.weather",
    name: "Weather",
    type: "standard",
    webviewUrl: "",
    logoUrl: "",
    permissions: [],
    running: true,
    loading: false,
    healthy: true,
    hardwareRequirements: [],
    offline: true,
    offlineRoute: "",
    local: false,
  },
  {
    packageName: "com.example.notes",
    name: "Notes",
    type: "standard",
    webviewUrl: "",
    logoUrl: "",
    permissions: [],
    running: true,
    loading: false,
    healthy: true,
    hardwareRequirements: [],
    offline: true,
    offlineRoute: "",
    local: false,
  },
  {
    packageName: "com.example.music",
    name: "Music",
    type: "standard",
    webviewUrl: "",
    logoUrl: "",
    permissions: [],
    running: true,
    loading: false,
    healthy: true,
    hardwareRequirements: [],
    offline: true,
    offlineRoute: "",
    local: false,
  },
  {
    packageName: "com.example.camera",
    name: "Camera",
    type: "standard",
    webviewUrl: "",
    logoUrl: "",
    permissions: [],
    running: true,
    loading: false,
    healthy: true,
    hardwareRequirements: [],
    offline: true,
    offlineRoute: "",
    local: false,
  },
  {
    packageName: "com.example.maps",
    name: "Maps",
    type: "standard",
    webviewUrl: "",
    logoUrl: "",
    permissions: [],
    running: true,
    loading: false,
    healthy: true,
    hardwareRequirements: [],
    offline: true,
    offlineRoute: "",
    local: false,
  },
]

for (let i = 0; i < 10; i++) {
  DUMMY_APPS.push({
    packageName: `com.example.dummy.${i + 1}.test`,
    name: `App ${i}`,
    type: "standard",
    webviewUrl: "",
    logoUrl: "",
    permissions: [],
    running: true,
    loading: false,
    healthy: true,
    hardwareRequirements: [],
    offline: true,
    offlineRoute: "",
    local: false,
  })
}

interface AppCard {
  id: string
  name: string
  icon?: string
  color?: string
}

interface AppCardItemProps {
  app: ClientAppletInterface
  index: number
  onDismiss: (packageName: string) => void
  onSelect: (packageName: string) => void
  translateX: Animated.SharedValue<number>
  count: number
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

const AppCardItem = function AppCardItem({app, index, translateX, onDismiss, onSelect, count}: AppCardItemProps) {
  const translateY = useSharedValue(0)
  const cardOpacity = useSharedValue(0)
  const isDismissed = useSharedValue(false)
  const indexSV = useSharedValue(9999999)
  const animatedIndex = useSharedValue(9999)

  // Update the shared value without causing gesture recreation
  useEffect(() => {
    // setTimeout(() => {
    console.log("indexSV", index)
    setTimeout(() => {
      // indexSV.value = index
    }, 4000)
    // }, 1000)
  }, [index])

  console.log("MOUNT", app.packageName, index)

  useEffect(() => {
    setTimeout(() => {
      // animatedIndex.value = withSpring(index, {damping: 20, stiffness: 90})
    }, 8000)
  }, [index])

  useEffect(() => {
    indexSV.value = index
    if (animatedIndex.value !== index) {
      // animatedIndex.value = withSpring(index, {damping: 20, stiffness: 90})
      // animatedIndex.value = 1000
      cardOpacity.value = 0

      setTimeout(() => {
        animatedIndex.value = index+1
        animatedIndex.value = withSpring(index, {damping: 20, stiffness: 90})
      }, 2000)
    }

    cardOpacity.value = withTiming(1, {duration: 2000})
    // animatedIndex.value = 1000

  }, [count])

  // Use refs so gestures never need to be recreated
  const onDismissRef = React.useRef(onDismiss)
  onDismissRef.current = onDismiss
  const onSelectRef = React.useRef(onSelect)
  onSelectRef.current = onSelect

  const dismissCard = useCallback(() => {
    onDismissRef.current(app.packageName)
  }, [app.packageName])

  const selectCard = useCallback(() => {
    onSelectRef.current(app.packageName)
  }, [app.packageName])

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY([-10, 10])
        .onUpdate((event) => {
          translateY.value = event.translationY
          const progress = translateY.value / DISMISS_THRESHOLD
          cardOpacity.value = interpolate(progress, [0, 0.7, 2], [1, 0.8, 0], Extrapolation.CLAMP)
        })
        .onEnd((event) => {
          const shouldDismiss = translateY.value < DISMISS_THRESHOLD || event.velocityY < VELOCITY_THRESHOLD
          if (shouldDismiss) {
            isDismissed.value = true
            translateY.value = withTiming(-SCREEN_HEIGHT, {duration: 250})
            cardOpacity.value = withTiming(0, {duration: 200}, () => {
              runOnJS(dismissCard)()
            })
          } else {
            translateY.value = withSpring(0, {damping: 200, stiffness: 1000, velocity: 2})
            cardOpacity.value = withSpring(1)
          }
        }),
    [dismissCard], // dismissCard is now stable (only depends on packageName)
  )

  const tapGesture = useMemo(() => Gesture.Tap().onEnd(() => runOnJS(selectCard)()), [selectCard])

  const composedGesture = useMemo(() => Gesture.Exclusive(panGesture, tapGesture), [panGesture, tapGesture])

  const cardAnimatedStyle = useAnimatedStyle(() => {
    // if (isDismissed.value) {
    //   return {
    //     transform: [{translateY: -SCREEN_HEIGHT}, {scale: 1}, {translateX: 0}],
    //     opacity: 0,
    //   }
    // }
    let animIndex = animatedIndex.value

    let cardWidth = CARD_WIDTH + CARD_SPACING
    // let stat = -index * cardWidth
    // let inter = Math.abs(animIndex - index)
    // console.log("inter", inter)
    // let stat
    // if (inter > 0.99) {
    //   console.log("@@@@@@@@@@@@@@@@@@@@@@@@@@@")
    //   // animIndex = index
    //   // stat = -index * cardWidth
    //   stat = 99999999999
    // } else {
    //   // let stat = -animIndex * cardWidth
    //   stat = -animIndex * cardWidth
    // }
    let stat = -indexSV.value * cardWidth

    let howFar = SCREEN_WIDTH / 4
    let lin = translateX.value / cardWidth + animIndex
    if (lin < 0) {
      lin = 0
    }
    let power = Math.pow(lin, 1.7) * howFar
    // let offset = 12 * animIndex
    let res = stat + power

    let howFarPercent = (1 / (howFar / SCREEN_WIDTH)) * howFar
    let linearProgress = power / howFarPercent
    let scale = interpolate(linearProgress, [0, 0.8], [0.96, 1], Extrapolation.CLAMP)
    // account for scaling of the card:
    let offset = (1 - scale) * cardWidth
    // res = stat + animIndex * cardWidth + translateX.value
    scale = 1

    console.log("res", index, res)

    // if (overrideValue.value > 0.1) {
    //   // res = lastValue.value
    //   res = stat + 100
    // }

    // lastValue.value = res

    return {
      transform: [{translateY: translateY.value}, {scale: scale}, {translateX: res}],
      opacity: cardOpacity.value,
    }
  })

  return (
    <GestureDetector gesture={composedGesture}>
      <AnimatedPressable
        className="items-start"
        style={[
          {
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
          },
          cardAnimatedStyle,
        ]}>
        <View className="flex-1 rounded-3xl overflow-hidden w-full shadow-2xl bg-primary-foreground">
          <View className="pl-6 h-12 gap-2 justify-start w-full flex-row items-center bg-primary-foreground">
            <AppIcon app={app} style={{width: 32, height: 32, borderRadius: 8}} />
            <Text className="text-foreground text-md font-medium text-center" numberOfLines={1}>
              {app.name}
            </Text>
          </View>

          {!app.screenshot && (
            <View className="flex-1 items-center justify-center">
              <AppIcon app={app} style={{width: 48, height: 48}} />
            </View>
          )}

          {app.screenshot && (
            <View className="flex-1 items-center justify-center">
              <Image
                source={{uri: app.screenshot}}
                className="w-full h-full"
                style={{resizeMode: "cover"}}
                blurRadius={3}
              />
            </View>
          )}
        </View>

        <View className="absolute bottom-2 left-0 right-0 items-center">
          <View className="w-24 h-[5px] rounded-full bg-white/30" />
        </View>
      </AnimatedPressable>
    </GestureDetector>
  )
}

interface AppSwitcherProps {
  visible: boolean
  onClose: () => void
}

export default function AppSwitcher({visible, onClose}: AppSwitcherProps) {
  const translateX = useSharedValue(0)
  const offsetX = useSharedValue(0)
  const activeIndex = useSharedValue(0)
  const backdropOpacity = useSharedValue(0)
  const containerTranslateY = useSharedValue(100)
  const containerOpacity = useSharedValue(0)
  const targetIndex = useSharedValue(0)
  const prevTranslationX = useSharedValue(0)
  const {push} = useNavigationHistory()
  const insets = useSafeAreaInsets()

  const [apps, setApps] = useState<ClientAppletInterface[]>(DUMMY_APPS)

  const appsLengthSV = useSharedValue(apps.length)

  useEffect(() => {
    appsLengthSV.value = apps.length
  }, [apps.length])

  useEffect(() => {
    if (visible) {
      backdropOpacity.value = withTiming(1, {duration: 250})
      containerTranslateY.value = withSpring(0, {damping: 20, stiffness: 2000, velocity: 100, overshootClamping: true})
      containerOpacity.value = withTiming(1, {duration: 200})
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

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-10, 10])
        .onStart(() => {
          offsetX.value = translateX.value
          prevTranslationX.value = 0
        })
        .onUpdate((event) => {
          translateX.value = offsetX.value + event.translationX
        })
        .onEnd((event) => {
          const cardWidth = CARD_WIDTH + CARD_SPACING
          const velocity = event.velocityX

          let newTarget = Math.round(-translateX.value / cardWidth)

          if (Math.abs(velocity) > 500) {
            newTarget = velocity > 0 ? newTarget - 1 : newTarget + 1
          }

          // Use a worklet-safe approach — apps.length can be stale here
          // so pass it via a shared value instead
          newTarget = Math.max(-1, Math.min(newTarget, appsLengthSV.value - 2))

          targetIndex.value = newTarget

          translateX.value = withSpring(-newTarget * cardWidth, {
            damping: 20,
            stiffness: 90,
            velocity: velocity,
          })
        }),
    [], // stable — never recreated
  )

  const handleDismiss = useCallback((packageName: string) => {
    const lastApp = apps[apps.length - 1]
    // if (lastApp.packageName === packageName) {
    //   goToIndex(apps.length - 2)
    // }

    // setTimeout(() => {
      setApps((prev) => prev.filter((a) => a.packageName !== packageName))
    // }, 1000)

    if (apps.length === 1) {
      setApps(DUMMY_APPS)
    }
  }, [])

  const handleSelect = useCallback(
    (packageName: string) => {
      console.log("selecting", packageName)
      onClose()
    },
    [onClose],
  )

  const [shouldRender, setShouldRender] = useState(visible)

  useEffect(() => {
    if (visible) {
      setShouldRender(true)
    }
  }, [visible])

  // In your close animation, set shouldRender to false after it completes:
  useEffect(() => {
    if (!visible) {
      backdropOpacity.value = withTiming(0, {duration: 200})
      containerTranslateY.value = withTiming(100, {duration: 200})
      containerOpacity.value = withTiming(0, {duration: 150}, () => {
        runOnJS(setShouldRender)(false)
      })
    }
  }, [visible])

  // if (!shouldRender) {
  //   return null
  // }

  console.log("shouldRender", Math.random())

  return (
    <View
      className="absolute -mx-6 inset-0 z-[1000]"
      pointerEvents={visible ? "auto" : "none"}
      style={{paddingBottom: insets.bottom}}>
      <Animated.View className="absolute inset-0 bg-black/70" style={backdropStyle}>
        <Pressable className="flex-1" onPress={onClose} />
      </Animated.View>

      <Animated.View className="flex-1 justify-center" style={containerStyle}>
        {apps.length == 0 && (
          <View className="flex-1 items-center justify-center">
            <Text className="text-white text-[22px] font-semibold mb-2" tx="appSwitcher:noAppsOpen" />
            <Text className="text-white/50 text-base" tx="appSwitcher:yourRecentlyUsedAppsWillAppearHere" />
          </View>
        )}

        <GestureDetector gesture={panGesture}>
          <Animated.View className="flex-1 justify-center" pointerEvents="box-none">
            <Pressable className="absolute inset-0" onPress={onClose} />
            <Animated.View className="flex-row items-center" pointerEvents="box-none">
              {apps.map((app, index) => (
                <AppCardItem
                  key={app.packageName}
                  app={app}
                  onDismiss={handleDismiss}
                  onSelect={handleSelect}
                  count={apps.length}
                  translateX={translateX}
                  index={index}
                />
              ))}
            </Animated.View>
          </Animated.View>
        </GestureDetector>

        {/* Add a button to remove the current app: */}
        <Pressable
          className="absolute bottom-2 right-2"
          onPress={() => {
            handleDismiss(apps[apps.length - 2].packageName)
          }}>
          <Text className="text-white text-base">Add App</Text>
        </Pressable>

        {apps.length > 0 && (
          <View className="flex-row justify-center items-center gap-1.5 mb-5">
            {apps.map((_, index) => (
              <PageDot key={index} index={index} activeIndex={activeIndex} />
            ))}
          </View>
        )}
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
