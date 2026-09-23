/** Device-independent update contracts. Providers retain their protocol and recovery policy. */
export type FirmwareEntryPoint = "pairing" | "settings" | "background" | "recovery"

export interface FirmwareTarget {
  readonly integrationId: string
  /** Native-authoritative identity; never a Bluetooth display name or model substring. */
  readonly deviceId: string
  readonly displayName: string
}

export type FirmwareAction = "check" | "install" | "retry" | "finish" | "discard" | "wifi" | "cancel"
export type FirmwarePhase =
  | "idle"
  | "checking"
  | "available"
  | "blocked"
  | "preparing"
  | "downloading"
  | "installing"
  | "synchronizing"
  | "restarting"
  | "verifying"
  | "complete"
  | "failed"
  | "interrupted"
  | "unavailable"

export interface FirmwareCopy {
  readonly text: string
  readonly key?: string
  readonly values?: Readonly<Record<string, string>>
}

export interface FirmwarePresentation {
  readonly title: FirmwareCopy
  readonly message?: FirmwareCopy
  readonly progress?: number | null
  readonly progressLabel?: FirmwareCopy
  readonly busy: boolean
  readonly success: boolean
  readonly actions: readonly {
    readonly id: FirmwareAction
    readonly label: FirmwareCopy
    readonly disabled?: boolean
    readonly secondary?: boolean
  }[]
  readonly releaseNotes?: readonly {readonly version: string; readonly markdown: string}[]
}

export interface FirmwareOffer {
  readonly id: string
  readonly required: boolean
  readonly observedVersion: string | null
  readonly targetVersion: string | null
}

export interface FirmwareSnapshot {
  readonly target: FirmwareTarget
  /** One user-visible flow can contain multiple native transactions. */
  readonly flowId: string
  readonly attemptId: string | null
  readonly nativeSessionId: string | null
  readonly revision: number
  readonly phase: FirmwarePhase
  /** Remains true through an approved Live chain's intervening checks. */
  readonly active: boolean
  /** Only provider-authoritative safety permits disconnect/reset/replacement. */
  readonly safeToRelease: boolean
  readonly offer: FirmwareOffer | null
  readonly error: {readonly code: string; readonly message: string; readonly deviceCode?: string | null} | null
  readonly presentation: FirmwarePresentation
}

export interface FirmwareOpenOptions {
  readonly entryPoint: FirmwareEntryPoint
  readonly initializeRuntime?: boolean
  /** Explicit compatibility entry for callers of the existing Live progress page. */
  readonly legacyProgressEntry?: boolean
}

export interface FirmwareActionRequest {
  readonly action: FirmwareAction
  /** Install is bound to the offer the user actually approved. */
  readonly offerId?: string
}

export type FirmwareActionResult = {kind: "none"} | {kind: "finished"} | {kind: "wifi-required"}

export interface FirmwareProvider {
  readonly target: FirmwareTarget
  snapshot(): FirmwareSnapshot
  /** Atomically registers and delivers the current snapshot, then ordered revisions. */
  subscribe(listener: (snapshot: FirmwareSnapshot) => void): () => void
  /** Idempotently opens/adopts this target's flow; subscription alone never starts it. */
  open(options: FirmwareOpenOptions): Promise<void>
  perform(request: FirmwareActionRequest): Promise<FirmwareActionResult>
  /** Stops observation only when no device work needs this provider. */
  dispose(): void
}

export class FirmwareUpdateError extends Error {
  constructor(
    public readonly code: "unsupported" | "busy" | "stale_offer" | "action_unavailable" | "invalid_provider",
    message: string,
  ) {
    super(message)
    this.name = "FirmwareUpdateError"
  }
}
