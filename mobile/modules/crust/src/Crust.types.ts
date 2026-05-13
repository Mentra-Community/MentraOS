import type {StyleProp, ViewStyle} from "react-native"

export type OnLoadEventPayload = {
  url: string
}

export type CrustModuleEvents = {
  onChange: (params: ChangeEventPayload) => void
  phone_notification: (event: PhoneNotificationEvent) => void
  phone_notification_dismissed: (event: PhoneNotificationDismissedEvent) => void
  captions_tester_incident: (event: CaptionsTesterIncidentEvent) => void
}

export type ChangeEventPayload = {
  value: string
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
  priority: string
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
