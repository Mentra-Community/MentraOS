import type {StyleProp, ViewStyle} from "react-native"

export type OnLoadEventPayload = {
  url: string
}

export type CrustModuleEvents = {
  onChange: (params: ChangeEventPayload) => void
  onNavManeuver: (params: NavManeuverPayload) => void
  onNavRerouting: (params: Record<string, never>) => void
  onNavArrived: (params: Record<string, never>) => void
  onNavError: (params: NavErrorPayload) => void
  onNavLocation: (params: NavLocationPayload) => void
  onNavRoute: (params: NavRoutePayload) => void
  onHeading: (params: HeadingPayload) => void
}

export type HeadingPayload = {
  /** Compass heading in degrees, 0 = north, 90 = east. */
  degrees: number
}

export type NavRoutePayload = {
  points: Array<{lat: number; lng: number}>
}

export type NavLocationPayload = {
  lat: number
  lng: number
  /** Horizontal accuracy in meters, if reported by the platform. */
  accuracy: number | null
  /** Unix ms timestamp of the fix. */
  timestamp: number
}

export type ChangeEventPayload = {
  value: string
}

export type NavManeuverPayload = {
  /**
   * Categorical type of the upcoming maneuver. One of: STRAIGHT,
   * SLIGHT_LEFT, SLIGHT_RIGHT, TURN_LEFT, TURN_RIGHT, SHARP_LEFT,
   * SHARP_RIGHT, U_TURN, ARRIVE.
   */
  maneuverType: string
  /** Distance in meters from the user's current position to that maneuver. -1 if unknown. */
  distanceMeters: number
}

export type NavErrorPayload = {
  message: string
}

export type CrustViewProps = {
  url: string
  onLoad: (event: {nativeEvent: OnLoadEventPayload}) => void
  style?: StyleProp<ViewStyle>
}
