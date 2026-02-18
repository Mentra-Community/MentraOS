import {StyleProp, View, ViewStyle} from "react-native"
import {withUniwind} from "uniwind"

interface SpacerProps {
  height?: number
  width?: number
  style?: StyleProp<ViewStyle>
}

export const SpacerBase = ({height, width, style}: SpacerProps) => {
  return <View style={[style, {height, width}]} />
}

export const Spacer = withUniwind(SpacerBase)
