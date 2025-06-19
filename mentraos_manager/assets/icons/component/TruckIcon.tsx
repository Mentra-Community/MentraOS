import React from "react"
import {Svg, Path} from "react-native-svg"

interface TruckIconProps {
  size?: number
  color?: string
}

export const TruckIcon = ({size = 25, color = "#F7F7F7"}: TruckIconProps) => (
  <Svg width={size} height={size} viewBox="0 0 25 25" fill="none">
    <Path
      d="M7.25787 19.1437C8.41592 19.1437 9.35461 18.205 9.35461 17.0469C9.35461 15.8889 8.41592 14.9502 7.25787 14.9502C6.09982 14.9502 5.16113 15.8889 5.16113 17.0469C5.16113 18.205 6.09992 19.1437 7.25787 19.1437Z"
      stroke={color}
      strokeMiterlimit="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M17.7418 19.1437C18.8997 19.1437 19.8385 18.205 19.8385 17.0469C19.8385 15.8889 18.8997 14.9502 17.7418 14.9502C16.5838 14.9502 15.645 15.8889 15.645 17.0469C15.645 18.205 16.5837 19.1437 17.7418 19.1437Z"
      stroke={color}
      strokeMiterlimit="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <Path
      d="M14.5965 17.0468V6.1437C14.5965 5.7963 14.315 5.51465 13.9675 5.51465H2.64507C2.29767 5.51465 2.01611 5.7963 2.01611 6.1437V16.4177C2.01611 16.7652 2.29767 17.0468 2.64507 17.0468H4.79423"
      stroke={color}
      strokeLinecap="round"
    />
    <Path d="M14.5966 17.0469H9.40723" stroke={color} strokeLinecap="round" />
    <Path
      d="M14.5967 8.65967H20.4782C20.7268 8.65967 20.9521 8.80601 21.053 9.03323L22.9295 13.2553C22.9652 13.3358 22.9836 13.4228 22.9836 13.5108V16.4176C22.9836 16.7651 22.7021 17.0466 22.3547 17.0466H20.3628"
      stroke={color}
      strokeLinecap="round"
    />
    <Path d="M14.5967 17.0469H15.6451" stroke={color} strokeLinecap="round" />
  </Svg>
)
