import React from "react"
import {Svg, Path} from "react-native-svg"

interface ArrowLeftIconProps {
  size?: number
  color?: string
}

export const ArrowLeftIcon = ({size = 17, color = "#F9F8FE"}: ArrowLeftIconProps) => (
  <Svg width={(size * 21) / 17} height={size} viewBox="0 0 21 17" fill="none">
    <Path
      d="M16.2411 8.72705L5.75879 8.72705"
      stroke={color}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M9 12.7271L5 8.72705L9 4.72705"
      stroke={color}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
)
