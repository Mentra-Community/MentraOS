// in ../icons/StoreIcon.tsx
import React from "react"
import Svg, {Path} from "react-native-svg"

interface StoreIconProps {
  color?: string
  size?: number
}

const StoreIcon = ({color = "#565E8C", size = 25}: StoreIconProps) => (
  <Svg width={size} height={size} viewBox="0 0 25 25" fill="none">
    <Path
      d="M3.30005 6.97168V20.9717C3.30005 21.5021 3.51076 22.0108 3.88584 22.3859C4.26091 22.761 4.76962 22.9717 5.30005 22.9717H19.3C19.8305 22.9717 20.3392 22.761 20.7143 22.3859C21.0893 22.0108 21.3 21.5021 21.3 20.9717V6.97168"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path d="M3.30005 6.97168H21.3" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <Path
      d="M8.30005 6.08691C8.30005 5.02605 8.72148 4.00863 9.47162 3.25849C10.2218 2.50834 11.2392 2.08691 12.3 2.08691C13.3609 2.08691 14.3783 2.50834 15.1285 3.25849C15.8786 4.00863 16.3 5.02605 16.3 6.08691"
      stroke={color}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
)

export default StoreIcon
