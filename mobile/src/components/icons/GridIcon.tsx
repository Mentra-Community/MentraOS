import Svg, {Rect} from "react-native-svg"

interface GridIconProps {
  size?: number
  color?: string
}

export const GridIcon = ({size = 22, color = "#0A0A0A"}: GridIconProps) => {
  return (
    <Svg width={size} height={size} viewBox="0 0 22 22" fill="none">
      <Rect width="4.4" height="4.4" rx="1" fill={color} />
      <Rect x="8.7998" width="4.4" height="4.4" rx="1" fill={color} />
      <Rect x="17.5996" width="4.4" height="4.4" rx="1" fill={color} />
      <Rect y="8.7998" width="4.4" height="4.4" rx="1" fill={color} />
      <Rect x="8.7998" y="8.7998" width="4.4" height="4.4" rx="1" fill={color} />
      <Rect x="17.5996" y="8.7998" width="4.4" height="4.4" rx="1" fill={color} />
      <Rect y="17.5996" width="4.4" height="4.4" rx="1" fill={color} />
      <Rect x="8.7998" y="17.5996" width="4.4" height="4.4" rx="1" fill={color} />
      <Rect x="17.5996" y="17.5996" width="4.4" height="4.4" rx="1" fill={color} />
    </Svg>
  )
}
