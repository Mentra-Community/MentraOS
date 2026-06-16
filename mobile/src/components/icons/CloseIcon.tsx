import {View, ViewProps} from "react-native"
import Svg, {Path} from "react-native-svg"

interface CloseIconProps extends Omit<ViewProps, "style"> {
  size?: number
  color?: string
  containerStyle?: ViewProps["style"]
  fill?: string
}

export function CloseIcon({size = 14, containerStyle, color = "rgb(0 0 0 / 78%)", ...viewProps}: CloseIconProps) {
  return (
    <View {...viewProps} style={containerStyle}>
      <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <Path
          d="M 3 3 L 11 11 M 11 3 L 3 11"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
        />
      </Svg>
    </View>
  )
}
