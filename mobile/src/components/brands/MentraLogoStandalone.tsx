import Svg, {Rect, Path, SvgProps} from "react-native-svg"

interface LogoProps extends SvgProps {
  width?: number
  height?: number
  fill?: string
}

export const MentraLogoStandalone: React.FC<LogoProps> = ({width = 33, height = 16, fill = "#00B869", ...props}) => (
  <Svg width={width} height={height} viewBox="0 0 33 16" fill="none" {...props}>
    <Rect y={8.88867} width={7.81818} height={7.11111} fill={fill} />
    <Path d="M6.18182 0L20.2727 8.88889V16L6.18182 7.11111V0Z" fill={fill} />
    <Path d="M18.9091 0L33 8.88889V16L18.9091 7.11111V0Z" fill={fill} />
  </Svg>
)
