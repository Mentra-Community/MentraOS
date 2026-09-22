import type {NativeNotificationConfig} from "@mentra/bluetooth-sdk"

export interface NotificationPolicyInput {
  supported: boolean
  selected: boolean
  presentationActive: boolean
  sourceEnabled: boolean
  autoDisplay: boolean
  durationSeconds: number
  doNotDisturb: boolean
  blockedApps: string[]
}

export function nativeNotificationConfig(input: NotificationPolicyInput): NativeNotificationConfig {
  return {
    enabled: input.supported && input.selected && input.presentationActive && input.sourceEnabled,
    autoDisplay: input.autoDisplay,
    durationSeconds: Number.isFinite(input.durationSeconds)
      ? Math.min(30, Math.max(1, Math.round(input.durationSeconds)))
      : 5,
    doNotDisturb: input.doNotDisturb,
    blockedApps: input.blockedApps,
  }
}
