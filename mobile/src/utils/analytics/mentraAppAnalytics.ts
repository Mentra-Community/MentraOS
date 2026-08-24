import * as Application from "expo-application"
import {Platform} from "react-native"

export const MENTRA_APP_ACTIVE_EVENT = "mentra_app_active"

interface PostHogCaptureClient {
  capture(event: string, properties?: Record<string, unknown>): void
}

/**
 * Emit an account-scoped activity event after PostHog identify() has run.
 *
 * The Mentra App deliberately disables the embedded Bluetooth SDK's anonymous
 * analytics. This event gives MAU/WAU queries a dedicated first-party signal
 * whose distinct id is the authenticated Cloud V2 account.
 */
export function captureMentraAppActive(posthog: PostHogCaptureClient): void {
  posthog.capture(MENTRA_APP_ACTIVE_EVENT, {
    app_identifier: Application.applicationId ?? "unknown",
    event_source: "mentra_app",
    os_platform: Platform.OS,
  })
}
