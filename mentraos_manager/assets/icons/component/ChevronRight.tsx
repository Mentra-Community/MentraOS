import React from "react"
import Svg, {Path} from "react-native-svg"

interface ChevronRightProps {
  color?: string
  size?: number
}

const ChevronRight = ({color = "#fff", size = 24}: ChevronRightProps) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path
      d="M9.09998 18.4766L15.1 12.4766L9.09998 6.47656"
      stroke={color}
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </Svg>
)

export default ChevronRight
