import Svg, {Rect} from "react-native-svg"

const MicrosoftIcon = ({size = 20}: {size?: number}) => (
  <Svg width={size} height={size} viewBox="0 0 21 21">
    <Rect x="1" y="1" width="9" height="9" fill="#F25022" />
    <Rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
    <Rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
    <Rect x="11" y="11" width="9" height="9" fill="#FFB900" />
  </Svg>
)

export default MicrosoftIcon
