// in ../icons/NotificationOff.tsx
import React from "react"
import Svg, {G, Path, Defs, ClipPath, Rect} from "react-native-svg"

interface NotificationOffProps {
  color?: string
  size?: number
}

const NotificationOff = ({color = "#565E8C", size = 24}: NotificationOffProps) => (
  <Svg width={size} height={size} viewBox="0 0 25 25" fill="none">
    <G clipPath="url(#clip0_218_3968)">
      <Path
        d="M21.5125 18.7235H2.63867C2.63867 18.7235 5.78431 16.4866 5.78431 8.65741C5.78431 6.87769 6.44718 5.1708 7.62699 3.91232C8.80689 2.65374 10.407 1.94678 12.0756 1.94678"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M2.63792 18.7235H21.5117C21.5117 18.7235 18.3661 16.4866 18.3661 8.65741C18.3661 6.87769 17.7032 5.1708 16.5234 3.91232C15.3435 2.65374 13.7434 1.94678 12.0748 1.94678"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M13.8897 21.8687C13.7053 22.1864 13.4408 22.4503 13.1223 22.6336C12.804 22.8169 12.4431 22.9135 12.0757 22.9135C11.7083 22.9135 11.3474 22.8169 11.0291 22.6336C10.7107 22.4503 10.446 22.1864 10.2617 21.8687"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </G>
    <Defs>
      <ClipPath id="clip0_218_3968">
        <Rect width={24} height={24} fill="white" transform="translate(0.599609 0.430176)" />
      </ClipPath>
    </Defs>
  </Svg>
)

export default NotificationOff
