// Enhanced ImageBackground component with error handling
import React, {useState} from "react"
import {ImageBackground, ImageStyle, StyleProp, ImageSourcePropType} from "react-native"
import {DEFAULT_ICON} from "../logic/getAppImage"

interface FallbackImageBackgroundProps {
  source: ImageSourcePropType
  style?: StyleProp<ImageStyle>
  imageStyle?: StyleProp<ImageStyle>
  fallbackSource?: ImageSourcePropType
  children?: React.ReactNode
}

export const FallbackImageBackground: React.FC<FallbackImageBackgroundProps> = ({
  source,
  style,
  imageStyle,
  fallbackSource = DEFAULT_ICON,
  children,
}) => {
  const [imageError, setImageError] = useState(false)

  const handleImageError = () => {
    setImageError(true)
  }

  return (
    <ImageBackground
      source={imageError ? fallbackSource : source}
      style={style}
      imageStyle={imageStyle}
      onError={handleImageError}>
      {children}
    </ImageBackground>
  )
}
