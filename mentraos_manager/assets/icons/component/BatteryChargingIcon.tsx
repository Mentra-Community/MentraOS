import React from "react"
import {Svg, Path, G, Defs, ClipPath, Rect} from "react-native-svg"

interface BatteryChargingIconProps {
  size?: number
  color?: string
}

export const BatteryChargingIcon = ({size = 16, color = "#D5D8F5"}: BatteryChargingIconProps) => (
  <Svg width={size + 1} height={size} viewBox="0 0 17 16" fill="none">
    <G clipPath="url(#clip0)">
      <Path
        d="M3.87153 12H2.60788C2.27274 12 1.95133 11.8595 1.71435 11.6095C1.47737 11.3594 1.34424 11.0203 1.34424 10.6667V5.33333C1.34424 4.97971 1.47737 4.64057 1.71435 4.39052C1.95133 4.14048 2.27274 4 2.60788 4H4.62339M10.1897 4H11.4534C11.7885 4 12.1099 4.14048 12.3469 4.39052C12.5839 4.64057 12.717 4.97971 12.717 5.33333V10.6667C12.717 11.0203 12.5839 11.3594 12.3469 11.6095C12.1099 11.8595 11.7885 12 11.4534 12H9.43788"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M15.2446 8.66732V7.33398" stroke={color} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M7.6626 4L5.13531 8H8.92625L6.39896 12" stroke={color} strokeLinecap="round" strokeLinejoin="round" />
    </G>
    <Defs>
      <ClipPath id="clip0">
        <Rect width="16" height="16" fill="white" transform="translate(0.25)" />
      </ClipPath>
    </Defs>
  </Svg>
)
