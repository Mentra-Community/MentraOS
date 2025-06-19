// in ../icons/HomeIcon.tsx
import React from "react"
import Svg, {Path} from "react-native-svg"

interface HomeIconProps {
  color?: string
  size?: number
}

const HomeIcon = ({color = "#565E8C", size = 28}: HomeIconProps) => (
  <Svg width={size} height={size} viewBox="0 0 25 25" fill="none">
    <Path
      d="M3.30005 9.5293L12.3 2.5293L21.3 9.5293V20.5293C21.3 21.0597 21.0893 21.5684 20.7143 21.9435C20.3392 22.3186 19.8305 22.5293 19.3 22.5293H5.30005C4.76962 22.5293 4.26091 22.3186 3.88584 21.9435C3.51076 21.5684 3.30005 21.0597 3.30005 20.5293V9.5293Z"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
)

export default HomeIcon
