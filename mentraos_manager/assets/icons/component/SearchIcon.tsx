// in ../icons/SearchIcon.tsx
import React from "react"
import Svg, {G, Path, Defs, ClipPath, Rect} from "react-native-svg"

interface SearchIconProps {
  color?: string
  size?: number
}

const SearchIcon = ({color = "#F9F8FE", size = 24}: SearchIconProps) => (
  <Svg width={size} height={size} viewBox="0 0 21 20" fill="none">
    <G clipPath="url(#clip0_58023_2586)">
      <Path
        d="M9 15C12.4518 15 15.25 12.2018 15.25 8.75C15.25 5.29822 12.4518 2.5 9 2.5C5.54822 2.5 2.75 5.29822 2.75 8.75C2.75 12.2018 5.54822 15 9 15Z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M17.75 17.4995L13.9907 13.7402"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </G>
    <Defs>
      <ClipPath id="clip0_58023_2586">
        <Rect width={20} height={20} fill="white" transform="translate(0.25)" />
      </ClipPath>
    </Defs>
  </Svg>
)

export default SearchIcon
