import Svg, {Path} from "react-native-svg"

interface WifiUnlockedIconProps {
  size?: number
  color?: string
}

export const WifiUnlockedIcon = ({size = 24, color = "#0A0A0A"}: WifiUnlockedIconProps) => {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 19.9998H12.01M2 8.81966C4.75011 6.35989 8.31034 5 12 5C15.6897 5 19.2499 6.35989 22 8.81966M5 12.8588C6.86929 11.0265 9.38247 10.0002 12 10.0002C14.6175 10.0002 17.1307 11.0265 19 12.8588M8.5 16.4288C9.43464 15.5127 10.6912 14.9995 12 14.9995C13.3088 14.9995 14.5654 15.5127 15.5 16.4288"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  )
}
