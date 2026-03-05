import React, {useCallback, useEffect, useMemo, useRef, useState} from "react"
import {View, Dimensions, Pressable, Image, TouchableOpacity, Platform} from "react-native"
import {Text} from "@/components/ignite/"
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
  Extrapolation,
  useDerivedValue,
  SharedValue,
  useAnimatedReaction,
  useAnimatedProps,
} from "react-native-reanimated"
import {Gesture, GestureDetector} from "react-native-gesture-handler"
import {runOnJS, scheduleOnRN} from "react-native-worklets"
import {
  ClientAppletInterface,
  getLastOpenTime,
  setLastOpenTime,
  useActiveApps,
  useAppletStatusStore,
} from "@/stores/applets"
import AppIcon from "@/components/home/AppIcon"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {SETTINGS, useSetting} from "@/stores/settings"
import {BlurView} from "expo-blur"

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
  onDismiss: (packageName: string) => void
  onSelect: (packageName: string) => void
  translateX: SharedValue<number>
  count: number
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

function AppCardItem({app, index, count, translateX, onDismiss, onSelect}: AppCardItemProps) {
  const translateY = useSharedValue(0)
  const cardOpacity = useSharedValue(1)
  const animatedIndex = useSharedValue(index)

  useEffect(() => {
    if (animatedIndex.value < index && index == count - 1) {
      // teleport to the end of the list if we're updating the order:
      animatedIndex.value = withTiming(index, {duration: 0})
      return
    }
    // otherwise, animate as normal:
    if (index != animatedIndex.value) {
      animatedIndex.value = withSpring(index, {damping: 200, stiffness: 200})
    }
  }, [index])

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
          scheduleOnRN(dismissCard)
        })
      } else {
        translateY.value = withSpring(0, {damping: 200, stiffness: 1000, velocity: 2})
        // cardScale.value = withSpring(1)
        cardOpacity.value = withSpring(1)
      }
    })

  const tapGesture = Gesture.Tap().onEnd(() => {
    scheduleOnRN(selectCard)
  })

  const composedGesture = Gesture.Exclusive(panGesture, tapGesture)

  const cardAnimatedStyle = useAnimatedStyle(() => {
    let animIndex = animatedIndex.value

    let cardWidth = CARD_WIDTH + CARD_SPACING
    // let stat = -animIndex * cardWidth
    // let stat = -index * cardWidth // use real index for stat!!
    let stat = 0

    // let howFar = SCREEN_WIDTH / 4
    let howFar = SCREEN_WIDTH / 2 - cardWidth / 2
    let lin = translateX.value / cardWidth + animIndex
    if (lin < 0) {
      lin = 0
    }
    let power = Math.pow(lin, 2) * howFar
    let res = stat + power

    let howFarPercent = (1 / (howFar / SCREEN_WIDTH)) * howFar
    let linearProgress = power / howFarPercent
    let scale = interpolate(linearProgress, [0, 0.8], [0.96, 1], Extrapolation.CLAMP)
    // account for scaling of the card:
    let offset = (1 - scale) * cardWidth
    // res = res - offset * animIndex
    // scale = 1

    return {
      transform: [{translateY: translateY.value}, {scale: scale}, {translateX: res}],
      opacity: cardOpacity.value,
    }
  })

  // debug sort order:
  // console.log("packageName", app.packageName, "index", index)

  return (
    <GestureDetector gesture={composedGesture}>
      <AnimatedPressable
        className="items-start"
        style={[
          {
            width: CARD_WIDTH,
            height: CARD_HEIGHT, // - 16,
            // zIndex: -index,// to reverse stack order
            position: "absolute",
            left: 0,
            // zIndex: index,// ensure the cards are on top of each other
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
  swipeProgress: SharedValue<number>
}

// for testing:
// let DUMMY_APPS: ClientAppletInterface[] = []
// for (let i = 0; i < 30; i++) {
//   DUMMY_APPS.push({
//     packageName: `com.mentra.dummy.${i}`,
//     name: `Dummy ${i}`,
//     logoUrl: "https://www.mentra.com/icon.png",
//     // screenshot: "https://www.mentra.com/screenshot.png",
//     offline: false,
//     offlineRoute: "",
//     loading: false,
//     local: false,
//     healthy: true,
//     hardwareRequirements: [],
//     webviewUrl: "",
//     type: "standard",
//     permissions: [],
//     running: true,
//   })
// }

export default function AppSwitcher({swipeProgress}: AppSwitcherProps) {
  const translateX = useSharedValue(0)
  const offsetX = useSharedValue(0)
  const targetIndex = useSharedValue(0)
  const prevTranslationX = useSharedValue(0)
  const openX = useSharedValue(-1)
  const {push} = useNavigationHistory()
  const insets = useSaferAreaInsets()
  let directApps = useActiveApps()
  let [apps, setApps] = useState<ClientAppletInterface[]>([])
  const prevAppsLength = useRef(0)
  const [blurPointerEvents, setBlurPointerEvents] = useState<"auto" | "none">("none")
  const [androidBlur] = useSetting(SETTINGS.android_blur.key)

  // for testing:
  //   apps = [...DUMMY_APPS, ...apps]

  // const activePackageNames = useActiveAppPackageNames()
  // const apps = useMemo(() => {
  //   return useAppletStatusStore.getState().apps.filter((a) => activePackageNames.includes(a.packageName))
  // }, [activePackageNames])

  useEffect(() => {
    const sortApps = async () => {
      const timestamps = await Promise.all(
        directApps.map(async (app) => ({
          app,
          time: await getLastOpenTime(app.packageName),
        })),
      )
      let sortedApps = timestamps
        .sort((a, b) => {
          if (a.time.is_error() || b.time.is_error()) return 0
          return a.time.value - b.time.value
        })
        .map((entry) => entry.app)
      setApps(sortedApps)
      // let index = apps.length - 1
      // setTimeout(() => {
      //   runOnJS(goToIndex)(index)
      // }, 100)
      // setApps(directApps)
    }
    sortApps()
  }, [directApps])

  const activeIndex = useDerivedValue(() => {
    return -translateX.value / (CARD_WIDTH + CARD_SPACING) + 2
  })

  // Initialize card position when apps load
  // useEffect(() => {
  //   if (apps.length > 0) {
  //     translateX.value = -((apps.length - 2) * CARD_WIDTH)
  //   }
  // }, [apps.length])
  useEffect(() => {
    if (prevAppsLength.current === 0 && apps.length > 0) {
      translateX.value = -((apps.length - 2) * CARD_WIDTH)
    }
    prevAppsLength.current = apps.length
  }, [apps.length])

  // Derive animations from swipeProgress
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: swipeProgress.value,
  }))

  const AnimatedBlurView = Animated.createAnimatedComponent(BlurView)
  const blurAnimatedProps = useAnimatedProps(() => ({
    intensity: interpolate(swipeProgress.value, [0, 1], [0, 50], Extrapolation.CLAMP),
  }))

  const containerStyle = useAnimatedStyle(() => {
    return {
      transform: [{translateY: 100 * (1 - swipeProgress.value)}],
      opacity: swipeProgress.value,
    }
  })

  const openXAnimatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{translateX: openX.value * SCREEN_WIDTH}],
    }
  })

  // fix for android because it doesn't handle pointer events correctly
  const parentContainerStyle = useAnimatedStyle(() => {
    if (Platform.OS === "android") {
      return {
        pointerEvents: swipeProgress.value > 0.98 ? "auto" : "none",
      }
    }
    return {}
  })

  const blurStyle = useAnimatedStyle(() => {
    return {
      pointerEvents: swipeProgress.value > 0.98 ? "auto" : "none",
    }
  })

  // useAnimatedReaction(
  //   () => swipeProgress.value > 0.99,
  //   (isOpen, wasOpen) => {
  //     if (isOpen !== wasOpen) {
  //       setTimeout(() => {
  //         runOnJS(setBlurPointerEvents)(isOpen ? "auto" : "none")
  //       }, 250)
  //     }
  //   },
  // )

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
      const absVelocity = Math.abs(velocity)

      let newTarget = Math.round(-translateX.value / cardWidth)

      // console.log("absVelocity", absVelocity)

      if (absVelocity > 500) {
        newTarget = velocity > 0 ? newTarget - 1 : newTarget + 1
      }
      if (absVelocity > 2800) {
        newTarget = velocity > 0 ? newTarget - 2 : newTarget + 2
      }

      newTarget = Math.max(-1, Math.min(newTarget, apps.length - 2))

      targetIndex.value = newTarget

      // console.log("newTarget", newTarget)

      translateX.value = withSpring(-newTarget * cardWidth, {
        damping: 4000,
        stiffness: 200,
        velocity: velocity,
        // overshootClamping: true,
      })
    })

  // useEffect(() => {
  //   let sub = setInterval(() => {
  //     console.log("springing!!!@!!!")
  //     let cardWidth = CARD_WIDTH + CARD_SPACING
  //     let newTarget = Math.round(-translateX.value / cardWidth) - 1
  //     translateX.value = withSpring(-newTarget * cardWidth, {
  //       damping: 4000,
  //       stiffness: 200,
  //     })
  //     // openX.value = withSpring(0, {damping: 200, stiffness: 500, overshootClamping: false})
  //     // console.log("translateX.value", translateX.value)
  //   }, 4000)
  //   return () => clearInterval(sub)
  // }, [])

  const handleDismiss = useCallback(
    (packageName: string) => {
      let lastApp = apps[apps.length - 1]
      // Adjust if we were on the last card
      if (lastApp.packageName === packageName) {
        // let cardWidth = CARD_WIDTH + CARD_SPACING
        // let newTarget = Math.round(-translateX.value / cardWidth) - 1
        // // console.log("newTarget", newTarget)
        // console.log("newTarget", -newTarget * cardWidth)
        // translateX.value = withSpring(-newTarget * cardWidth, {
        //   damping: 1000,
        //   stiffness: 350,
        //   overshootClamping: true,
        // })

        let index = apps.length - 2
        goToIndex(index)
      }
      // setTimeout(() => {
      useAppletStatusStore.getState().stopApplet(packageName)
      // }, 100)
    },
    [apps.length, translateX.value, apps],
  )

  const goToIndex = useCallback(
    (index: number, instant: boolean = false) => {
      index = index - 1
      const cardWidth = CARD_WIDTH + CARD_SPACING
      const clamped = Math.max(-1, Math.min(index, apps.length - 1))
      targetIndex.value = clamped
      let target = -clamped * cardWidth
      if (instant) {
        translateX.value = withTiming(target, {duration: 10})
      } else {
        translateX.value = withSpring(target, {
          damping: 1000,
          stiffness: 350,
          overshootClamping: true,
        })
      }
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
      setLastOpenTime(applet.packageName)
      push(applet.offlineRoute, {transition: "fade"})
    } else if (applet.webviewUrl && applet.healthy) {
      setLastOpenTime(applet.packageName)
      push("/applet/webview", {
        webviewURL: applet.webviewUrl,
        appName: applet.name,
        packageName: applet.packageName,
        transition: "fade",
      })
    } else if (applet.local) {
      setLastOpenTime(applet.packageName)
      push("/applet/local", {
        packageName: applet.packageName,
        appName: applet.name,
        transition: "fade",
      })
    } else {
      setLastOpenTime(applet.packageName)
      push("/applet/settings", {
        packageName: applet.packageName,
        appName: applet.name,
        transition: "fade",
      })
    }

    handleClose()
  }

  const handleClose = useCallback(() => {
    // reset the translateX:
    swipeProgress.value = withSpring(0, {damping: 20, stiffness: 300, overshootClamping: true})
    // do after we have closed the swipe progress:
    setTimeout(() => {
      swipeProgress.value = 0
      // goToIndex(apps.length - 1, true)
    }, 250)
  }, [apps.length])

  useAnimatedReaction(
    () => swipeProgress.value,
    (current, previous) => {
      if (previous !== null && current == 1 && previous < 1) {
        // setTimeout(() => {
        if (apps.length > 1) {
          runOnJS(goToIndex)(apps.length - 1, true)
        }
        openX.value = withSpring(0, {damping: 200, stiffness: 500, overshootClamping: false})
        // }, 200)
        // scheduleOnRN(() => {setIsOpen(true)})
      } else if (previous !== null && current == 0 && previous > 0) {
        openX.value = -1
        // scheduleOnRN(() => {setIsOpen(false)})
      }
      if (previous !== null && current > 0 && previous == 0) {
        // console.log("just opened")
        runOnJS(goToIndex)(apps.length - 1, true)
        runOnJS(setBlurPointerEvents)("auto")
      }
      if (previous !== null && current == 0 && previous > 0) {
        // console.log("just closed")
        runOnJS(setBlurPointerEvents)("none")
      }
    },
  )

  const renderBackground = () => {
    if (Platform.OS === "android" && !androidBlur) {
      return (
        <Animated.View className="absolute inset-0 bg-black/70" style={backdropStyle}>
          <Pressable className="flex-1" onPress={handleClose} />
        </Animated.View>
      )
    }
    return (
      <AnimatedBlurView
        animatedProps={blurAnimatedProps}
        // pointerEvents={blurPointerEvents}
        pointerEvents={blurPointerEvents}
        className="absolute inset-0"
        style={blurStyle}
        experimentalBlurMethod="dimezisBlurView">
        <Pressable className="flex-1" onPress={handleClose} />
      </AnimatedBlurView>
    )
  }

  return (
    <Animated.View
      className="absolute -mx-6 inset-0"
      pointerEvents="box-none"
      style={[{paddingBottom: insets.bottom}, parentContainerStyle]}>
      {/* Blurred Backdrop */}
      {/* <Animated.View className="absolute inset-0 bg-black/70" style={backdropStyle}> */}
      {/* <AnimatedBlurView animatedProps={blurAnimatedProps} className="absolute inset-0" style={[{pointerEvents: blurPointerEvents}]}> */}
      {/* <AnimatedBlurView animatedProps={blurAnimatedProps} className="absolute inset-0" style={[blurStyle, {pointerEvents: blurPointerEvents}]}> */}
      {renderBackground()}

      {/* Main Container */}
      <Animated.View className="flex-1 justify-center" style={containerStyle}>
        {/* <View className="absolute top-[60px] left-0 right-0 items-center">
          <Text className="text-white/50 text-sm font-medium" tx="appSwitcher:swipeUpToClose" />
        </View> */}

        {apps.length == 0 && (
          <View className="flex-1 items-center justify-center">
            <Text className="text-foreground text-[22px] font-semibold mb-2" tx="appSwitcher:noAppsOpen" />
            <Text className="text-muted-foreground text-base" tx="appSwitcher:yourRecentlyUsedAppsWillAppearHere" />
          </View>
        )}

        {/* Cards Carousel */}
        <GestureDetector gesture={panGesture}>
          <Animated.View className="flex-1 justify-center" style={openXAnimatedStyle}>
            <Pressable className="absolute inset-0" onPress={handleClose} />
            <Animated.View className="flex-row items-center">
              {apps.map((app, index) => (
                <AppCardItem
                  key={app.packageName}
                  app={app}
                  onDismiss={handleDismiss}
                  onSelect={handleSelect}
                  count={apps.length}
                  // activeIndex={activeIndex}
                  translateX={translateX}
                  index={index}
                />
              ))}
            </Animated.View>
          </Animated.View>
        </GestureDetector>

        {apps.length > 0 && (
          <View className="mb-5 px-4 py-2 rounded-full mx-auto bg-black/30 items-center justify-center gap-1.5 flex-row">
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
    </Animated.View>
  )
}

function PageDot({index, activeIndex}: {index: number; activeIndex: SharedValue<number>}) {
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
