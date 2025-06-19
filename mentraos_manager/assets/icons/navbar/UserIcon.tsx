// in ../icons/UserIcon.tsx
import React from "react"
import Svg, {Path, G, Defs, ClipPath, Rect} from "react-native-svg"

interface UserIconProps {
  color?: string
  size?: number
}

const UserIcon = ({color = "#F9F8FE", size = 25}: UserIconProps) => (
  <Svg width={size} height={size} viewBox="0 0 25 25" fill="none">
    <G clipPath="url(#clip0)">
      <Path
        d="M21.9792 23.502V21.0684C21.9792 19.7775 21.4694 18.5395 20.5619 17.6267C19.6543 16.714 18.4235 16.2012 17.14 16.2012H7.46155C6.1781 16.2012 4.94722 16.714 4.03969 17.6267C3.13216 18.5395 2.62231 19.7775 2.62231 21.0684V23.502"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M12.3004 11.334C14.973 11.334 17.1396 9.15491 17.1396 6.46682C17.1396 3.77874 14.973 1.59961 12.3004 1.59961C9.62778 1.59961 7.46118 3.77874 7.46118 6.46682C7.46118 9.15491 9.62778 11.334 12.3004 11.334Z"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </G>
    <Defs>
      <ClipPath id="clip0">
        <Rect width="24" height="24" fill="white" transform="translate(0.300049 0.529297)" />
      </ClipPath>
    </Defs>
  </Svg>
)

export default UserIcon
