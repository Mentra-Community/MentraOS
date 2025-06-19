import React from "react"
import {Svg, Path} from "react-native-svg"

interface CloseXIconProps {
  size?: number
  color?: string
}

export const CloseXIcon = ({size = 25, color = "#F9F8FE"}: CloseXIconProps) => (
  <Svg width={size} height={size} viewBox="0 0 25 25" fill="none">
    <Path d="M18.5 6.72705L6.5 18.7271" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    <Path d="M6.5 6.72705L18.5 18.7271" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
)
