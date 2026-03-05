import {Platform, Pressable, View} from "react-native"
import {SharedValue, useSharedValue, withSpring} from "react-native-reanimated"
import {Gesture, GestureDetector} from "react-native-gesture-handler"

import {Text} from "@/components/ignite"
import AppIcon from "@/components/home/AppIcon"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {ClientAppletInterface, useActiveApps, useActiveBackgroundApps, useActiveForegroundApp} from "@/stores/applets"
import * as Haptics from "expo-haptics"
import {useEffect, useRef, useState} from "react"
import {scheduleOnRN} from "react-native-worklets"
import AllAppsGridButton from "@/components/home/AllAppsGridButton"
import {BlurView} from "expo-blur"
import {LinearGradient} from "expo-linear-gradient"
import MaskedView from "@react-native-masked-view/masked-view"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"

interface AppSwitcherButtonProps {
  swipeProgress: SharedValue<number>
}

const SWIPE_DISTANCE_THRESHOLD = 300 // Distance needed to trigger open
const SWIPE_DISTANCE_MULTIPLIER = 1
const SWIPE_PERCENT_THRESHOLD = 0.2
// const SWIPE_VELOCITY_THRESHOLD = 800 // Velocity threshold for quick swipes

export default function AppSwitcherButton({swipeProgress}: AppSwitcherButtonProps) {
  const {theme} = useAppTheme()
  const backgroundApps = useActiveBackgroundApps()
  const foregroundApp = useActiveForegroundApp()
  const apps = useActiveApps()
  const appsCount = apps.length
  const hasBuzzedRef = useRef(false)
  const [appsList, setAppsList] = useState<ClientAppletInterface[]>([])
  const insets = useSaferAreaInsets()

  const translateY = useSharedValue(0)

  useEffect(() => {
    let list = [...backgroundApps]
    if (foregroundApp) {
      list.push(foregroundApp)
    }
    setAppsList(list)
  }, [backgroundApps, foregroundApp])

  const buzz = () => {
    if (Platform.OS === "ios") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    } else {
      Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Keyboard_Tap)
    }
  }

  const panGesture = Gesture.Pan()
    .activeOffsetY([-10, 10])
    .onUpdate((event) => {
      // Only track upward swipes (negative Y)
      if (event.translationY < 0) {
        translateY.value = event.translationY
        let swipeValue = Math.min(
          1,
          Math.abs(translateY.value) / (SWIPE_DISTANCE_THRESHOLD * SWIPE_DISTANCE_MULTIPLIER),
        )

        // don't allow the swipe progress to be 1, until we have ended the swipe gesture:
        if (swipeValue > 0.9) {
          swipeProgress.value = 0.9
        } else {
          swipeProgress.value = swipeValue
        }

        const swipeDistance = Math.abs(translateY.value)

        const shouldOpen = swipeProgress.value > SWIPE_PERCENT_THRESHOLD || swipeDistance > SWIPE_DISTANCE_THRESHOLD

        if (shouldOpen && !hasBuzzedRef.current) {
          hasBuzzedRef.current = true
          scheduleOnRN(buzz)
          // runOnJS(buzz)()
        }
      }
    })
    .onEnd((event) => {
      const swipeDistance = Math.abs(translateY.value)
      // const normalizedVelocity = event.velocityY / (SWIPE_DISTANCE_THRESHOLD * SWIPE_DISTANCE_MULTIPLIER)
      // const velocity = event.velocityY / 100

      const shouldOpen = swipeProgress.value > SWIPE_PERCENT_THRESHOLD || swipeDistance > SWIPE_DISTANCE_THRESHOLD

      if (shouldOpen) {
        swipeProgress.value = withSpring(1, {
          damping: 20,
          stiffness: 2000,
          overshootClamping: true,
          // velocity: velocity,
        })
      } else {
        swipeProgress.value = withSpring(0, {
          damping: 20,
          stiffness: 500,
          overshootClamping: true,
          // velocity: velocity,
        })
      }
      hasBuzzedRef.current = false

      translateY.value = 0
    })

  const tapGesture = Gesture.Tap().onEnd(() => {
    swipeProgress.value = withSpring(1, {damping: 20, stiffness: 300, overshootClamping: true})
  })

  const composedGesture = Gesture.Exclusive(panGesture, tapGesture)
  // const bottomPadding = insets.bottom + theme.spacing.s4
  const bottomPadding = insets.bottom

  const renderBackground = () => {
    // return (
    //   <BlurView intensity={100} className="absolute inset-0" />
    // )

    return (
      //       {/* <BlurView intensity={20} className="absolute inset-0" /> */}
      // {/* <LinearGradient
      //   colors={[theme.colors.background, bgAlpha, bgAlpha]}
      //   locations={[0.2, 1, 1]}
      //   start={{x: 0, y: 1}}
      //   end={{x: 0, y: 0}}
      //   style={{
      //     position: "absolute",
      //     left: 0,
      //     right: 0,
      //     top: 0,
      //     bottom: 0,
      //   }}
      //   pointerEvents="none"
      // /> */}
      <MaskedView
        style={{position: "absolute", left: 0, right: 0, top: 0, bottom: 0, pointerEvents: "none"}}
        maskElement={
          <LinearGradient
            colors={["black", "transparent"]}
            locations={[Platform.OS === "android" ? 0.8 : 0.4, 1]}
            start={{x: 0, y: 1}}
            end={{x: 0, y: 0}}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
            }}
            pointerEvents="none"
          />
          // <View className="flex-1 h-full bg-[#324376]" />
        }>
        {Platform.OS === "android" && <View className="flex-1 h-full bg-background" />}
        {Platform.OS === "ios" && (
          <BlurView intensity={70} className="absolute inset-0" experimentalBlurMethod="dimezisBlurView" />
        )}
        {/* <BlurView intensity={30} className="absolute inset-0" experimentalBlurMethod="dimezisBlurView" /> */}
        {/* <View className="flex-1 h-full bg-[#324376]" />
        <View className="flex-1 h-full bg-[#F5DD90]" />
        <View className="flex-1 h-full bg-[#F76C5E]" />
        <View className="flex-1 h-full bg-[#e1e1e1]" /> */}
      </MaskedView>
    )
  }

  let paddingTop = Platform.OS === "android" ? theme.spacing.s10 : theme.spacing.s16

  if (appsCount === 0) {
    return (
      <View className="w-screen flex-row justify-between items-center gap-4 bottom-0 -ml-6 px-6 absolute" style={{paddingTop: paddingTop}}>
        {renderBackground()}
        <GestureDetector gesture={composedGesture}>
          <View className="flex-1" style={{paddingBottom: bottomPadding}}>
            <View className="bg-primary-foreground flex-1 py-1.5 pl-3 min-h-15 rounded-2xl flex-row justify-between items-center">
              <View className="flex-row items-center justify-center flex-1">
                <Text className="text-muted-foreground text-md" tx="home:appletPlaceholder2" />
              </View>
            </View>
          </View>
        </GestureDetector>
        <View className="bg-primary-foreground items-center p-2 rounded-2xl h-15" style={{marginBottom: bottomPadding}}>
          <AllAppsGridButton />
        </View>
      </View>
    )
  }

  // base 15 height
  return (
    <View className="w-screen flex-row justify-between items-center gap-4 bottom-0 -ml-6 px-6 absolute" style={{paddingTop: paddingTop}}>
      {renderBackground()}
      <GestureDetector gesture={composedGesture}>
        <View className="flex-1" style={{paddingBottom: bottomPadding}}>
          <View className="bg-primary-foreground flex-1 py-1.5 pl-3 pr-2 rounded-2xl flex-row justify-between items-center min-h-15">
            <Pressable style={({pressed}) => [{opacity: pressed ? 0.7 : 1}]} className="flex-1 flex-row">
              <View className="flex-row flex-1">
                <View className="flex-col gap-1 flex-1">
                  <Text
                    text={translate("home:running").toUpperCase()}
                    className="font-semibold text-secondary-foreground text-sm"
                  />
                  {/* {appsCount > 0 && <Badge text={`${translate("home:appsCount", {count: appsCount})}`} />} */}
                  {appsCount > 0 && (
                    <Text
                      text={translate("home:appsCount", {count: appsCount})}
                      className="text-secondary-foreground text-xs"
                    />
                  )}
                </View>

                <View className="flex-row items-center">
                  {appsList.slice(0, 9).map((app, index) => (
                    <View
                      key={app.packageName}
                      style={{
                        zIndex: index,
                        marginLeft: index > 0 ? -theme.spacing.s8 : 0,
                      }}>
                      <AppIcon app={app} className="w-12 h-12" />
                    </View>
                  ))}
                </View>
              </View>
            </Pressable>
          </View>
        </View>
      </GestureDetector>
      <View className="bg-primary-foreground items-center p-2 rounded-2xl h-15" style={{marginBottom: bottomPadding}}>
        <AllAppsGridButton />
      </View>
    </View>
  )
}
