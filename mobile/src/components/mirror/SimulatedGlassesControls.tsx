import {useFocusEffect} from "@react-navigation/native"
import {useCallback, useState} from "react"
import {TouchableOpacity, ViewStyle} from "react-native"
import {useSafeAreaInsets} from "react-native-safe-area-context"
import Icon from "react-native-vector-icons/MaterialIcons"

import {Text} from "@/components/ignite"
import socketComms from "@/services/SocketComms"
import {useDisplayStore} from "@/stores/display"
import {ThemedStyle} from "@/theme"
import {useAppTheme} from "@/utils/useAppTheme"

interface SimulatedGlassesControlsProps {}

export const SimulatedGlassesControls: React.FC<SimulatedGlassesControlsProps> = () => {
  const {themed, theme} = useAppTheme()
  const insets = useSafeAreaInsets()
  const [showDashboard, setShowDashboard] = useState(false)
  const {setView} = useDisplayStore()

  // when this is unmounted, set the dashboard position to down:
  useFocusEffect(
    useCallback(() => {
      return () => {
        console.log("SimulatedGlassesControls: unmounted, setting dashboard position to down")
        setView("main")
      }
    }, []),
  )

  const setDashboardPosition = async (isHeadUp: boolean) => {
    setView(isHeadUp ? "dashboard" : "main")
  }

  const toggleDashboard = async () => {
    await setDashboardPosition(!showDashboard)
    setShowDashboard(!showDashboard)
  }

  const handleButtonPress = async (pressType: "short" | "long") => {
    console.log(`SimulatedGlassesControls: Button ${pressType} press triggered`)
    try {
      const result = await socketComms.sendButtonPress("camera", pressType)
      console.log(`SimulatedGlassesControls: Button ${pressType} press command sent successfully, result:`, result)
    } catch (error) {
      console.error("Failed to simulate button press:", error)
      console.error("Error details:", JSON.stringify(error))
    }
  }

  // Handle press in/out for detecting short vs long press
  let pressTimer: number | null = null

  const handlePressIn = () => {
    console.log("SimulatedGlassesControls: Button press started")
    // Set a timer for long press (500ms threshold)
    pressTimer = setTimeout(() => {
      handleButtonPress("long")
      pressTimer = null
    }, 500)
  }

  const handlePressOut = () => {
    console.log("SimulatedGlassesControls: Button press ended")
    // If timer is still active, it was a short press
    if (pressTimer) {
      clearTimeout(pressTimer)
      pressTimer = null
      handleButtonPress("short")
    }
  }

  return (
    <>
      {/* Head Up button - right side, upper middle */}
      <TouchableOpacity
        onPress={toggleDashboard}
        style={[
          themed($toggleDashboardButton),
          themed($rightSide),
          {
            bottom: insets.bottom + 40,
            left: 120,
          },
        ]}>
        {showDashboard ? <Text tx="simulatedGlasses:hideDashboard" /> : <Text tx="simulatedGlasses:showDashboard" />}
      </TouchableOpacity>

      {/* Button Press - single button for both short and long press */}
      <TouchableOpacity
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        style={[
          themed($edgeButton),
          {
            bottom: insets.bottom + 40,
            left: 20,
          },
        ]}>
        <Icon name="touch-app" size={24} color={theme.colors.icon} />
      </TouchableOpacity>
    </>
  )
}

const $toggleDashboardButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  paddingHorizontal: 16,
  height: 48,
  width: 160,
  borderRadius: 50,
  justifyContent: "center",
  alignItems: "center",
  zIndex: 20,
  backgroundColor: colors.palette.secondary200,
})

const $edgeButton: ThemedStyle<ViewStyle> = ({colors}) => ({
  position: "absolute",
  paddingHorizontal: 16,
  height: 48,
  // width: 130,
  borderRadius: 50,
  justifyContent: "center",
  alignItems: "center",
  zIndex: 20,
  backgroundColor: colors.palette.secondary200,
})

const $rightSide: ThemedStyle<ViewStyle> = () => ({
  right: 20,
})
