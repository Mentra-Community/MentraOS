import {useFocusEffect} from "@react-navigation/native"
import {useCallback, useState} from "react"
import {TouchableOpacity, ViewStyle} from "react-native"
import {useSaferAreaInsets} from "@/contexts/SaferAreaContext"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/contexts/ThemeContext"
import {ThemedStyle} from "@/theme"
import {engine} from "@mentra/engine"

interface SimulatedGlassesControlsProps {}

export const SimulatedGlassesControls: React.FC<SimulatedGlassesControlsProps> = () => {
  const {themed} = useAppTheme()
  const insets = useSaferAreaInsets()
  const [showDashboard, setShowDashboard] = useState(false)
  const {setView} = engine.display.mirror

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

  // The simulated hardware-button control was removed with Cloud V1 app
  // end-of-life: its only effect was relaying a button_press onto the V1
  // socket for cloud-SDK apps. Local miniapps receive button presses from
  // real device events via island's DeviceEventRouter.

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

const $rightSide: ThemedStyle<ViewStyle> = () => ({
  right: 20,
})
