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
  onNavOffRoute: (params: NavOffRoutePayload) => void
  onHeading: (params: HeadingPayload) => void
}

export type NavOffRoutePayload = {
  /** Approximate perpendicular distance in meters from the route. */
  offRouteDistanceMeters: number
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
  /** Road the user is currently on, per the Nav SDK. Null if unavailable. */
  fromRoad?: string | null
  /** Road the user will be on after the maneuver, per the Nav SDK. Null if unavailable. */
  toRoad?: string | null
  /** Total remaining distance to final destination, meters. -1 if unknown. */
  distanceToDestinationMeters?: number
  /** Total remaining travel time, seconds. -1 if unknown. */
  timeToDestinationSeconds?: number
  /** Current speed in m/s. Null if unavailable. */
  currentSpeedMps?: number | null
  /** Speed limit on the current road segment in m/s. Null if unknown / not regulated. */
  speedLimitMps?: number | null
  /** Bearing along the route at the user's current position, 0–360. Null if unknown. */
  routeHeadingDeg?: number | null
}

export type NavErrorPayload = {
  message: string
}

export type CrustViewProps = {
  url: string
  onLoad: (event: {nativeEvent: OnLoadEventPayload}) => void
  style?: StyleProp<ViewStyle>
}
