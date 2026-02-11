import React, {useCallback, useEffect, useMemo} from "react"
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
import {ClientAppletInterface, useActiveAppPackageNames, useActiveApps, useAppletStatusStore} from "@/stores/applets"
import AppIcon from "@/components/home/AppIcon"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useSafeAreaInsets} from "react-native-safe-area-context"

const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get("window")
const CARD_WIDTH = SCREEN_WIDTH * 0.67
const CARD_HEIGHT = SCREEN_HEIGHT * 0.67
const CARD_SPACING = 0
const DISMISS_THRESHOLD = -180
const VELOCITY_THRESHOLD = -800

interface AppCard {
  id: string
  name: string
  icon?: string
  color?: string
}

interface AppCardItemProps {
  app: ClientAppletInterface
  index: number
  // activeIndex: Animated.SharedValue<number>
  onDismiss: (packageName: string) => void
  onSelect: (packageName: string) => void
  translateX: Animated.SharedValue<number>
  count: number
  hidden: boolean
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

function AppCardItem({
  app,
  index,
  // activeIndex,
  count,
  translateX,
  hidden,
  onDismiss,
  onSelect,
}: AppCardItemProps) {
  const translateY = useSharedValue(0)
  const cardOpacity = useSharedValue(1)
  const animatedIndex = useSharedValue(index)
  const indexSv = useSharedValue(index)
  // const cardScale = useSharedValue(1)

  useEffect(() => {
    // animatedIndex.value = withSpring(index, {damping: 20, stiffness: 90})
  }, [count])

  useEffect(() => {
    // setTimeout(() => {
    // indexSv.value = index
    // }, 1000)
  }, [index])
  

  useEffect(() => {
    if (hidden) {
      cardOpacity.value = 0.1
    } else {
      cardOpacity.value = 1
    }
  }, [hidden])

  useEffect(() => {
    // animatedIndex.value = 0
    // animatedIndex.value = withTiming(0, {duration: 500})
    // setTimeout(() => {
    // animatedIndex.value = withSpring(index, {damping: 20, stiffness: 90})
    // }, 1000)
    // cardOpacity.value = 0.1
    // indexSv.value = index+1
    // animatedIndex.value = index+1
    // setTimeout(() => {
      // cardOpacity.value = 1
      indexSv.value = index
      // indexSv.value = withTiming(index, {duration: 5000})
      // animatedIndex.value = index+1
      animatedIndex.value = withSpring(index, {damping: 20, stiffness: 90})
    // }, 2500)
    // setTimeout(() => {
    //   animatedIndex.value = withTiming(index, {duration: 500})
    // }, 1000)
  }, [count])

  const dismissCard = useCallback(() => {
    onDismiss(app.packageName)
  }, [app.packageName, onDismiss])

  const selectCard = useCallback(() => {
    onSelect(app.packageName)
  }, [app.packageName, onSelect])

  const panGesture = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .onUpdate((event) => {
      // translateY.value = Math.min(0, event.translationY)
      translateY.value = event.translationY
      const progress = translateY.value / DISMISS_THRESHOLD
      // console.log("progress", translateY.value, progress)
      // cardScale.value = interpolate(progress, [0, 1], [1, 0.95], Extrapolation.CLAMP)
      cardOpacity.value = interpolate(progress, [0, 0.7, 2], [1, 0.8, 0], Extrapolation.CLAMP)
    })
    .onEnd((event) => {
      const shouldDismiss = translateY.value < DISMISS_THRESHOLD || event.velocityY < VELOCITY_THRESHOLD

      if (shouldDismiss) {
        translateY.value = withTiming(-SCREEN_HEIGHT, {duration: 250})
        cardOpacity.value = withTiming(0, {duration: 200}, () => {
          runOnJS(dismissCard)()
        })
      } else {
        translateY.value = withSpring(0, {damping: 200, stiffness: 1000, velocity: 2})
        // cardScale.value = withSpring(1)
        cardOpacity.value = withSpring(1)
      }
    })

  const tapGesture = Gesture.Tap().onEnd(() => {
    runOnJS(selectCard)()
  })

  const composedGesture = Gesture.Exclusive(panGesture, tapGesture)

  const cardAnimatedStyle = useAnimatedStyle(() => {
    let animIndex = animatedIndex.value
    let realIndex = indexSv.value

    let cardWidth = CARD_WIDTH + CARD_SPACING
    // let stat = -animIndex * cardWidth
    let stat = -realIndex * cardWidth // use real index for stat!!

    let howFar = SCREEN_WIDTH / 4
    let lin = translateX.value / cardWidth + animIndex
    if (lin < 0) {
      lin = 0
    }
    let power = Math.pow(lin, 1.7) * howFar
    let res = stat + power

    let howFarPercent = (1 / (howFar / SCREEN_WIDTH)) * howFar
    let linearProgress = power / howFarPercent
    let scale = interpolate(linearProgress, [0, 0.8], [0.96, 1], Extrapolation.CLAMP)
    // account for scaling of the card:
    let offset = (1 - scale) * cardWidth
    res = res - offset * animIndex

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
            height: CARD_HEIGHT, // - 16,
            // zIndex: -index,// to reverse stack order
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

        {/* Swipe indicator */}
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
  const apps = useActiveApps()
  const hiddenIndex = useSharedValue(0)

  // const activePackageNames = useActiveAppPackageNames()
  // const apps = useMemo(() => {
  //   return useAppletStatusStore.getState().apps.filter((a) => activePackageNames.includes(a.packageName))
  // }, [activePackageNames])

  useEffect(() => {
    if (visible) {
      backdropOpacity.value = withTiming(1, {duration: 250})
      containerTranslateY.value = withSpring(0, {damping: 20, stiffness: 2000, velocity: 100, overshootClamping: true})
      containerOpacity.value = withTiming(1, {duration: 200})
      // start at the end of the cards:
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

  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onStart(() => {
      offsetX.value = translateX.value
      prevTranslationX.value = 0
    })
    .onUpdate((event) => {
      // const getScreenPositionByIndex = (tx: number, index: number) => {
      //   const cardWidth = CARD_WIDTH + CARD_SPACING
      //   let howFar = SCREEN_WIDTH / 4
      //   let lin = tx / cardWidth + index
      //   if (lin < 0) {
      //     lin = 0
      //   }
      //   const power = Math.pow(lin, 1.7) * howFar
      //   // const res = stat + power
      //   const howFarPercent = (1 / (howFar / SCREEN_WIDTH)) * howFar
      //   const screenPosition = power / howFarPercent
      //   return screenPosition
      // }

      // const getMult = (newX: number) => {
      //   let mult = 1

      //   // if (event.velocityX > 0) {
      //   //   return mult
      //   // }

      //   // get a list of the screen positions of the cards:
      //   const screenPositions = []
      //   for (let i = 0; i < apps.length; i++) {
      //     screenPositions.push(getScreenPositionByIndex(newX, i))
      //   }
      //   const touchPosition = event.absoluteX / SCREEN_WIDTH
      //   // find the index of the card that is > touchPosition or touchPosition is within 10% of the card:
      //   let magnetPos = -1
      //   let diff = -1
      //   // console.log("touchPosition", touchPosition)
      //   for (let i = 0; i < screenPositions.length; i++) {
      //     diff = screenPositions[i] - touchPosition
      //     // console.log("screenPositions[i]", screenPositions[i])
      //     // console.log("diff", diff)
      //     if (screenPositions[i] > touchPosition || (diff < 0.15 && diff > -0.15)) {
      //       magnetPos = screenPositions[i]
      //       break
      //     }
      //   }
      //   if (magnetPos == -1) {
      //     return mult
      //   }
      //   // if (diff < 0 && event.velocityX > 0) {
      //   //   return 0.5
      //   // }
      //   if (event.velocityX < 0) {
      //     // the more negative, the closer to 0 the multiplier should be
      //     // the more positive, it should be log
      //     // console.log("diff", diff)
      //     if (diff < 0) {
      //       // return 1/(Math.abs(diff))
      //       return 0.8
      //     }
      //     // return Math.pow(Math.abs(diff), 3)
      //     return 3
      //     // return 3
      //   }
      //   // const direction = Math.sign(event.velocityX)
      //   // const alignment = diff * direction
      //   // return interpolate(alignment, [-1, 0, 1], [0.5, 1, 3], Extrapolation.CLAMP)

      //   // mult = (diff + 1) * 3
      //   return mult
      // }
      // const delta = event.translationX - prevTranslationX.value
      // prevTranslationX.value = event.translationX
      // // console.log("delta, velocityX", delta, event.velocityX)

      // const newTranslateX = offsetX.value + prevTranslationX.value + delta

      // let mult = getMult(newTranslateX)
      // let final = offsetX.value + delta * mult
      // translateX.value = final
      // offsetX.value = final

      // old way:
      translateX.value = offsetX.value + event.translationX
    })
    .onEnd((event) => {
      const cardWidth = CARD_WIDTH + CARD_SPACING
      const velocity = event.velocityX

      let newTarget = Math.round(-translateX.value / cardWidth)

      if (Math.abs(velocity) > 500) {
        newTarget = velocity > 0 ? newTarget - 1 : newTarget + 1
      }

      newTarget = Math.max(-1, Math.min(newTarget, apps.length - 2))

      targetIndex.value = newTarget

      translateX.value = withSpring(-newTarget * cardWidth, {
        damping: 20,
        stiffness: 90,
        velocity: velocity,
      })
    })

  const handleDismiss = useCallback(
    (packageName: string) => {
      let lastApp = apps[apps.length - 1]
      // Adjust if we were on the last card
      if (lastApp.packageName === packageName) {
        goToIndex(apps.length - 2)
      }
      // get the index of the packageName being dismissed:
      const index = apps.findIndex((app) => app.packageName === packageName)
      hiddenIndex.value = index
      setTimeout(() => {
        hiddenIndex.value = -1
      }, 1000)

      setTimeout(() => {
        useAppletStatusStore.getState().stopApplet(packageName)
      }, 100)
    },
    [apps.length],
  )

  const goToIndex = useCallback(
    (index: number) => {
      index = index - 1
      const cardWidth = CARD_WIDTH + CARD_SPACING
      const clamped = Math.max(-1, Math.min(index, apps.length - 2))
      targetIndex.value = clamped
      translateX.value = withSpring(-clamped * cardWidth, {
        damping: 20,
        stiffness: 90,
      })
    },
    [apps.length],
  )

  const handleSelect = (packageName: string) => {
    console.log("selecting", packageName)

    const applet = apps.find((app) => app.packageName === packageName)
    if (!applet) {
      console.error("SWITCH: no applet found!")
      return
    }

    // Handle offline apps - navigate directly to React Native route
    if (applet.offline && applet.offlineRoute) {
      push(applet.offlineRoute, {transition: "fade"})
    } else if (applet.webviewUrl && applet.healthy) {
      push("/applet/webview", {
        webviewURL: applet.webviewUrl,
        appName: applet.name,
        packageName: applet.packageName,
        transition: "fade",
      })
    } else {
      push("/applet/settings", {
        packageName: applet.packageName,
        appName: applet.name,
        transition: "fade",
      })
    }

    onClose()
  }

  if (!visible && containerOpacity.value === 0) {
    return null
  }

  // console.log("apps", apps.map((app) => app.packageName))

  return (
    <View
      className="absolute -mx-6 inset-0 z-[1000]"
      pointerEvents={visible ? "auto" : "none"}
      style={{paddingBottom: insets.bottom}}>
      {/* Blurred Backdrop */}
      <Animated.View className="absolute inset-0 bg-black/70" style={backdropStyle}>
        <Pressable className="flex-1" onPress={onClose} />
      </Animated.View>

      {/* Main Container */}
      <Animated.View className="flex-1 justify-center" style={containerStyle}>
        {/* <View className="absolute top-[60px] left-0 right-0 items-center">
          <Text className="text-white/50 text-sm font-medium" tx="appSwitcher:swipeUpToClose" />
        </View> */}

        {apps.length == 0 && (
          <View className="flex-1 items-center justify-center">
            <Text className="text-white text-[22px] font-semibold mb-2" tx="appSwitcher:noAppsOpen" />
            <Text className="text-white/50 text-base" tx="appSwitcher:yourRecentlyUsedAppsWillAppearHere" />
          </View>
        )}

        {/* Cards Carousel */}
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
                  // activeIndex={activeIndex}
                  translateX={translateX}
                  hidden={hiddenIndex.value == index}
                  index={index}
                />
              ))}
            </Animated.View>
          </Animated.View>
        </GestureDetector>

        {apps.length > 0 && (
          <View className="flex-row justify-center items-center gap-1.5 mb-5">
            {apps.map((_, index) => (
              <PageDot key={index} index={index} activeIndex={activeIndex} />
            ))}
          </View>
        )}

        {/* test button to switch active index */}
        {/* <TouchableOpacity
          className="absolute bottom-12 self-center bg-primary-foreground/90 px-8 py-3.5 rounded-3xl"
          onPress={() => {
            goToIndex(1)
          }}>
          <Text className="text-white text-sm">Switch Active Index</Text>
        </TouchableOpacity> */}

        {/* <TouchableOpacity
          className="absolute bottom-12 self-center bg-primary-foreground/90 px-8 py-3.5 rounded-3xl"
          onPress={() => {
            translateX.value = translateX.value + (CARD_WIDTH + CARD_SPACING)
          }}>
          <Text className="text-white text-sm">Switch Active Index</Text>
        </TouchableOpacity> */}

        {/* Close Button */}
        {/* <TouchableOpacity
          className="absolute bottom-12 self-center bg-primary-foreground/90 px-8 py-3.5 rounded-3xl"
          onPress={onClose}>
          <Text className="text-white text-lg font-semibold" tx="common:close" />
        </TouchableOpacity> */}
        {/* <View className="absolute bottom-12 self-center">
          <Button preset="secondary" tx="common:close" style={{minWidth: 200}} onPress={onClose} />
        </View> */}
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
