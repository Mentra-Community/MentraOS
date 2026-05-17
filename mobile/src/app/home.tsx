import {useFocusEffect} from "@react-navigation/native"
import {useCallback, useEffect, useRef} from "react"
import {Platform, ScrollView, View} from "react-native"
import {useSharedValue} from "react-native-reanimated"
import {LinearGradient} from "expo-linear-gradient"
import MaskedView from "@react-native-masked-view/masked-view"

import {CustomBackground} from "@/components/home/CustomBackground"
import {AppsGrid} from "@/components/home/AppsGrid"
import {PairGlassesCard} from "@/components/home/PairGlassesCard"
import {Screen} from "@/components/ignite"
import {Group} from "@/components/ui"
import {BgTimer, useRefresh} from "@mentra/island"
import {SETTINGS, useSetting} from "@/stores/settings"
import {useGlassesStore} from "@/stores/glasses"
import {useCoreStore} from "@/stores/core"
import AppSwitcherButton from "@/components/home/AppSwitcherButtton"
import AppSwitcher from "@/components/home/AppSwitcher"
import {GlassesStatus, ControllerStatus} from "@/components/home/DeviceStatus"
import {attemptReconnectToDefaultWearable} from "@/effects/Reconnect"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"
import AllAppsGridSheet from "@/components/home/AllAppsGridSheet"
import BottomSheet from "@gorhom/bottom-sheet"
import {BlurTargetView, BlurView} from "expo-blur"

export default function Homepage() {
  const refreshApps = useRefresh()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)
  const glassesConnected = useGlassesStore((state) => state.connected)
  const isSearching = useCoreStore((state) => state.searching)
  const hasAttemptedInitialConnect = useRef(false)
  const swipeProgress = useSharedValue(0)
  const insets = useSaferAreaInsets()
  const bottomSheetRef = useRef<BottomSheet>(null)
  const blurTargetRef = useRef<View | null>(null)
  const [androidBlur] = useSetting(SETTINGS.android_blur.key)

  useFocusEffect(
    useCallback(() => {
      // timeout allows for screenshots to be saved and read back from storage in time:
      BgTimer.setTimeout(() => {
        refreshApps()
      }, 250)
    }, [refreshApps]),
  )

  useEffect(() => {
    const attemptInitialConnect = async () => {
      if (hasAttemptedInitialConnect.current) {
        return
      }
      let attempted = await attemptReconnectToDefaultWearable()
      if (attempted) {
        hasAttemptedInitialConnect.current = true
      }
    }

    attemptInitialConnect()
  }, [glassesConnected, isSearching, defaultWearable])

  const renderContent = () => {
    if (!defaultWearable) {
      return (
        <>
          <Group>
            <PairGlassesCard />
          </Group>
          <View className="h-2" />
          <View className="flex-1" />
          <AppsGrid />
        </>
      )
    }

    return (
      <>
        <Group>
          <GlassesStatus />
        </Group>
        <Group>
          <ControllerStatus />
        </Group>
        <View className="h-2" />
        <AppsGrid />
      </>
    )
  }

  const handleGridButtonPress = () => {
    bottomSheetRef.current?.expand()
  }

  const renderTopPadding = () => {
    if (Platform.OS === "android" && !androidBlur) {
      return null
    }

    let height = insets.top * 1.5
    let start = 0.6
    if (Platform.OS === "android") {
      // height = insets.top * 1.5
      start = 0.4
    }

    return (
      <MaskedView
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: height,
          zIndex: 10,
          pointerEvents: "none",
        }}
        maskElement={
          <LinearGradient
            colors={["black", "transparent"]}
            locations={[start, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={{position: "absolute", left: 0, right: 0, top: 0, bottom: 0}}
            pointerEvents="none"
          />
        }>
        <BlurView
          intensity={30}
          blurReductionFactor={7}
          className="absolute inset-0"
          blurTarget={blurTargetRef}
          blurMethod="dimezisBlurViewSdk31Plus"
        />
      </MaskedView>
    )
    // solid bar:
    // return (
    //   <BlurView
    //     className="absolute inset-0 z-10 w-full"
    //     style={{height: insets.top}}
    //     intensity={20}
    //     blurReductionFactor={7}
    //     blurTarget={blurTargetRef}
    //     blurMethod="dimezisBlurViewSdk31Plus"
    //   />
    // )
  }

  return (
    <>
      <Screen preset="fixed" className={"px-0"} KeyboardAvoidingViewProps={{enabled: false}}>
        {renderTopPadding()}
        <BlurTargetView ref={blurTargetRef} style={{flex: 1}}>
          <CustomBackground />
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            showsVerticalScrollIndicator={false}
            contentContainerClassName={"px-6"}
            contentContainerStyle={{flexGrow: 1}}
            scrollEventThrottle={16}>
            {Platform.OS === "android" && <View style={{paddingTop: insets.top}} />}
            <View className="h-4" />
            {renderContent()}
            <View className="h-4" />
          </ScrollView>
        </BlurTargetView>

        <View className="px-6">
          <View className="">
            <AppSwitcherButton
              swipeProgress={swipeProgress}
              onGridButtonPress={handleGridButtonPress}
              blurTargetRef={blurTargetRef}
            />
          </View>
        </View>

        <AppSwitcher swipeProgress={swipeProgress} blurTargetRef={blurTargetRef} />
      </Screen>
      <AllAppsGridSheet bottomSheetRef={bottomSheetRef} />
    </>
  )
}
