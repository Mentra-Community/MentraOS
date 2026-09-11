import {Image} from "react-native"

import {useAppTheme} from "@/contexts/ThemeContext"

interface NimoLogoProps {
  width?: number
  height?: number
  color?: string
}

// Nimo ships its brand mark as a monochrome raster (transparent background), so
// we tint it with the theme text color to get a dark glyph in light mode and a
// white one in dark mode — matching the other wordmarks.
export function NimoLogo({width = 70, height = 14, color}: NimoLogoProps) {
  const {theme} = useAppTheme()
  return (
    <Image
      source={require("../../../assets/logo/nimo.png")}
      style={{width, height, tintColor: color ?? theme.colors.text}}
      resizeMode="contain"
    />
  )
}
