// in ../icons/NotificationOn.tsx
import Svg, {G, Path, Defs, ClipPath, Rect} from "react-native-svg"

import {useAppTheme} from "@/utils/useAppTheme"

interface NotificationOnProps {
  color?: string
  size?: number
}

const NotificationOn = ({color, size = 24}: NotificationOnProps) => {
  const {theme} = useAppTheme()
  const iconColor = color || theme.colors.icon

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <G clipPath="url(#clip0_218_3966)">
        <Path
          d="M18.5069 11.3837C19.1171 17.0201 21.5125 18.7235 21.5125 18.7235H2.63867C2.63867 18.7235 5.78431 16.4866 5.78431 8.65741C5.78431 6.87769 6.44718 5.1708 7.62699 3.91232C8.80689 2.65374 10.407 1.94678 12.0756 1.94678C12.4293 1.94678 12.7799 1.9785 13.1242 2.0406"
          stroke={iconColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d="M13.8897 21.8687C13.7053 22.1864 13.4408 22.4503 13.1223 22.6336C12.804 22.8169 12.4431 22.9135 12.0757 22.9135C11.7083 22.9135 11.3474 22.8169 11.0291 22.6336C10.7107 22.4503 10.446 22.1864 10.2617 21.8687"
          stroke={iconColor}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path
          d="M19.4152 8.23804C21.1524 8.23804 22.5607 6.82968 22.5607 5.09241C22.5607 3.35514 21.1524 1.94678 19.4152 1.94678C17.6779 1.94678 16.2695 3.35514 16.2695 5.09241C16.2695 6.82968 17.6778 8.23804 19.4152 8.23804Z"
          fill="#FF3B30"
          stroke="#FF3B30"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </G>
      <Defs>
        <ClipPath id="clip0_218_3966">
          <Rect width={24} height={24} fill="white" transform="translate(0.599609 0.430176)" />
        </ClipPath>
      </Defs>
    </Svg>
  )
}

export default NotificationOn
