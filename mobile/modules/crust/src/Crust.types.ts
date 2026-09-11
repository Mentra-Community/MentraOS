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
  /**
   * Ordered step list along the route, when supplied by the host. Each
   * step is one navigable segment — typically one straight stretch of
   * road ending in a maneuver. Optional for back-compat with older
   * hosts that only ship the polyline. The SDK's pivot module consumes
   * this to enrich pivots with `fromRoad` / `toRoad` metadata.
   */
  steps?: NavRouteStepPayload[]
}

export type NavRouteStepPayload = {
  /** Coordinate where this step begins (== end of the previous step). */
  lat: number
  lng: number
  /**
   * Index into `NavRoutePayload.points[]` where this step starts.
   * Lets consumers correlate step boundaries with polyline geometry.
   */
  routeIndex: number
  /** Name of the road traversed during this step. Null when the engine has no name. */
  road?: string | null
  /**
   * Categorical maneuver performed at the END of this step (i.e. how
   * the user exits this step). Same vocabulary as `NavManeuverPayload.maneuverType`.
   */
  maneuver: string
  /** Length of this step in meters. */
  distanceMeters: number
}

export type NavLocationPayload = {
  lat: number
  lng: number
  /** Horizontal accuracy in meters, if reported by the platform. */
  accuracy: number | null
  /** Unix ms timestamp of the fix. */
  timestamp: number
  phone_notification: (event: PhoneNotificationEvent) => void
  phone_notification_dismissed: (event: PhoneNotificationDismissedEvent) => void
  captions_tester_incident: (event: CaptionsTesterIncidentEvent) => void
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
  /**
   * Legacy "next road" field — historically populated from the same
   * source as `fromRoad` (the current step's road, NOT the road
   * after the upcoming turn). Kept for back-compat. New consumers
   * should read `nextStepRoad` instead.
   */
  toRoad?: string | null
  /**
   * Road the user will be on AFTER the upcoming maneuver, sourced
   * from the Nav SDK's `remainingSteps[0]`. This is the value to
   * show as the "next street" headline on the maneuver card. Null
   * when the SDK hasn't surfaced a remaining step yet (final leg,
   * pre-first-NavInfo, etc.).
   */
  nextStepRoad?: string | null
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

export type InstalledApp = {
  packageName: string
  appName: string
  isBlocked: boolean
  icon: string | null
}

export type PhoneNotificationEvent = {
  notificationId: string
  app: string
  title: string
  content: string
  /**
   * Android notification priority: PRIORITY_MIN (-2) through PRIORITY_MAX (2).
   * Derived from the channel importance when the ranking is available, since
   * Notification.priority reads 0 for channel-based notifications.
   */
  priority: number
  timestamp: number
  packageName: string
}

export type PhoneNotificationDismissedEvent = {
  notificationKey: string
  packageName: string
  notificationId: string
}

export type CaptionsTesterIncidentEvent = {
  action?: string
  timestamp?: number
  failure_code?: string
  failure_message?: string
  test_run_id?: string
  scenario_name?: string
  source?: string
  [key: string]: unknown
}

export type CrustViewProps = {
  url: string
  onLoad: (event: {nativeEvent: OnLoadEventPayload}) => void
  style?: StyleProp<ViewStyle>
}
