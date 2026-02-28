import Svg, {Path} from "react-native-svg"

interface WifiIconProps {
  size?: number
  color?: string
}

export const WifiIcon = ({size = 48, color = "#00B869"}: WifiIconProps) => {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      <Path
        d="M23.9995 39.9995H24.0195M3.99951 17.6393C9.49973 12.7198 16.6202 10 23.9995 10C31.3788 10 38.4993 12.7198 43.9995 17.6393M9.99951 25.7176C13.7381 22.0531 18.7645 20.0005 23.9995 20.0005C29.2346 20.0005 34.2609 22.0531 37.9995 25.7176M16.9995 32.8576C18.8688 31.0253 21.382 29.999 23.9995 29.999C26.617 29.999 29.1302 31.0253 30.9995 32.8576"
        stroke={color}
        strokeWidth="4.01143"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}
