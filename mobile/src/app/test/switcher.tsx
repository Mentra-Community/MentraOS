import {useState, useEffect, useCallback} from "react"
import {View, Pressable, Text} from "react-native"
import {Asset} from "expo-asset"
import Animated, {useSharedValue, useAnimatedStyle, withSpring, withTiming} from "react-native-reanimated"
import {GestureHandlerRootView} from "react-native-gesture-handler"

import {Screen, Header} from "@/components/ignite"
import {useNavigationHistory} from "@/contexts/NavigationHistoryContext"
import AppSwitcher, {AppCard} from "@/components/home/AppSwitcher"

// Example apps with colors for visual variety
const INITIAL_APPS: AppCard[] = [
  {id: "1", name: "Messages", color: "#34C759"},
  {id: "2", name: "Safari", color: "#007AFF"},
  {id: "3", name: "Photos", color: "#FF9500"},
  {id: "4", name: "Settings", color: "#8E8E93"},
  {id: "5", name: "Music", color: "#FF2D55"},
  {id: "6", name: "Mail", color: "#5AC8FA"},
]

export default function MiniApp() {
  const {goBack} = useNavigationHistory()
  const [showSwitcher, setShowSwitcher] = useState(false)
  const [apps, setApps] = useState<AppCard[]>(INITIAL_APPS)

  // Animation values for the main content when switcher is open
  const contentScale = useSharedValue(1)
  const contentBorderRadius = useSharedValue(0)

  useEffect(() => {
    if (showSwitcher) {
      contentScale.value = withSpring(0.88, {damping: 20, stiffness: 120})
      contentBorderRadius.value = withTiming(40, {duration: 250})
    } else {
      contentScale.value = withSpring(1, {damping: 20, stiffness: 120})
      contentBorderRadius.value = withTiming(0, {duration: 200})
    }
  }, [showSwitcher])

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{scale: contentScale.value}],
    borderRadius: contentBorderRadius.value,
    overflow: "hidden",
  }))

  const handleOpenSwitcher = useCallback(() => {
    setShowSwitcher(true)
  }, [])

  const handleCloseSwitcher = useCallback(() => {
    setShowSwitcher(false)
  }, [])

  const handleAppSelect = useCallback((id: string) => {
    console.log("Selected app:", id)
    // Here you would navigate to the selected app
    // For demo, we just close the switcher
    setShowSwitcher(false)
  }, [])

  const handleAppDismiss = useCallback((id: string) => {
    setApps((prev) => prev.filter((app) => app.id !== id))
  }, [])

  return (
    <Screen preset="fixed">
      <Header title="App Switcher" leftIcon="chevron-left" onLeftPress={goBack} />

      <View className="flex-1 justify-center items-center">
        <Text className="text-white text-2xl font-bold">App Switcher</Text>
        <Pressable className="bg-blue-500 px-4 py-2 rounded-md" onPress={handleOpenSwitcher}>
          <Text className="text-white text-lg font-bold">Open Switcher</Text>
        </Pressable>
      </View>

      {/* App Switcher Overlay */}
      <AppSwitcher
        visible={showSwitcher}
        onClose={handleCloseSwitcher}
        apps={apps}
        onAppSelect={handleAppSelect}
        onAppDismiss={handleAppDismiss}
      />
    </Screen>
  )
}
