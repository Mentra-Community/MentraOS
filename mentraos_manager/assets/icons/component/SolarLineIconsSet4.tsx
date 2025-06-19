// in ../icons/SolarLineIconsSet4.tsx
import React from "react"
import Svg, {Path} from "react-native-svg"

interface SolarLineIconsSet4Props {
  color?: string
  size?: number
}

const SolarLineIconsSet4 = ({color = "#F9F8FE", size = 24}: SolarLineIconsSet4Props) => (
  <Svg width={size} height={size} viewBox="0 0 24 25" fill="none">
    <Path
      d="M14.1626 17.0329L13.4533 16.7798C12.5134 16.4445 11.4864 16.4445 10.5464 16.7798L9.83716 17.0329"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
    />
    <Path
      d="M1.1864 16.8024L2.01164 7.7248C2.13591 6.35785 2.19804 5.67438 2.59815 5.1692C2.99825 4.66403 3.64932 4.447 4.95147 4.01295L5.51181 3.82617"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
    />
    <Path
      d="M22.8135 16.8024L21.9882 7.7248C21.8639 6.35785 21.8018 5.67438 21.4017 5.1692C21.0016 4.66403 20.3506 4.447 19.0484 4.01295L18.488 3.82617"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
    />
    <Path
      d="M18.488 21.1274C20.8768 21.1274 22.8134 19.1908 22.8134 16.802C22.8134 14.4132 20.8768 12.4766 18.488 12.4766C16.0992 12.4766 14.1626 14.4132 14.1626 16.802C14.1626 19.1908 16.0992 21.1274 18.488 21.1274Z"
      stroke={color}
      strokeWidth={1.8}
    />
    <Path
      d="M5.51181 21.1274C7.90067 21.1274 9.83723 19.1908 9.83723 16.802C9.83723 14.4132 7.90067 12.4766 5.51181 12.4766C3.12295 12.4766 1.1864 14.4132 1.1864 16.802C1.1864 19.1908 3.12295 21.1274 5.51181 21.1274Z"
      stroke={color}
      strokeWidth={1.8}
    />
  </Svg>
)

export default SolarLineIconsSet4
