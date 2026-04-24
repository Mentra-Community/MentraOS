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
  instruction: string
  roadName: string
  maneuverType: string
  /** Distance in meters to the next maneuver. -1 if unknown. */
  distanceMeters: number
  /** Road the user will be on after the upcoming maneuver. "" if unknown. */
  towardRoad: string
  /** Categorical type of the maneuver after the next one. "" if unknown. */
  nextManeuverType: string
  /** UI label for the next maneuver, e.g. "Then". "" if no next maneuver. */
  nextManeuverLabel: string
}

export type NavErrorPayload = {
  message: string
}

export type CrustViewProps = {
  url: string
  onLoad: (event: {nativeEvent: OnLoadEventPayload}) => void
  style?: StyleProp<ViewStyle>
}
