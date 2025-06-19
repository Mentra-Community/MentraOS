// in ../icons/MicIcon.tsx
import React from "react"
import {View, TouchableOpacity} from "react-native"
import Svg, {G, Path, Defs, ClipPath, Rect} from "react-native-svg"
import {useAppTheme} from "@/utils/useAppTheme"
import {useStatus} from "@/contexts/MentraOSStatusProvider"
import showAlert from "@/utils/AlertUtils"
import {translate} from "@/i18n"
interface MicIconProps {
  color?: string
  height?: number
  width?: number
  withBackground?: boolean
}

const MicIcon = ({color, width = 17, height = 16, withBackground = false}: MicIconProps) => {
  const {themed, theme} = useAppTheme()
  const {status} = useStatus()
  
  const iconColor = color || theme.colors.icon

  const handleMicPress = () => {
    showAlert(
      translate("warning:microphoneActive"),
      translate("warning:microphoneActiveMessage"),
      [{text: translate("common:ok")}],
      {
        iconName: "microphone",
        iconColor: theme.colors.icon,
      }
    )
  }

  // Don't show mic indicator if:
  // 1. Mic is not enabled for frontend OR
  // 2. Preferred mic is glasses but no glasses are connected
  if (!status.core_info.is_mic_enabled_for_frontend) {
    return null
  }

  if (status.core_info.preferred_mic === "glasses" && !status.glasses_info) {
    return null
  }

  const svgElement = (
    <Svg width={width} height={height} viewBox="0 0 17 16" fill="none">
      <G clipPath="url(#clip0_986_37039)">
        <Path
          d="M8.25 0.666992C7.71957 0.666992 7.21086 0.877706 6.83579 1.25278C6.46071 1.62785 6.25 2.13656 6.25 2.66699V8.00033C6.25 8.53076 6.46071 9.03947 6.83579 9.41454C7.21086 9.78961 7.71957 10.0003 8.25 10.0003C8.78043 10.0003 9.28914 9.78961 9.66421 9.41454C10.0393 9.03947 10.25 8.53076 10.25 8.00033V2.66699C10.25 2.13656 10.0393 1.62785 9.66421 1.25278C9.28914 0.877706 8.78043 0.666992 8.25 0.666992Z"
          stroke={iconColor}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d="M12.9167 6.66699V8.00033C12.9167 9.238 12.425 10.425 11.5499 11.3002C10.6747 12.1753 9.48772 12.667 8.25004 12.667C7.01236 12.667 5.82538 12.1753 4.95021 11.3002C4.07504 10.425 3.58337 9.238 3.58337 8.00033V6.66699"
          stroke={iconColor}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path d="M8.25 12.667V15.3337" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        <Path
          d="M5.58337 15.333H10.9167"
          stroke={iconColor}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </G>
      <Defs>
        <ClipPath id="clip0_986_37039">
          <Rect width={16} height={16} fill="white" transform="translate(0.25)" />
        </ClipPath>
      </Defs>
    </Svg>
  )

  if (withBackground) {
    return (
      <TouchableOpacity onPress={handleMicPress}>
        <View
          style={{
            backgroundColor: "#23889C",
            borderRadius: 20,
            padding: 6,
            marginLeft: 8,
            justifyContent: "center",
            alignItems: "center",
          }}>
          {svgElement}
        </View>
      </TouchableOpacity>
    )
  }

  return (
    <TouchableOpacity onPress={handleMicPress}>
      {svgElement}
    </TouchableOpacity>
  )
}

export default MicIcon
