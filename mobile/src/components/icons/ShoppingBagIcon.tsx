import {View, ViewProps} from "react-native"
import Svg, {Path} from "react-native-svg"

import {Theme} from "@/theme"

interface ShoppingBagIconProps extends Omit<ViewProps, "style"> {
  size?: number
  color?: string
  theme: Theme
  containerStyle?: ViewProps["style"]
  fill?: string
}

export function ShoppingBagIcon({size = 24, color, fill, containerStyle, ...viewProps}: ShoppingBagIconProps) {
  return (
    <View {...viewProps} style={containerStyle}>
      <Svg width={size} height={size} viewBox="0 0 25 25" fill="none">
        {/* Handle arc - filled */}
        <Path
          d="M8 5.55664C8 4.49577 8.42143 3.47836 9.17157 2.72821C9.92172 1.97807 10.9391 1.55664 12 1.55664C13.0609 1.55664 14.0783 1.97807 14.8284 2.72821C15.5786 3.47836 16 4.49578 16 5.55664"
          fill={color}
        />
        {/* Bag body - filled */}
        <Path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M3 6.4419V20.4419C3 20.9723 3.21071 21.481 3.58579 21.8561C3.96086 22.2312 4.46957 22.4419 5 22.4419H19C19.5304 22.4419 20.0391 22.2312 20.4142 21.8561C20.7893 21.481 21 20.9723 21 20.4419V6.4419H3Z"
          fill={color}
        />
        {/* Outline strokes */}
        <Path
          d="M8 5.55664C8 4.49577 8.42143 3.47836 9.17157 2.72821C9.92172 1.97807 10.9391 1.55664 12 1.55664C13.0609 1.55664 14.0783 1.97807 14.8284 2.72821C15.5786 3.47836 16 4.49578 16 5.55664M3 6.4419V20.4419C3 20.9723 3.21071 21.481 3.58579 21.8561C3.96086 22.2312 4.46957 22.4419 5 22.4419H19C19.5304 22.4419 20.0391 22.2312 20.4142 21.8561C20.7893 21.481 21 20.9723 21 20.4419V6.4419H3Z"
          stroke={fill}
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  )
}
