import {SvgXml} from "react-native-svg"

import {useAppTheme} from "@/utils/useAppTheme"

interface GlassesIconProps {
  size?: number
  color?: string
  isDark?: boolean
}

export function GlassesIcon({size = 24, color, isDark: isDarkProp}: GlassesIconProps) {
  const {theme} = useAppTheme()
  const isDark = isDarkProp ?? theme.isDark
  const fillColor = color || (isDark ? "#D3D3D3" : "#232323")

  const glassesSvg = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M1.5 9H3.00005V15.0002H1.5V9Z" fill="${fillColor}"/>
<path d="M13.502 12H15.002V15.0001H13.502V12Z" fill="${fillColor}"/>
<path d="M12 9H13.5001V12.0001H12V9Z" fill="${fillColor}"/>
<path d="M10.5 9H12.0001V12.0001H10.5V9Z" fill="${fillColor}"/>
<path d="M10.5 10.5H13.5001V12.0001H10.5V10.5Z" fill="${fillColor}"/>
<path d="M9.00195 12H10.502V15.0001H9.00195V12Z" fill="${fillColor}"/>
<path d="M21 9H22.5001V15.0002H21V9Z" fill="${fillColor}"/>
<path d="M3 7.5H10.5003V9.00005H3V7.5Z" fill="${fillColor}"/>
<path d="M13.502 7.5H21.0022V9.00005H13.502V7.5Z" fill="${fillColor}"/>
<path d="M3 15H9.00021V16.5001H3V15Z" fill="${fillColor}"/>
<path d="M15 15H21.0002V16.5001H15V15Z" fill="${fillColor}"/>
</svg>`

  return <SvgXml xml={glassesSvg} width={size} height={size} />
}
