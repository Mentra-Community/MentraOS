import {useLocalSearchParams} from "expo-router"
import {useRef, useState, useEffect} from "react"
import {View, StyleSheet} from "react-native"
import Animated, {useSharedValue, useAnimatedStyle, withTiming, runOnJS} from "react-native-reanimated"
import {Screen, Text} from "@/components/ignite"
import LoadingOverlay from "@/components/ui/LoadingOverlay"
import {useAppletStatusStore} from "@/stores/applets"
import {Image} from "expo-image"
import composer from "@/services/Composer"
import LocalMiniApp from "@/components/home/LocalMiniApp"
import {scheduleOnRN} from "react-native-worklets"
import {MiniAppDualButtonHeader} from "@/components/miniapps/DualButton"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"

export default function LocalMiniAppPage() {
  const {appName, packageName, version} = useLocalSearchParams()
  const viewShotRef = useRef<View>(null)
  // const [html, setHtml] = useState<string | null>(null)
  // const [showLoadingOverlay, setShowLoadingOverlay] = useState(true)
  // const {push} = useNavigationHistory()

  // const contentOpacity = useSharedValue(0)
  // const loadingOpacity = useSharedValue(1)

  // const contentAnimatedStyle = useAnimatedStyle(() => ({
  //   opacity: contentOpacity.value,
  // }))

  // const loadingAnimatedStyle = useAnimatedStyle(() => ({
  //   opacity: loadingOpacity.value,
  // }))

  // if (typeof appName !== "string" || typeof packageName !== "string") {
  //   return <Text>Missing required parameters</Text>
  // }

  // useEffect(() => {
  //   const loadHtml = async () => {
  //     const htmlRes = composer.getLocalMiniAppHtml(packageName, version as string)
  //     if (htmlRes.is_ok()) {
  //       setHtml(htmlRes.value)
  //     } else {
  //       console.error("LOCAL: Error getting local mini app html", htmlRes.error)
  //       setHtml("<div>Error loading local mini app</div>")
  //     }

  //     // Fade in content, fade out loading
  //     contentOpacity.value = withTiming(1, {duration: 200})
  //     loadingOpacity.value = withTiming(0, {duration: 600}, (finished) => {
  //       if (finished) {
  //         scheduleOnRN(() => setShowLoadingOverlay(false))
  //       }
  //     })
  //   }
  //   loadHtml()
  // }, [packageName, version])

  // const getScreenshot = () => {
  //   const screenshot = useAppletStatusStore.getState().apps.find((a) => a.packageName === packageName)?.screenshot
  //   if (screenshot) {
  //     return <Image source={{uri: screenshot}} style={StyleSheet.absoluteFill} />
  //   }
  //   return null
  // }

  return (
    <Screen preset="fixed" safeAreaEdges={["top"]} KeyboardAvoidingViewProps={{enabled: true}} ref={viewShotRef}>
      {/* <MiniAppDualButtonHeader
        packageName={packageName}
        viewShotRef={viewShotRef}
        onEllipsisPress={() => {
          push("/applet/settings", {
            packageName: packageName as string,
            appName: appName as string,
            fromWebView: "true",
          })
        }}
      />
      <View className="flex-1 -mx-6">
        {showLoadingOverlay && (
          <Animated.View style={[StyleSheet.absoluteFill, loadingAnimatedStyle, {zIndex: 1}]} pointerEvents="none">
            {getScreenshot() || <LoadingOverlay />}
          </Animated.View>
        )}
        <Animated.View style={[{flex: 1}, contentAnimatedStyle]}>
          {html && <LocalMiniApp html={html} packageName={packageName} />}
        </Animated.View>
      </View> */}
      <Text>
        Local Mini App: {appName} {packageName} {version}
      </Text>
    </Screen>
  )
}
