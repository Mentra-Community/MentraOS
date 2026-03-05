import Svg, {Rect, Path, SvgProps} from "react-native-svg"
import {useAppTheme} from "@/contexts/ThemeContext"

interface LogoProps extends SvgProps {
  width?: number
  height?: number
  fill?: string
}

export const MentraLogoStandalone: React.FC<LogoProps> = ({width = 33, height = 16}) => {
  const {theme} = useAppTheme()
  const isDark = theme.isDark
  const color = isDark ? "#36DD89" : "#00B869"
  return (
  <Svg width={width} height={height} viewBox="0 0 50 27" fill="none">
    <Rect y={14.8072} width={11.8457} height={11.8457} fill={color} />
    <Path d="M9.36639 0L30.7163 14.8072V26.6529L9.36639 11.8457V0Z" fill={color} />
    <Path d="M28.6501 0L50 14.8072V26.6529L28.6501 11.8457V0Z" fill={color} />
  </Svg>
)}
