import {RefObject, useCallback, useEffect, useRef, useState} from "react"
import {View, Dimensions, Pressable, Platform, BackHandler} from "react-native"
import {Image, useImage} from "expo-image"
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
  BgTimer,
  saveLastOpenTime,
  sortAppsByLastOpenTime,
  engine,
  type ClientApp,
  useActiveApps,
  useForegroundApp,
  useSetForeground,
} from "@mentra/engine"
import AppIcon from "@/components/home/AppIcon"
import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import {useNavigationStore} from "@/stores/navigation"
import {setMiniappOpeningAnimation, useMiniappPresentationStore} from "@/stores/miniappLaunch"
import {SETTINGS, useSetting} from "@mentra/engine"
import {BlurView} from "expo-blur"
import GlassView from "@/components/ui/GlassView"
import {hapticBuzz} from "@/utils/utils"
import {storage} from "@/utils/storage"
import {translate} from "@/i18n"

const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get("window")
const CARD_SCALE = 0.67
const CARD_WIDTH = SCREEN_WIDTH * CARD_SCALE
const CARD_HEIGHT = SCREEN_HEIGHT * CARD_SCALE
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
  app: ClientApp
  onDismiss: (packageName: string) => void
  onSelect: (packageName: string) => void
  translateX: SharedValue<number>
  cardOrder: SharedValue<string[]>
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

function AppCardItem({app, translateX, cardOrder, onDismiss, onSelect}: AppCardItemProps) {
  const translateY = useSharedValue(0)
  const cardOpacity = useSharedValue(1)
  const loadedImage = useImage(
    app.screenshot ??
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
    {},
    [app.screenshot],
  )
  // such a dumb hack but it works:
  let imageAspectRatio = loadedImage && loadedImage.width > 0 ? loadedImage.height / loadedImage.width : null
  if (!app.screenshot) {
    // load aspect ratio from storage:
    const res = storage.load(`app_screenshot_aspect_ratio`)
    if (res.is_ok()) {
      imageAspectRatio = res.value as number
    } else {
      imageAspectRatio = CARD_HEIGHT / CARD_WIDTH
    }
  } else {
    storage.save(`app_screenshot_aspect_ratio`, imageAspectRatio)
  }

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
        scheduleOnRN(hapticBuzz)
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

  let cardWidth = CARD_WIDTH + CARD_SPACING

  const cardAnimatedStyle = useAnimatedStyle(() => {
    const animIndex = Math.max(0, cardOrder.value.indexOf(app.packageName))

    // let stat = -animIndex * cardWidth
    // let stat = -index * cardWidth // use real index for stat!!
    let stat = 0

    // let howFar = SCREEN_WIDTH / 4
    let lin = translateX.value / cardWidth + animIndex
    if (lin < 0) {
      lin = 0
    }
    let howFar = SCREEN_WIDTH / 2 - cardWidth / 2
    let power = Math.pow(lin, 2) * howFar
    // let howFar = 50
    // let power = (Math.pow(lin+0.3, 4.3) / 60) * howFar
    let res = stat + power

    let howFarPercent = (1 / (howFar / SCREEN_WIDTH)) * howFar
    let linearProgress = power / howFarPercent
    let scale = interpolate(linearProgress, [0, 0.8], [0.96, 1], Extrapolation.CLAMP)
    // account for scaling of the card:
    let offset = (1 - scale) * cardWidth
    // res = res - offset * animIndex
    res = res - offset
    // scale = 1

    return {
      transform: [{translateY: translateY.value}, {scale: scale}, {translateX: res}],
      opacity: cardOpacity.value,
    }
  })

  const titleAnimatedStyle = useAnimatedStyle(() => {
    const animIndex = Math.max(0, cardOrder.value.indexOf(app.packageName))
    let lin = translateX.value / cardWidth + animIndex
    if (lin < 0) {
      lin = 0
    }
    // let howFar = 50
    // let power = (Math.pow(lin, 4.3) / 60) * howFar
    let howFar = SCREEN_WIDTH / 2 - cardWidth / 2
    let power = Math.pow(lin, 2) * howFar
    let howFarPercent = (1 / (howFar / SCREEN_WIDTH)) * howFar
    let linearProgress = power / howFarPercent
    // linear transform linearProgress so that if (linearProgress < 0.5) we start fading out:
    linearProgress = interpolate(linearProgress, [0, 0.1], [0, 1], Extrapolation.CLAMP)
    return {
      opacity: linearProgress,
    }
  })

  // debug sort order:
  // console.log("packageName", app.packageName, "index", index)
  // const insets = useSafierAreaInsets()

  const imageHeight = imageAspectRatio != null ? (CARD_WIDTH - 4) * imageAspectRatio : null

  const SwipeIndicator = useCallback(() => {
    return (
      <View className="absolute bottom-2 left-0 right-0 items-center">
        <View className="w-24 h-[5px] rounded-full bg-white/30" />
      </View>
    )
  }, [])

  return (
    <GestureDetector gesture={composedGesture}>
      <AnimatedPressable
        accessible
        accessibilityRole="button"
        accessibilityLabel={app.name}
        testID={`runningApps.miniapp.${app.packageName}`}
        onAccessibilityTap={selectCard}
        accessibilityActions={[{name: "activate"}, {name: "dismiss", label: translate("navigation:closeMiniapp")}]}
        onAccessibilityAction={({nativeEvent}) => {
          if (nativeEvent.actionName === "activate") selectCard()
          if (nativeEvent.actionName === "dismiss") dismissCard()
        }}
        className="items-start"
        style={[
          {
            width: CARD_WIDTH - 4, // idk why we need this -4, but it's more work than it's worth to figure out
            // height: imageHeight,
            height: CARD_HEIGHT,
            position: "absolute",
            left: 0,
            // zIndex: index,// ensure the cards are on top of each other
          },
          cardAnimatedStyle,
        ]}>
        <View className="pl-6 h-12 gap-3 justify-start w-full flex-row items-center">
          <AppIcon app={app} className="w-8 h-8 rounded-lg" />
          <Animated.View style={titleAnimatedStyle}>
            <Text className="text-foreground text-md font-medium text-center" numberOfLines={1}>
              {app.name}
            </Text>
          </Animated.View>
        </View>
        <View
          className="rounded-4xl overflow-hidden w-full shadow-2xl bg-primary-foreground"
          style={{
            boxShadow: "0px 8px 32px 0px rgba(0, 0, 0, 0.2)",
            // height: imageHeight,
            height: CARD_HEIGHT - 24,
          }}>
          {app.screenshot ? (
            <View className="flex-1" style={{overflow: "hidden"}}>
              <Image source={{uri: app.screenshot}} style={{width: "100%", height: "100%"}} contentFit="cover" />
              <SwipeIndicator />
            </View>
          ) : (
            <View className="flex-1 items-center justify-center">
              <AppIcon app={app} className="w-12 h-12" />
              <SwipeIndicator />
            </View>
          )}
        </View>
      </AnimatedPressable>
    </GestureDetector>
  )
}

interface AppSwitcherProps {
  swipeProgress: SharedValue<number>
  blurTargetRef: RefObject<View | null>
}

// for testing:
// let DUMMY_APPS: ClientApp[] = []
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

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView)

export default function AppSwitcher({swipeProgress, blurTargetRef: _blurTargetRef}: AppSwitcherProps) {
  const translateX = useSharedValue(0)
  const offsetX = useSharedValue(0)
  const targetIndex = useSharedValue(0)
  const prevTranslationX = useSharedValue(0)
  const openX = useSharedValue(-1)
  const cardOrder = useSharedValue<string[]>([])
  const {push} = useNavigationStore.getState()
  const setForeground = useSetForeground()
  const insets = useSaferAreaInsets()
  let directApps = useActiveApps()
  const [sortedApps, setApps] = useState<ClientApp[]>([])
  const [dismissingPackages, setDismissingPackages] = useState<Set<string>>(() => new Set())
  const startedStops = useRef(new Set<string>())
  const closingPackageName = useMiniappPresentationStore((s) => s.closingPackageName)
  const apps = sortedApps.filter(
    (app) =>
      !dismissingPackages.has(app.packageName) &&
      app.packageName !== closingPackageName &&
      directApps.some((active) => active.packageName === app.packageName),
  )
  const [blurPointerEvents, setBlurPointerEvents] = useState<"auto" | "none">("none")
  const [_androidBlur] = useSetting(SETTINGS.android_blur.key)
  const [showNoAppsMessage, setShowNoAppsMessage] = useState(true)
  // JS-thread mirror of swipeProgress open-ness, so the Android hardware back
  // gesture can dismiss the switcher (the switcher is an overlay, not a route,
  // so navigation's back handler never sees it). Synced from the swipeProgress
  // useAnimatedReaction below.
  const [isOpen, setIsOpen] = useState(false)
  const dotsPanGestureRef = useRef(Gesture.Pan())

  // for testing:
  //   apps = [...DUMMY_APPS, ...apps]

  // const activePackageNames = useActiveAppPackageNames()
  // const apps = useMemo(() => {
  //   return useAppletStatusStore.getState().apps.filter((a) => activePackageNames.includes(a.packageName))
  // }, [activePackageNames])

  // While a card tap is mid-flight (selection → app opens → drawer is hidden),
  // the store updates several times
  // (last-open-time save, foregrounded flip) and each poll would re-sort the
  // VISIBLE card stack — the tapped card jumps to the end of the list and the
  // whole strip thrashes left/right ("seizure" during open,
  // rep_01KY6D2EMFXC8JQKZH9EGMZ5G3). Freeze the rendered order for the whole
  // selection window and apply the final order once, after the close finishes.
  const selectionInFlight = useRef(false)
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null)
  const foregroundApp = useForegroundApp()
  const revealedPackageName = useMiniappPresentationStore((s) => s.revealedPackageName)
  const directAppsRef = useRef(directApps)
  directAppsRef.current = directApps

  useEffect(() => {
    if (selectionInFlight.current) return
    let cancelled = false
    sortAppsByLastOpenTime(directApps).then((sorted) => {
      if (cancelled || selectionInFlight.current) return
      setApps(sorted)
      // Keep dismissed cards hidden until the sorted store snapshot catches up.
      setDismissingPackages((pending) => {
        const remaining = new Set([...pending].filter((pkg) => sorted.some((app) => app.packageName === pkg)))
        return remaining.size === pending.size ? pending : remaining
      })
    })
    return () => {
      cancelled = true
    }
  }, [directApps])

  // Stop only after React has committed the card's removal from the tray.
  useEffect(() => {
    for (const packageName of startedStops.current) {
      if (!dismissingPackages.has(packageName)) startedStops.current.delete(packageName)
    }
    for (const packageName of dismissingPackages) {
      if (startedStops.current.has(packageName)) continue
      startedStops.current.add(packageName)
      void engine.miniapps.stop(packageName).catch((error) => {
        console.error(`AppSwitcher: failed to stop ${packageName}`, error)
        setDismissingPackages((pending) => {
          const remaining = new Set(pending)
          remaining.delete(packageName)
          return remaining
        })
      })
    }
  }, [dismissingPackages])

  const activeIndex = useDerivedValue(() => {
    return -translateX.value / (CARD_WIDTH + CARD_SPACING) + 2
  })

  // The Compositor's bottom swipe-up can commit while home isn't mounted
  // (clearHistoryAndGoHome remounts this screen with the shared progress
  // already at 1), so the useAnimatedReaction below never sees the 0→1
  // crossing — sync the open state on mount instead.
  useEffect(() => {
    if (swipeProgress.value > 0.5) {
      openX.value = 0
      setBlurPointerEvents("auto")
      setShowNoAppsMessage(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Derive animations from swipeProgress
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: swipeProgress.value,
  }))

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
    .requireExternalGestureToFail(dotsPanGestureRef)
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

  const dotsPanGesture = Gesture.Pan()
    .withRef(dotsPanGestureRef)
    .activateAfterLongPress(200)
    .activeOffsetX([-5, 5])
    .onStart(() => {
      offsetX.value = translateX.value
      scheduleOnRN(hapticBuzz)
    })
    .onUpdate((event) => {
      const cardWidth = CARD_WIDTH + CARD_SPACING
      const sensitivity = 5
      const raw = offsetX.value - event.translationX * sensitivity
      const snappedIndex = Math.round(-raw / cardWidth)
      const clamped = Math.max(-1, Math.min(snappedIndex, apps.length - 2))
      // check if we're moving to a new index:
      if (clamped !== targetIndex.value) {
        targetIndex.value = clamped
        scheduleOnRN(hapticBuzz)
      }
      translateX.value = withSpring(-clamped * cardWidth, {
        damping: 200,
        stiffness: 800,
      })
    })
    .onEnd((event) => {
      const cardWidth = CARD_WIDTH + CARD_SPACING
      const velocity = event.velocityX * 3

      let newTarget = Math.round(-translateX.value / cardWidth)
      newTarget = Math.max(-1, Math.min(newTarget, apps.length - 2))

      targetIndex.value = newTarget

      translateX.value = withSpring(-newTarget * cardWidth, {
        damping: 4000,
        stiffness: 200,
        velocity: velocity,
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

  const handleDismiss = useCallback((packageName: string) => {
    setDismissingPackages((pending) => new Set(pending).add(packageName))
  }, [])

  const handleSelect = (packageName: string) => {
    // console.log("selecting", packageName)

    const applet = apps.find((app) => app.packageName === packageName)
    if (!applet) {
      console.error("SWITCH: no applet found!")
      return
    }

    // Freeze the visible card order until the drawer has fully closed (see
    // the sort effect above). Release it after hiding the covered drawer.
    selectionInFlight.current = true

    if (isOfflineHosted(applet.packageName) || applet.local) {
      setSelectedPackage(applet.packageName)
      setMiniappOpeningAnimation(applet.packageName, "expand")
    }

    // Handle apps with custom routes (offline or online with offlineRoute override)
    if (applet.offlineRoute && isOfflineHosted(applet.packageName)) {
      // Registry-hosted offline apps render in the Compositor overlay like
      // local miniapps (setForeground already saves last-open time).
      setForeground(applet.packageName)
    } else if (applet.offlineRoute) {
      saveLastOpenTime(applet.packageName)
      push(applet.offlineRoute, {transition: "fade"})
    } else if (applet.local) {
      // Local miniapps are rendered by the Compositor overlay rather than a
      // pushed route — foreground the app and let <Compositor /> mount its
      // WebView (with the opening animation + back-swipe to background).
      setForeground(applet.packageName)
    } else {
      saveLastOpenTime(applet.packageName)
      push("/applet/settings", {
        packageName: applet.packageName,
        appName: applet.name,
        transition: "fade",
      })
    }

    // Overlay miniapps hide the tray on actual page reveal, below. Ordinary
    // router destinations keep their existing dismissal path.
    if (!isOfflineHosted(applet.packageName) && !applet.local) {
      BgTimer.setTimeout(() => handleClose(), 500)
    }
  }

  const finishSelection = useCallback(() => {
    setSelectedPackage(null)
    if (!selectionInFlight.current) return
    selectionInFlight.current = false
    sortAppsByLastOpenTime(directAppsRef.current).then((sorted) => {
      if (!selectionInFlight.current) setApps(sorted)
    })
  }, [])

  useEffect(() => {
    if (!selectedPackage) return
    if (revealedPackageName === selectedPackage) {
      // Startup and the page reveal are done. Hide the covered tray without animation.
      swipeProgress.value = 0
      finishSelection()
    } else if (!foregroundApp || foregroundApp.packageName !== selectedPackage) {
      // A failed or cancelled launch leaves the tray available instead of frozen.
      finishSelection()
    }
  }, [selectedPackage, revealedPackageName, foregroundApp, swipeProgress, finishSelection])

  const handleClose = useCallback(() => {
    // reset the translateX:
    swipeProgress.value = withSpring(0, {damping: 20, stiffness: 300, overshootClamping: true})
    // do after we have closed the swipe progress:
    setTimeout(() => {
      swipeProgress.value = 0
      // goToIndex(apps.length - 1, true)
      // Selection window over (drawer is fully hidden): unfreeze the card
      // order and apply the sort that was suppressed during the open/close.
      finishSelection()
    }, 250)
  }, [swipeProgress, finishSelection])

  // Edge-triggered close when the open switcher's app list has actually drained
  // to empty. Driven off the real rendered `apps` list (the source of truth),
  // so it fires exactly once no matter how many cards were flung at once.
  useEffect(() => {
    if (isOpen && apps.length === 0) {
      handleClose()
    }
  }, [isOpen, apps.length, handleClose])

  // Android: the hardware/native back gesture should dismiss the switcher. It's an
  // overlay (not a route), so navigation never sees it — register a BackHandler
  // while open and consume the event so it doesn't fall through to navigating away
  // from home.
  useEffect(() => {
    if (Platform.OS !== "android" || !isOpen || foregroundApp) return
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      handleClose()
      return true
    })
    return () => sub.remove()
  }, [isOpen, handleClose, foregroundApp])

  useAnimatedReaction(
    () => ({progress: swipeProgress.value, appCount: apps.length, packages: apps.map((app) => app.packageName)}),
    (currentState, previousState) => {
      const {progress: current, appCount, packages} = currentState
      const previous = previousState?.progress ?? null
      // Center on the UI thread before revealing the cards. An async sort can
      // add the newly launched app after opening starts, so also track growth.
      // Assign both values even when the target index matches: an old spring
      // or drag may have left the actual offset somewhere else.
      if (
        previousState === null ||
        current === 0 ||
        (current > 0 && previous === 0) ||
        appCount > previousState.appCount
      ) {
        const lastTarget = Math.max(-1, appCount - 2)
        targetIndex.value = lastTarget
        translateX.value = -lastTarget * (CARD_WIDTH + CARD_SPACING)
        offsetX.value = translateX.value
      } else if (packages.join("\n") !== cardOrder.value.join("\n")) {
        // Preserve the centered miniapp by identity when another card leaves.
        // If it was removed, choose the nearest surviving slot instead.
        const previousOrder = cardOrder.value
        const centeredIndex = Math.max(
          0,
          Math.min(previousOrder.length - 1, Math.round(-translateX.value / (CARD_WIDTH + CARD_SPACING)) + 1),
        )
        const centeredPackage = previousOrder[centeredIndex]
        const survivingIndex = packages.indexOf(centeredPackage)
        const nextIndex = survivingIndex >= 0 ? survivingIndex : Math.min(centeredIndex, appCount - 1)
        const nextTarget = Math.max(-1, nextIndex - 1)
        targetIndex.value = nextTarget
        translateX.value = -nextTarget * (CARD_WIDTH + CARD_SPACING)
        offsetX.value = translateX.value
      }
      // Cards read this same UI-thread order rather than running independent
      // index springs, so reindexing and offset correction reach one frame.
      cardOrder.value = packages
      if (previous !== null && current == 1 && previous < 1) {
        openX.value = withSpring(0, {damping: 200, stiffness: 1000, overshootClamping: true})
        // }, 200)
        // scheduleOnRN(() => {setIsOpen(true)})
      } else if (previous !== null && current == 0 && previous > 0) {
        openX.value = -1
        // scheduleOnRN(() => {setIsOpen(false)})
      }
      if (previous !== null && current > 0 && previous == 0) {
        runOnJS(setBlurPointerEvents)("auto")
        runOnJS(setIsOpen)(true)
        if (apps.length > 0) {
          runOnJS(setShowNoAppsMessage)(false)
        }
      }
      if (previous !== null && current == 0 && previous > 0) {
        // console.log("just closed")
        runOnJS(setBlurPointerEvents)("none")
        runOnJS(setShowNoAppsMessage)(true)
        runOnJS(setIsOpen)(false)
      }
    },
  )

  const renderBackground = () => {
    // doesn't work yet on android for some reason :(
    if (Platform.OS === "android" /*&& !androidBlur*/) {
      return (
        <Animated.View className="absolute inset-0 bg-background/75" style={backdropStyle}>
          <Pressable accessible={false} className="flex-1" onPress={handleClose} />
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
        blurMethod="dimezisBlurViewSdk31Plus"
        blurReductionFactor={7}
        // blurTarget={blurTargetRef}// doesn't work yet on android for some reason :(
      >
        <Pressable accessible={false} className="flex-1" onPress={handleClose} />
      </AnimatedBlurView>
    )
  }

  return (
    <Animated.View
      testID="home.runningApps"
      accessibilityElementsHidden={!isOpen}
      importantForAccessibility={isOpen ? "auto" : "no-hide-descendants"}
      className="absolute inset-0"
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

        {apps.length == 0 && showNoAppsMessage && (
          <View className="flex-1 items-center justify-center">
            <Text className="text-foreground text-[22px] font-semibold mb-2" tx="appSwitcher:noAppsOpen" />
            <Text className="text-muted-foreground text-base" tx="appSwitcher:yourRecentlyUsedAppsWillAppearHere" />
          </View>
        )}

        {/* Cards Carousel */}
        <GestureDetector gesture={panGesture}>
          <Animated.View className="flex-1 justify-center" style={openXAnimatedStyle}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={translate("appSwitcher:close")}
              testID="home.runningApps.close"
              className="absolute inset-0"
              onPress={handleClose}
              onAccessibilityTap={handleClose}
              accessibilityActions={[{name: "activate"}]}
              onAccessibilityAction={({nativeEvent}) => {
                if (nativeEvent.actionName === "activate") handleClose()
              }}
            />
            {/* Absolute cards need a measured parent for the native accessibility tree. */}
            <Animated.View pointerEvents="box-none" className="flex-row items-center" style={{height: CARD_HEIGHT}}>
              {apps.map((app) => (
                <AppCardItem
                  key={app.packageName}
                  app={app}
                  onDismiss={handleDismiss}
                  onSelect={handleSelect}
                  // activeIndex={activeIndex}
                  translateX={translateX}
                  cardOrder={cardOrder}
                />
              ))}
            </Animated.View>
          </Animated.View>
        </GestureDetector>

        {apps.length > 0 && (
          <GestureDetector gesture={dotsPanGesture}>
            <View collapsable={false}>
              <GlassView
                transparent={false}
                className="mb-5 px-4 py-2 h-8 rounded-full mx-auto bg-black/30 items-center justify-center gap-1.5 flex-row">
                {apps.map((_, index) => (
                  <PageDot key={index} index={index} activeIndex={activeIndex} />
                ))}
              </GlassView>
            </View>
          </GestureDetector>
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
