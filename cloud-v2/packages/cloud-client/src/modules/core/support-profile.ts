import type {HttpClient} from "../../http"

export type SupportConnectionState = "disconnected" | "scanning" | "connecting" | "bonding" | "connected"

export interface SupportStateInput {
  observedAt: string
  host: {
    appVersion?: string
    appBuild?: string
    engineVersion?: string
    bluetoothSdkVersion?: string
    phonePlatform: "ios" | "android" | "unknown"
    phoneModel?: string
    phoneOsVersion?: string
    connectionState: SupportConnectionState
    failureCode?: string
    failureStage?: string
  }
  device?: {
    /** Sent over TLS for server-side HMAC derivation, then immediately discarded. */
    hardwareId?: string
    model?: string
    androidVersion?: string
    firmwareVersion?: string
    mtkFirmwareVersion?: string
    besFirmwareVersion?: string
    appVersion?: string
    buildNumber?: string
  }
}

export interface SupportProfileUpdateResult {
  status: "accepted" | "deduplicated" | "stale"
  observedAt: string
}

export class SupportProfiles {
  constructor(private readonly http: HttpClient) {}

  update(input: SupportStateInput): Promise<SupportProfileUpdateResult> {
    return this.http.put<SupportProfileUpdateResult>("/api/client/support-profile", input, {
      idempotent: true,
    })
  }
}
