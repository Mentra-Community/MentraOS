import {View, ViewProps} from "react-native"
import Svg, {Path} from "react-native-svg"

interface MinimizeIconProps extends Omit<ViewProps, "style"> {
  size?: number
  color?: string
  containerStyle?: ViewProps["style"]
  fill?: string
}

export function MinimizeIcon({size = 14, containerStyle, color = "rgb(0 0 0 / 78%)", ...viewProps}: MinimizeIconProps) {
  return (
    <View {...viewProps} style={containerStyle}>
      <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <Path d="M0.998 7L12.998 7" stroke={color} strokeWidth={2} strokeLinecap="round" />
      </Svg>
    </View>
  )
}
