import React from "react"
import {View} from "react-native"

interface SpacerProps {
  height?: number
  width?: number
}

export const Spacer = ({height, width}: SpacerProps) => {
  return <View style={{height, width}} />
}
