import {View, ViewStyle, TextStyle} from "react-native"
import Svg, {Circle} from "react-native-svg"

import {Text} from "@/components/ignite"
import {useAppTheme} from "@/utils/useAppTheme"

interface ProgressRingProps {
  progress: number // 0-100
  size?: number
  strokeWidth?: number
  showPercentage?: boolean
  progressColor?: string
  style?: ViewStyle
}

export function ProgressRing({
  progress,
  size = 40,
  strokeWidth = 3,
  showPercentage = true,
  progressColor,
  style,
}: ProgressRingProps) {
  const {theme} = useAppTheme()

  // Clamp progress between 0 and 100 to prevent negative values or overflow
  const clampedProgress = Math.max(0, Math.min(100, progress || 0))

  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const strokeDashoffset = circumference - (clampedProgress / 100) * circumference

  const center = size / 2

  return (
    <View style={[{width: size, height: size}, style]}>
      <Svg width={size} height={size} style={{position: "absolute"}}>
        {/* Background circle */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={theme.colors.border}
          strokeWidth={strokeWidth}
          fill="transparent"
          opacity={0.3}
        />
        {/* Progress circle */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={progressColor || theme.colors.tint}
          strokeWidth={strokeWidth}
          fill="transparent"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </Svg>

      {showPercentage && (
        <View style={$percentageContainer}>
          <Text style={[$percentageText, {color: theme.colors.text}]}>{Math.round(clampedProgress)}%</Text>
        </View>
      )}
    </View>
  )
}

const $percentageContainer: ViewStyle = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  justifyContent: "center",
  alignItems: "center",
}

const $percentageText: TextStyle = {
  fontSize: 10,
  fontWeight: "600",
  textAlign: "center",
}
