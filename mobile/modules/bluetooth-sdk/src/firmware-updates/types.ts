/** Native device identity and connection generation must come from getFirmwareUpdateSnapshot. */
export interface NativeFirmwareStartRequest {
  deviceId: string
  connectionGeneration: number
  offerId: string
  kind: string
  artifact?: {
    path: string
    targetVersion: string
    size?: number
    sha256?: string
    md5?: string
  }
  manifestUrl?: string
  /** Device-defined identity/preflight fields; the generic service never interprets these. */
  metadata: Record<string, string>
}

/** Subscribe to firmware_update before requesting a snapshot; ignore older revisions for the same updaterId. */
export interface NativeFirmwareUpdateSnapshot {
  schemaVersion: 1
  updaterId: string
  integrationId: string
  deviceId: string
  connectionGeneration: number
  revision: number
  sessionId?: string
  offerId?: string
  phase: string
  safeToRelease: boolean
  canCancel: boolean
  canReconcile: boolean
  progress?: number
  observedFirmware?: string
  targetFirmware?: string
  inventory: Record<string, string>
  error?: string
}
