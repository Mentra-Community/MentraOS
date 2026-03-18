import {Platform, Pressable, TouchableOpacity, View} from "react-native"
import {SharedValue, useSharedValue, withSpring} from "react-native-reanimated"
import {Gesture, GestureDetector} from "react-native-gesture-handler"

import {Icon, Text} from "@/components/ignite"
import AppIcon from "@/components/home/AppIcon"
import {useAppTheme} from "@/contexts/ThemeContext"
import {translate} from "@/i18n"
import {ClientAppletInterface, useActiveApps, useActiveBackgroundApps, useActiveForegroundApp} from "@/stores/applets"
import {RefObject, useEffect, useRef, useState} from "react"
import {scheduleOnRN} from "react-native-worklets"
import {BlurView} from "expo-blur"
import {LinearGradient} from "expo-linear-gradient"
import MaskedView from "@react-native-masked-view/masked-view"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import GlassView from "@/components/ui/GlassView"
import {SETTINGS, useSetting} from "@/stores/settings"
import {hapticBuzz} from "@/utils/utils"
import showAlert from "@/contexts/ModalContext"

interface AppSwitcherButtonProps {
  swipeProgress: SharedValue<number>
  onGridButtonPress: () => void
  blurTargetRef: RefObject<View | null>
}

const SWIPE_DISTANCE_THRESHOLD = 300 // Distance needed to trigger open
const SWIPE_DISTANCE_MULTIPLIER = 1
const SWIPE_PERCENT_THRESHOLD = 0.2
// const SWIPE_VELOCITY_THRESHOLD = 800 // Velocity threshold for quick swipes

export default function AppSwitcherButton({swipeProgress, onGridButtonPress, blurTargetRef}: AppSwitcherButtonProps) {
  const {theme} = useAppTheme()
  const backgroundApps = useActiveBackgroundApps()
  const foregroundApp = useActiveForegroundApp()
  const apps = useActiveApps()
  const appsCount = apps.length
  const hasBuzzedRef = useRef(false)
  const [appsList, setAppsList] = useState<ClientAppletInterface[]>([])
  const insets = useSaferAreaInsets()
  const translateY = useSharedValue(0)
  const [androidBlur] = useSetting(SETTINGS.android_blur.key)

  useEffect(() => {
    let list = [...backgroundApps]
    if (foregroundApp) {
      list.push(foregroundApp)
    }
    setAppsList(list)
  }, [backgroundApps, foregroundApp])

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
          scheduleOnRN(hapticBuzz)
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
    swipeProgress.value = withSpring(1, {damping: 20, stiffness: 1000, overshootClamping: true})
  })

  // let composedGesture
  // if (Platform.OS === "android") {
  //   composedGesture = Gesture.Exclusive(tapGesture)
  // } else {
  //   composedGesture = Gesture.Exclusive(panGesture, tapGesture)
  // }
  
  let composedGesture = Gesture.Exclusive(panGesture, tapGesture)

  // const bottomPadding = insets.bottom + theme.spacing.s4
  const bottomPadding = insets.bottom

  const renderBackground = () => {
    // return (
    //   <BlurView intensity={50} className="absolute inset-0" blurTarget={blurTargetRef} blurMethod="dimezisBlurViewSdk31Plus" />
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
            locations={[0.4, 1]}
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
        }>
        {Platform.OS === "android" && androidBlur && (
          <BlurView
            intensity={20}
            className="absolute inset-0"
            blurTarget={blurTargetRef}
            blurMethod="dimezisBlurViewSdk31Plus"
          />
        )}

        {Platform.OS === "android" && !androidBlur && <View className="flex-1 h-full" />}

        {Platform.OS === "ios" && (
          <BlurView intensity={70} className="absolute inset-0" blurMethod="dimezisBlurViewSdk31Plus" />
        )}
        {/* <View className="flex-1 h-full bg-[#324376]" />
        <View className="flex-1 h-full bg-[#F5DD90]" />
        <View className="flex-1 h-full bg-[#F76C5E]" />
        <View className="flex-1 h-full bg-[#e1e1e1]" /> */}
      </MaskedView>
    )
  }

  const handleNoAppsPress = () => {
    showAlert({
      title: translate("appSwitcher:noAppsOpen"),
      message: translate("appSwitcher:yourRecentlyUsedAppsWillAppearHere"),
      buttons: [{text: translate("common:ok")}],
    })
  }

  let paddingTop: number = Platform.OS === "android" ? theme.spacing.s14 : theme.spacing.s16
  if (Platform.OS === "android" && !androidBlur) {
    paddingTop = theme.spacing.s10
  }

  const renderGridButton = () => {
    return (
      <GlassView className={`bg-primary-foreground h-15 rounded-2xl`} style={{marginBottom: bottomPadding}}>
        <TouchableOpacity onPress={onGridButtonPress} className="items-center justify-center w-15 h-15">
          <Icon name="grid-3x3" color={theme.colors.foreground} size={32} />
        </TouchableOpacity>
      </GlassView>
    )
  }

  if (Platform.OS === "android" && appsCount === 0) {
    return (
      <View
        className="w-screen flex-row justify-between items-center gap-4 bottom-0 -ml-6 px-6 absolute"
        style={{paddingTop: paddingTop}}>
        {renderBackground()}
        <TouchableOpacity onPress={handleNoAppsPress} className="flex-1">
          <View className="flex-1" style={{paddingBottom: bottomPadding}}>
            <GlassView
              className={`bg-primary-foreground flex-1 py-1.5 pl-3 min-h-15 rounded-2xl flex-row justify-between items-center`}>
              <View className="flex-row items-center justify-center flex-1">
                <Text className="text-muted-foreground text-md" tx="home:appletPlaceholder2" />
              </View>
            </GlassView>
          </View>
        </TouchableOpacity>
        {renderGridButton()}
      </View>
    )
  }

  if (appsCount === 0) {
    return (
      <View
        className="w-screen flex-row justify-between items-center gap-4 bottom-0 -ml-6 px-6 absolute"
        style={{paddingTop: paddingTop}}>
        {renderBackground()}
        <GestureDetector gesture={composedGesture}>
          <View className="flex-1" style={{paddingBottom: bottomPadding}}>
            <GlassView
              className={`bg-primary-foreground flex-1 py-1.5 pl-3 min-h-15 rounded-2xl flex-row justify-between items-center`}>
              <View className="flex-row items-center justify-center flex-1">
                <Text className="text-muted-foreground text-md" tx="home:appletPlaceholder2" />
              </View>
            </GlassView>
          </View>
        </GestureDetector>
        {renderGridButton()}
      </View>
    )
  }

  // base 15 height
  return (
    <View
      className="w-screen flex-row justify-between items-center gap-4 bottom-0 -ml-6 px-6 absolute"
      style={{paddingTop: paddingTop}}>
      {renderBackground()}
      <GestureDetector gesture={composedGesture}>
        <View className="flex-1" style={{paddingBottom: bottomPadding}}>
          <GlassView
            className={`bg-primary-foreground flex-1 py-1.5 pl-3 pr-2 rounded-2xl flex-row justify-between items-center min-h-15`}>
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
                  {appsList.slice(0, 9).map((app, index) => {
                    let marginLeft = 0
                    let trueIndex = appsList.length - index
                    if (index > 0) {
                      marginLeft = -(theme.spacing.s12 - theme.spacing.s5)
                    }
                    if (trueIndex > 6) {
                      marginLeft = -(theme.spacing.s12 - theme.spacing.s1)
                    }
                    return (
                      <View key={app.packageName} style={{zIndex: index, marginLeft: marginLeft}}>
                        <AppIcon app={app} className="w-12 h-12" />
                      </View>
                    )
                  })}
                </View>
              </View>
            </Pressable>
          </GlassView>
        </View>
      </GestureDetector>
      {renderGridButton()}
    </View>
  )
}
